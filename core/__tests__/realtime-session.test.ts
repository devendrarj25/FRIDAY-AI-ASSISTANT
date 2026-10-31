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
