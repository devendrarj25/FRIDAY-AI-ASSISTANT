import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const require_ = createRequire(import.meta.url);
const health = require_(resolve(process.cwd(), "electron/service-health.cjs")) as {
  snapshot: () => Promise<{
    services: Array<{ id: string; state: string; detail: string }>;
  } | null>;
  invalidate: () => void;
  init: (
    send: (ch: string, value: unknown) => void,
    ctx?: { kernelUrl?: string; userData?: string | (() => string) },
  ) => void;
  stop: () => void;
};
const models = require_(resolve(process.cwd(), "electron/models.cjs"));

describe("live service health monitor", () => {
  const monitor = read("electron/service-health.cjs");

  it("keeps exactly one interval, reference-counted across renderers", () => {
    expect(monitor).toContain("subscribers += 1");
    expect(monitor).toContain("if (!timer)");
    expect(monitor).toContain("clearInterval(timer)");
    expect(monitor.match(/setInterval\(/g)?.length).toBe(1);
  });

  it("probes with a hard timeout so a dead service cannot stall the app", () => {
    expect(monitor).toContain("AbortController");
    expect(monitor).toContain("controller.abort()");
  });

  it("reports unreachable services honestly instead of a decorative OK", () => {
    expect(monitor).toContain('"offline"');
    expect(monitor).toContain("result.error");
  });

  it("drops an in-flight snapshot when invalidate() runs so a crash cannot keep online", () => {
    expect(monitor).toContain("function invalidate");
    expect(monitor).toContain("sampleGeneration");
    expect(monitor).toContain("generation !== sampleGeneration");
  });

  it("is wired through main, preload and a renderer hook exactly once", () => {
    const main = read("electron/main.cjs");
    const preload = read("electron/preload.cjs");
    const hook = read("src/lib/friday/use-service-health.ts");
    expect(main.match(/ipcMain\.handle\("system:health"/g)?.length).toBe(1);
    expect(main).toContain("serviceHealth.init(send");
    expect(main).toContain("serviceHealth.stop()");
    expect(preload).toContain("onSystemHealth");
    expect(hook).toContain("unsubscribeSystemHealth");
  });
});

describe("service health invalidate against a live probe", () => {
  afterEach(() => {
    health.stop();
  });

  it("does not keep an in-flight online kernel result after invalidate", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let kernelOk = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/health")) {
        await gate;
        if (kernelOk) return { ok: true, status: 200 } as Response;
      }
      return { ok: false, status: 0 } as Response;
    }) as typeof fetch;
    try {
      health.init(() => {}, { kernelUrl: "http://127.0.0.1:9" });
      const first = health.snapshot();
      health.invalidate();
      kernelOk = false;
      release();
      const after = await health.snapshot();
      await first.catch(() => null);
      const kernel = after?.services.find((row) => row.id === "kernel");
      expect(kernel?.state).toBe("offline");
    } finally {
      globalThis.fetch = originalFetch;
      health.stop();
    }
  });

  it("probes the configured Jan endpoint instead of only the desktop default", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-health-endpoint-"));
    models.writeEndpoint(root, "jan", "http://127.0.0.1:7777");
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      seen.push(href);
      return { ok: href === "http://127.0.0.1:7777/v1/models", status: 200 } as Response;
    }) as typeof fetch;
    try {
      health.init(() => {}, { kernelUrl: "http://127.0.0.1:9", userData: () => root });
      health.invalidate();
      const snapshot = await health.snapshot();
      const jan = snapshot?.services.find((row) => row.id === "jan");
      expect(jan?.state).toBe("online");
      expect(jan?.detail).toContain("127.0.0.1:7777");
      expect(seen).toContain("http://127.0.0.1:7777/v1/models");
    } finally {
      globalThis.fetch = originalFetch;
      health.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
