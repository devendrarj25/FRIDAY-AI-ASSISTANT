/**
 * Integrity contracts for one route-tree writer, a meaningful fast test run,
 * report-only CSP, IPC bounds, the shared turn, and the local speech device.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { localAvailability, localRowReachable } from "../../src/lib/friday/brain/model-registry";
import { installedSeed } from "../../src/lib/friday/models-engine";
import { sharedTurnPlan } from "../../src/lib/friday/model-routing-contract";
import { classifyVoiceFault } from "../../src/lib/friday/voice-heal";
import { spokenRouteError } from "../../src/lib/friday/voice-session";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("one route-tree writer", () => {
  it("keeps the Start footer in the desktop generator and the committed file", () => {
    const footer = require_("../../scripts/route-tree-footer.cjs") as {
      ROUTE_TREE_START_FOOTER: string;
    };
    const tree = read("src/routeTree.gen.ts").replace(/\r\n/g, "\n").trimEnd();
    const config = read("vite.electron.config.ts");
    expect(config).toContain("routeTreeFileFooter");
    expect(config).toContain("ROUTE_TREE_START_FOOTER");
    expect(tree.endsWith(footer.ROUTE_TREE_START_FOOTER)).toBe(true);
    expect(footer.ROUTE_TREE_START_FOOTER).toContain("declare module '@tanstack/react-start'");
  });
});

describe("fast tests on a clean tree", () => {
  it("compares with origin/main and falls back to a core subset", () => {
    const script = read("scripts/test-fast.cjs");
    expect(script).toContain("origin/main");
    expect(script).toContain("No test files found");
    expect(script).toContain("core/__tests__/electron-security.test.ts");
    expect(script).toContain("core/__tests__/project-independence.test.ts");
    expect(read("package.json")).toContain('"test": "vitest run --testTimeout=60000"');
  });
});

describe("report-only content security policy", () => {
  it("blocks remote scripts in the policy and does not enforce by default", () => {
    const csp = require_("../../electron/csp.cjs") as {
      reportOnlyHeader: () => string;
      headerName: () => string;
      noteViolation: (row: { directive: string; blocked: string }) => { directive: string };
      doctorCheck: () => { status: string; detail: string };
    };
    const previous = process.env["FRIDAY_CSP_ENFORCE"];
    delete process.env["FRIDAY_CSP_ENFORCE"];
    const policy = csp.reportOnlyHeader();
    expect(csp.headerName()).toBe("Content-Security-Policy-Report-Only");
    expect(policy).toContain("script-src 'self' friday:");
    expect(policy).not.toMatch(/script-src[^;]*https:/);
    expect(policy).toContain("blob:");
    expect(policy).toContain("http://127.0.0.1:*");
    expect(read("electron/renderer.cjs")).toContain("csp.headerName()");
    expect(read("electron/renderer.cjs")).toContain("csp.reportOnlyHeader()");
    csp.noteViolation({ directive: "script-src", blocked: "https://evil.example/a.js" });
    const row = csp.doctorCheck();
    expect(row.status).toBe("Warning");
    expect(row.detail).toContain("script-src");
    if (previous === undefined) delete process.env["FRIDAY_CSP_ENFORCE"];
    else process.env["FRIDAY_CSP_ENFORCE"] = previous;
  });
});

describe("ipc timeout and watchdog", () => {
  it("rejects a stalled invoke and leaves long work alone", async () => {
    const ipc = require_("../../electron/ipc-timeout.cjs") as {
      timeoutMs: (channel: string) => number;
      withIpcTimeout: (channel: string, work: Promise<unknown>, ms?: number) => Promise<unknown>;
    };
    expect(ipc.timeoutMs("doctor:run")).toBe(0);
    expect(ipc.timeoutMs("window:state")).toBeGreaterThan(0);
    await expect(
      ipc.withIpcTimeout("window:state", new Promise(() => {}), 30),
    ).rejects.toMatchObject({
      code: "IPC_BUDGET",
      message: expect.stringMatching(/ipc budget expired: quick \(window:state\)/),
    });
  });

  it("records a kernel stall for the lifecycle owner", () => {
    const watchdog = require_("../../electron/watchdog.cjs") as {
      note: (row: { kind: string; detail: string }) => { kind: string };
      planRecovery: (row: { kind: string }) => { owner: string; action: string };
      doctorCheck: () => { detail: string };
    };
    watchdog.note({ kind: "kernel", detail: "exit 1" });
    expect(watchdog.planRecovery({ kind: "kernel" })).toEqual({
      recover: true,
      owner: "lifecycle",
      action: "restart-kernel",
    });
    expect(watchdog.doctorCheck().detail).toContain("lifecycle");
    expect(read("electron/main.cjs")).toContain('watchdog.cjs").note');
  });
});

describe("one turn for chat and voice", () => {
  it("keeps tools, approval, and route the same, and always approves restart", () => {
    const tools = ["calendar", "memory", "files"];
    const chat = sharedTurnPlan({
      surface: "chat",
      tools,
      approval: false,
      routeMode: "auto",
      prompt: "what is on tomorrow",
    });
    const voice = sharedTurnPlan({
      surface: "voice",
      tools,
      approval: false,
      routeMode: "auto",
      prompt: "what is on tomorrow",
    });
    expect(voice.tools).toEqual(chat.tools);
    expect(voice.approval).toBe(chat.approval);
    expect(voice.routeMode).toBe(chat.routeMode);
    expect(voice.style).toBe("spoken");
    expect(chat.style).toBe("screen");
    expect(
      sharedTurnPlan({
        surface: "voice",
        tools,
        approval: false,
        routeMode: "auto",
        prompt: "restart the computer",
      }).approval,
    ).toBe(true);
  });

  it("reaches providers only through the brain send path", () => {
    const voice = read("src/lib/friday/assistant-mode.ts");
    const brain = read("src/lib/friday/brain-engine.ts");
    expect(voice).toContain("brain.send(");
    expect(brain).toContain("desktop.sendChat(");
    expect(voice).not.toContain("/chat/completions");
    expect(brain).not.toContain("/chat/completions");
  });
});

describe("voice health and speech faults", () => {
  it("pauses network probes in privacy mode and names a missing frame", () => {
    const health = require_("../../electron/voice-health.cjs") as {
      planVoiceHealth: (input: { privacy: boolean; ageMs: number; jitterMs: number }) => {
        run: boolean;
        network: boolean;
        local: boolean;
      };
    };
    const paused = health.planVoiceHealth({
      privacy: true,
      ageMs: Number.POSITIVE_INFINITY,
      jitterMs: 10,
    });
    expect(paused.run).toBe(true);
    expect(paused.local).toBe(true);
    expect(paused.network).toBe(false);
    const fresh = health.planVoiceHealth({ privacy: false, ageMs: 1000, jitterMs: 10 });
    expect(fresh.run).toBe(false);
    expect(classifyVoiceFault("no audio frames")).toBe("mic-no-frames");
    expect(classifyVoiceFault("system resume")).toBe("sleep-resume");
    expect(read("electron/main.cjs")).toContain('id: "voice-health"');
  });

  it("does not speak a raw transport error", () => {
    expect(spokenRouteError("fetch failed https://api.example/v1")).toBe(
      "Something went wrong. The details are on screen.",
    );
  });
});

describe("model health and installed rows", () => {
  it("skips a cloud probe in privacy mode and when the cache is fresh", () => {
    const router = require_("../../electron/model-router.cjs") as {
      planHealthProbe: (input: {
        privacy?: boolean;
        ageMs: number;
        ttlMs?: number;
        jitterMs?: number;
      }) => {
        run: boolean;
        spend: string;
      };
    };
    expect(router.planHealthProbe({ privacy: true, ageMs: 999999 }).run).toBe(false);
    expect(router.planHealthProbe({ ageMs: 1000, ttlMs: 10_000 }).run).toBe(false);
    const due = router.planHealthProbe({ ageMs: 99_000, ttlMs: 10_000, jitterMs: 20 });
    expect(due.run).toBe(true);
    expect(due.spend).toBe("zero");
  });

  it("does not mark a local catalog row installed before a scan", () => {
    const seed = installedSeed([
      { id: "local-a", kind: "local", installed: "1.0" },
      { id: "cloud-a", kind: "cloud", installed: "stored" },
    ]);
    expect(seed["local-a"]).toBeNull();
    expect(seed["cloud-a"]).toBe("stored");
    expect(
      localRowReachable({
        installed: null,
        imported: false,
        catalogInstalled: "3.1",
        desktop: true,
      }),
    ).toBe(false);
    expect(
      localRowReachable({
        installed: null,
        imported: false,
        catalogInstalled: "3.1",
        desktop: false,
      }),
    ).toBe(true);
    expect(
      localRowReachable({
        installed: "3.1",
        imported: false,
        catalogInstalled: null,
        desktop: true,
      }),
    ).toBe(true);
    expect(localAvailability({ installed: null, imported: false, reachable: true })).toBe(
      "browser preview",
    );
    expect(localAvailability({ installed: "3.1", imported: false, reachable: true })).toBe(
      "installed 3.1",
    );
  });

  it("tells the owner when a model id is gone and remaps a known replacement", () => {
    const federation = require_("../../electron/provider-federation.cjs") as {
      noteRemovedId: (
        category: string,
        id: string,
        table?: Record<string, string>,
      ) => { refresh: boolean; line: string; next: string };
    };
    const plain = federation.noteRemovedId("model_unavailable", "old-chat");
    expect(plain.refresh).toBe(true);
    expect(plain.line).toContain("Refreshing the catalogue");
    const mapped = federation.noteRemovedId("model_unavailable", "old-chat", {
      "old-chat": "new-chat",
    });
    expect(mapped.next).toBe("new-chat");
    expect(mapped.line).toContain("new-chat");
    expect(federation.noteRemovedId("timeout", "old-chat").refresh).toBe(false);
  });
});

describe("provider call reuse", () => {
  it("reuses one connection for two health reads", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    let sockets = 0;
    server.on("connection", () => {
      sockets += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}/health`;
    const { Agent } = require_("undici") as { Agent: new (opts: object) => object };
    const net = require_("../../electron/net-fetch.cjs") as {
      fetchCompat: (url: string, init?: { dispatcher?: object }) => Promise<Response>;
    };
    const dispatcher = new Agent({ connections: 1, keepAliveTimeout: 30_000, pipelining: 1 });
    const started = Date.now();
    const first = await net.fetchCompat(url, { dispatcher });
    const second = await net.fetchCompat(url, { dispatcher });
    const elapsed = Date.now() - started;
    expect(await first.text()).toBe("ok");
    expect(await second.text()).toBe("ok");
    expect(sockets).toBe(1);
    expect(elapsed).toBeLessThan(2000);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
