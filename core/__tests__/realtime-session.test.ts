import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeWs, type FakeWs } from "./helpers/ws-fake-server";

const require_ = createRequire(import.meta.url);
const { createRealtimeSessions } = require_(
  path.resolve(import.meta.dirname, "../../electron/realtime-session.cjs"),
);

let server: FakeWs | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe("realtime session pipe (this PC only)", () => {
  it("round-trips JSON events with a loopback engine", async () => {
    server = await startFakeWs((send) => send(JSON.stringify({ type: "session.created" })));
    const sessions = createRealtimeSessions();
    const events: unknown[] = [];
    let opened = false;
    expect(
      sessions.start("s1", server.url, {
        onOpen: () => (opened = true),
        onEvent: (e: unknown) => events.push(e),
      }),
    ).toEqual({ ok: true });
    await until(() => events.length > 0);
    expect(opened).toBe(true);
    expect(events).toEqual([{ type: "session.created" }]);
    expect(sessions.send("s1", { type: "response.create" })).toEqual({ ok: true });
    await server.waitFor(1);
    expect(JSON.parse(server.received[0]!)).toEqual({ type: "response.create" });
    expect(sessions.close("s1")).toEqual({ ok: true });
    expect(sessions.count()).toBe(0);
  });

  it("refuses an address that is not on this PC, and a second session", async () => {
    const sessions = createRealtimeSessions();
    for (const url of [
      "wss://api.example.com/v1/realtime",
      "ws://10.0.0.5:8123/x",
      "ws://127.0.0.1.evil.com/x",
      "",
    ]) {
      expect(sessions.start("s", url, {}).ok).toBe(false);
    }
    server = await startFakeWs();
    expect(sessions.start("a", server.url, {}).ok).toBe(true);
    expect(sessions.start("b", server.url, {})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already open/),
    });
    sessions.close("a");
  });

  it("ignores a frame that is not JSON and refuses to send on a session that is not open", async () => {
    server = await startFakeWs((send) => {
      send("not json");
      send(JSON.stringify({ type: "ok" }));
    });
    const sessions = createRealtimeSessions();
    const events: unknown[] = [];
    sessions.start("s", server.url, { onEvent: (e: unknown) => events.push(e) });
    await until(() => events.length > 0);
    expect(events).toEqual([{ type: "ok" }]);
    expect(sessions.send("nope", { type: "x" })).toMatchObject({ ok: false });
    sessions.close("s");
  });

  it("says so when the runtime has no WebSocket client", () => {
    const sessions = createRealtimeSessions({ WebSocketImpl: null });
    expect(sessions.start("s", "ws://127.0.0.1:1/x", {})).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no WebSocket/),
    });
  });
});

describe("cloud realtime connection (provider table, key stays in the main process)", () => {
  const handlers = {};

  it("sends the key as an Authorization header to the fixed provider address, checked on a real socket", async () => {
    const http = await import("node:http");
    const crypto = await import("node:crypto");
    const seen: { auth: string | undefined; beta: string; path: string | undefined }[] = [];
    const srv = http.createServer();
    srv.on("upgrade", (req, sock) => {
      seen.push({
        auth: req.headers.authorization,
        beta: String(req.headers["openai-beta"] ?? ""),
        path: req.url,
      });
      const accept = crypto
        .createHash("sha1")
        .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      sock.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    const requested: string[] = [];
    // Only the address is redirected to this PC; the headers and the protocol are the real client's.
    class Redirect extends WebSocket {
      constructor(url: string, options?: unknown) {
        requested.push(url);
        super(
          `ws://127.0.0.1:${port}${new URL(url).pathname}${new URL(url).search}`,
          options as never,
        );
      }
    }
    const sessions = createRealtimeSessions({ WebSocketImpl: Redirect });
    let opened = false;
    const out = sessions.startCloud("c1", "openai", "my-model", "sk-test-KEY", {
      onOpen: () => (opened = true),
    });
    expect(out).toMatchObject({ ok: true, provider: "openai", host: "api.openai.com" });
    await until(() => opened);
    sessions.close("c1");
    srv.close();
    expect(requested).toEqual(["wss://api.openai.com/v1/realtime?model=my-model"]);
    expect(seen[0]?.auth).toBe("Bearer sk-test-KEY");
    expect(seen[0]?.path).toBe("/v1/realtime?model=my-model");
  });

  it("refuses an unknown provider, an unnamed model, a missing key and a second session", () => {
    const made: unknown[] = [];
    class Fake {
      constructor(...args: unknown[]) {
        made.push(args);
      }
      addEventListener() {}
      close() {}
    }
    const sessions = createRealtimeSessions({ WebSocketImpl: Fake });
    expect(sessions.startCloud("a", "evil", "m", "k", handlers).ok).toBe(false);
    expect(sessions.startCloud("a", "__proto__", "m", "k", handlers).ok).toBe(false);
    expect(sessions.startCloud("a", "openai", "", "k", handlers).ok).toBe(false);
    expect(sessions.startCloud("a", "openai", "m/../x", "k", handlers).ok).toBe(false);
    expect(sessions.startCloud("a", "openai", "m", "", handlers).ok).toBe(false);
    expect(made).toEqual([]);
    expect(sessions.startCloud("a", "openai", "m", "k", handlers).ok).toBe(true);
    expect(sessions.startCloud("b", "openai", "m", "k", handlers)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already open/),
    });
  });

  it("scrubs the key from a connection error", () => {
    class Boom {
      constructor() {
        throw new Error("bad header Bearer sk-secret-123");
      }
    }
    const out = createRealtimeSessions({ WebSocketImpl: Boom as never }).startCloud(
      "a",
      "openai",
      "m",
      "sk-secret-123",
      handlers,
    );
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("sk-secret-123");
  });

  it("keeps the loopback-only rule for the plain start", () => {
    const sessions = createRealtimeSessions();
    expect(sessions.start("s", "wss://api.openai.com/v1/realtime", {}).ok).toBe(false);
  });

  it("the main process re-checks consent, privacy and paid access and reads the key itself", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(path.resolve(import.meta.dirname, "../../electron/main.cjs"), "utf8");
    const at = main.indexOf('ipcMain.handle("realtime:open-cloud"');
    const body = main.slice(at, main.indexOf('ipcMain.handle("realtime:send"', at));
    expect(body).toContain("consent !== true");
    expect(body).toContain("voicePrivacyOn()");
    expect(body).toContain("paidUnlocked");
    expect(body).toContain("modelsApi.readKeys");
    const preload = readFileSync(
      path.resolve(import.meta.dirname, "../../electron/preload.cjs"),
      "utf8",
    );
    const at2 = preload.indexOf("realtimeOpenCloud");
    const bridge = preload.slice(at2, preload.indexOf("realtimeSend", at2));
    expect(bridge).toContain("realtime:open-cloud");
    expect(bridge).not.toMatch(/key/i);
  });
});
