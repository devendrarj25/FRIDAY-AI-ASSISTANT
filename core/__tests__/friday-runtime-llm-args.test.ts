/**
 * FRIDAY Core's start: the command line, the free port, the per-launch key and the model choice, built from
 * `config/friday-core.json` with a fake disk and fake processes (no real runtime, no GPU, no network).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const llama = require_(path.join(root, "electron/llama-runtime.cjs"));
const core = require_(path.join(root, "electron/friday-core.cjs"));
const models = require_(path.join(root, "electron/models.cjs"));
const manifest = require_(path.join(root, "config/friday-core.json"));

const SERVER = process.platform === "win32" ? "friday-runtime-llm.exe" : "friday-runtime-llm";
// A fake per-launch key, built at run time so the secret scanner never sees a key-shaped literal.
const KEY = ["fk", "test", "key", String(1234567890)].join("-");
let dir: string;

/** A healthy server that answers /v1/models 401 without this launch's key and 200 with it (the check before ready). */
const keyedProbe =
  (seen: string[] = []) =>
  async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(url);
    if (url.endsWith("/health")) return { ok: true, status: 200 };
    return init?.headers?.["Authorization"] === `Bearer ${KEY}`
      ? { ok: true, status: 200 }
      : { ok: false, status: 401 };
  };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-core-args-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake disk: the named variants have every file at its pinned size. */
function disk(variants: string[], skip: string[] = []) {
  const have = new Map<string, number>();
  for (const id of variants) {
    for (const f of core.variantOf(manifest, id).files) {
      if (!skip.includes(f.kind)) have.set(core.diskPath(dir, f.disk), f.bytes);
    }
  }
  return (p: string) => (have.has(p) ? { size: have.get(p) } : undefined);
}

describe("coreArgs", () => {
  const base = { model: "/m/core.gguf", mmproj: "/m/proj.gguf", port: 41234, threads: 3 };

  it("holds the model, projector, loopback host, own port, context, one slot and the thread budget", () => {
    const args: string[] = llama.coreArgs(base);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args.slice(0, 4)).toEqual(["-m", "/m/core.gguf", "--mmproj", "/m/proj.gguf"]);
    expect(at("--host")).toBe("127.0.0.1");
    expect(at("--port")).toBe("41234");
    expect(at("-c")).toBe("8192");
    expect(at("-np")).toBe("1");
    expect(at("-t")).toBe("3");
    expect(at("-fa")).toBe("auto");
    expect(at("--cache-reuse")).toBe("256");
    expect(args).toContain("--jinja");
    expect(args).toContain("--no-webui");
  });

  it("never names a key or a slot-save folder on the command line", () => {
    const args: string[] = llama.coreArgs(base);
    expect(args.join(" ")).not.toMatch(/api-key|slot-save|--metrics/);
  });

  it("refuses the stock port 8080, a missing port and a missing model", () => {
    expect(() => llama.coreArgs({ ...base, port: 8080 })).toThrow(/port/);
    expect(() => llama.coreArgs({ ...base, port: 0 })).toThrow(/port/);
    expect(() => llama.coreArgs({ ...base, model: "" })).toThrow(/model/);
  });

  it("omits the projector when there is none", () => {
    const args: string[] = llama.coreArgs({ ...base, mmproj: "" });
    expect(args).not.toContain("--mmproj");
  });

  it("adds GPU flags only for a GPU build", () => {
    expect(llama.coreArgs({ ...base, gpu: false })).not.toContain("-ngl");
    const gpu: string[] = llama.coreArgs({ ...base, gpu: true });
    expect(gpu.slice(gpu.indexOf("-ngl"), gpu.indexOf("-ngl") + 2)).toEqual(["-ngl", "auto"]);
    expect(llama.isGpuBackend("cuda")).toBe(true);
    expect(llama.isGpuBackend("vulkan")).toBe(true);
    expect(llama.isGpuBackend("cpu")).toBe(false);
    expect(llama.isGpuBackend(undefined)).toBe(false);
  });
});

describe("the thread budget leaves cores for the ears", () => {
  it("gives the model fewer threads than the PC has cores", () => {
    expect(llama.threadBudget(4)).toBe(3);
    expect(llama.threadBudget(2)).toBe(1);
    expect(llama.threadBudget(1)).toBe(1);
    expect(llama.threadBudget(6)).toBe(4);
    expect(llama.threadBudget(8)).toBe(6);
    for (const n of [2, 3, 4, 6, 8, 12, 16, 64]) expect(llama.threadBudget(n)).toBeLessThan(n);
  });
  it("caps the count and tolerates an unknown core count", () => {
    expect(llama.threadBudget(64)).toBe(8);
    expect(llama.threadBudget(undefined)).toBe(3);
    expect(llama.threadBudget(0)).toBe(3);
  });
});

describe("the per-launch key and the free port", () => {
  it("is long, random and different every launch", () => {
    const a = llama.newLaunchKey();
    const b = llama.newLaunchKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^fk-[a-f0-9]{64}$/);
  });

  it("asks the system for a loopback port and never returns 8080", async () => {
    const port = await llama.freeLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(8080);
  });

  it("tries again when the system hands out 8080", async () => {
    const ports = [8080, 8080, 40001];
    const net = {
      createServer: () => {
        const server = new EventEmitter() as EventEmitter & Record<string, unknown>;
        const port = ports.shift();
        server["unref"] = () => undefined;
        server["listen"] = (_p: number, _h: string, cb: () => void) => cb();
        server["address"] = () => ({ port });
        server["close"] = (cb: () => void) => cb();
        return server;
      },
    };
    expect(await llama.freeLoopbackPort({ net })).toBe(40001);
  });
});

describe("which FRIDAY Core model starts", () => {
  it("is the default one with its projector when both are on disk", () => {
    const plan = llama.corePlan(dir, { stat: disk(["e4b", "e2b"]) });
    expect(plan).toMatchObject({ ok: true, variant: "e4b", ctx: 8192 });
    expect(plan.model).toBe(core.diskPath(dir, "friday-core-e4b.gguf"));
    expect(plan.mmproj).toBe(core.diskPath(dir, "friday-core-e4b-mmproj.gguf"));
  });
  it("falls to the lite one when the default is not installed", () => {
    expect(llama.corePlan(dir, { stat: disk(["e2b"]) })).toMatchObject({
      ok: true,
      variant: "e2b",
    });
  });
  it("starts a model without its projector as text only", () => {
    const plan = llama.corePlan(dir, { stat: disk(["e4b"], ["mmproj"]) });
    expect(plan).toMatchObject({ ok: true, variant: "e4b", mmproj: null });
  });
  it("refuses a file of the wrong size and never starts the embedder as a brain", () => {
    const wrong = () => ({ size: 1 });
    expect(llama.corePlan(dir, { stat: wrong }).ok).toBe(false);
    expect(llama.corePlan(dir, { stat: disk(["recall"]) }).ok).toBe(false);
  });
});

describe("coreLaunch", () => {
  const launch = (over: Record<string, unknown> = {}) =>
    llama.coreLaunch(dir, {
      stat: disk(["e4b"]),
      bin: path.join(dir, SERVER),
      port: 40555,
      key: KEY,
      cpus: 4,
      backend: "cpu",
      env: {
        PATH: "/bin",
        LLAMA_ARG_PORT: "8080",
        LLAMA_API_KEY: "old",
        LLAMA_ARG_HOST: "0.0.0.0",
      },
      ...over,
    });

  it("builds the whole start from the manifest", async () => {
    const out = await launch();
    expect(out).toMatchObject({
      ok: true,
      port: 40555,
      key: KEY,
      baseUrl: "http://127.0.0.1:40555/v1",
      variant: "e4b",
      vision: true,
      gpu: false,
    });
    expect(out.args[out.args.indexOf("-t") + 1]).toBe("3");
    expect(out.args).toContain("--mmproj");
  });

  it("passes the key by environment only, and drops inherited llama.cpp settings", async () => {
    const out = await launch();
    expect(out.env.LLAMA_API_KEY).toBe(KEY);
    expect(out.env.PATH).toBe("/bin");
    expect(Object.keys(out.env).filter((k) => k.startsWith("LLAMA_ARG_"))).toEqual([]);
    expect(out.args.join(" ")).not.toContain(KEY);
  });

  it("writes nothing to disk, so the key is never in a file under the FRIDAY root", async () => {
    await launch();
    expect(readdirSync(dir)).toEqual([]);
    const out = await llama.coreLaunch(dir, { stat: disk(["e4b"]), bin: "x" });
    expect(out.ok).toBe(true);
    expect(out.port).not.toBe(8080);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("uses GPU flags only when the installed build is a GPU build", async () => {
    expect((await launch({ backend: "cpu" })).args).not.toContain("-ngl");
    expect((await launch({ backend: undefined })).args).not.toContain("-ngl");
    expect((await launch({ backend: "cuda" })).args).toContain("-ngl");
    expect((await launch({ backend: "vulkan" })).gpu).toBe(true);
  });

  it("says why when there is no model or no runtime", async () => {
    expect(await llama.coreLaunch(dir, { stat: () => undefined, bin: "x" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no FRIDAY Core model/),
    });
    expect(await launch({ bin: null })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not installed/),
    });
  });

  it("finds the runtime under either of its names", () => {
    const engine = path.join(llama.engineDir(dir), "b12230");
    mkdirSync(engine, { recursive: true });
    writeFileSync(
      path.join(engine, process.platform === "win32" ? "llama-server.exe" : "llama-server"),
      "x",
    );
    expect(path.basename(llama.findServer(dir))).toMatch(/^llama-server/);
    writeFileSync(path.join(engine, SERVER), "x");
    expect(path.basename(llama.findServer(dir))).toBe(SERVER);
  });
});

describe("the generic GGUF rule tolerates a projector and FRIDAY Core files", () => {
  it("counts one chat model next to an mmproj and the Core files as one", () => {
    const files = [
      { path: "/m/qwen3-4b/Qwen3-4B-Q4_K_M.gguf", format: "gguf" },
      { path: "/m/qwen3-4b/mmproj-Qwen3-4B-f16.gguf", format: "gguf" },
      { path: "/m/friday-core/friday-core-e4b.gguf", format: "gguf" },
      { path: "/m/friday-core/friday-core-e4b-mmproj.gguf", format: "gguf" },
      { path: "/m/friday-core/friday-core-recall.gguf", format: "gguf" },
    ];
    const resolved = models.resolveEngineStart("llamacpp", files);
    expect(resolved.start?.[1].slice(0, 2)).toEqual(["-m", "/m/qwen3-4b/Qwen3-4B-Q4_K_M.gguf"]);
  });
  it("still refuses to guess between two real chat models", () => {
    const resolved = models.resolveEngineStart("llamacpp", [
      { path: "/m/a.gguf", format: "gguf" },
      { path: "/m/b.gguf", format: "gguf" },
      { path: "/m/mmproj-a.gguf", format: "gguf" },
    ]);
    expect(resolved.start).toBeNull();
    expect(resolved.hint).toMatch(/2 are present/);
  });
});

describe("startCore and stopCore", () => {
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child["pid"] = 4242;
    child["kill"] = () => {
      child.emit("exit", 0);
    };
    return child;
  }
  const launch = {
    ok: true,
    bin: "x",
    args: ["-m", "m"],
    env: { LLAMA_API_KEY: KEY },
    port: 40777,
    key: KEY,
    baseUrl: "http://127.0.0.1:40777/v1",
    variant: "e4b",
    fridayName: "FRIDAY Core",
    vision: true,
  };

  it("starts once /health answers, hands out the endpoint and key, and stops again", async () => {
    const seen: unknown[] = [];
    const off = models.onCoreChange((e: unknown) => seen.push(e));
    const calls: unknown[][] = [];
    const urls: string[] = [];
    const out = await models.startCore({
      launch,
      spawn: (...a: unknown[]) => (calls.push(a), fakeChild()),
      probe: keyedProbe(urls),
      stepMs: 1,
    });
    expect(out.ok).toBe(true);
    expect(urls).toEqual([
      "http://127.0.0.1:40777/health",
      "http://127.0.0.1:40777/v1/models",
      "http://127.0.0.1:40777/v1/models",
    ]);
    expect(models.coreEndpoint()).toMatchObject({
      baseUrl: launch.baseUrl,
      apiKey: KEY,
      model: "friday-core",
    });
    const [, args, opts] = calls[0] as [
      string,
      string[],
      { env: Record<string, string>; detached?: boolean },
    ];
    expect(args.join(" ")).not.toContain(KEY);
    expect(opts.env["LLAMA_API_KEY"]).toBe(KEY);
    expect(opts.detached).toBeFalsy();
    expect(await models.startCore({ launch })).toMatchObject({
      ok: true,
      detail: "already running",
    });
    expect(await models.stopCore()).toBe(true);
    expect(models.coreEndpoint()).toBeNull();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeNull();
    off();
  });

  it("reports a runtime that exits while loading, and keeps no endpoint", async () => {
    const out = await models.startCore({
      launch,
      spawn: () => {
        const child = fakeChild();
        setTimeout(() => child.emit("exit", 3), 2);
        return child;
      },
      probe: async () => ({ ok: false }),
      stepMs: 5,
    });
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/stopped while loading/) });
    expect(models.coreEndpoint()).toBeNull();
  });

  it("gives up when the server never becomes healthy", async () => {
    const child = fakeChild();
    const out = await models.startCore({
      launch,
      spawn: () => child,
      probe: async () => ({ ok: false }),
      timeoutMs: 20,
      stepMs: 5,
    });
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/never became healthy/) });
    expect(models.coreEndpoint()).toBeNull();
  });
});

describe("Core is pushed to the kernel router", () => {
  const launch = {
    ok: true,
    bin: "x",
    args: ["-m", "m"],
    env: { LLAMA_API_KEY: KEY },
    port: 40888,
    key: KEY,
    baseUrl: "http://127.0.0.1:40888/v1",
    variant: "e4b",
    fridayName: "FRIDAY Core",
    vision: true,
    capabilities: { chat: true, vision: true, audio: true, tools: true },
  };
  const child = () => {
    const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
    c["pid"] = 1;
    c["kill"] = () => c.emit("exit", 0);
    return c;
  };

  it("start pushes the endpoint and key once, stop clears it, nothing is logged or written", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const unbind = models.bindCoreKernel(
      async (method: string, params: Record<string, unknown>) => {
        calls.push([method, params]);
        return {};
      },
    );
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((k) => {
      const orig = console[k];
      console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
      return () => (console[k] = orig);
    });
    try {
      await models.startCore({
        launch,
        spawn: () => child(),
        probe: keyedProbe(),
        stepMs: 1,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe("model.add");
      expect(calls[0]?.[1]).toEqual({
        id: "friday-core",
        label: "FRIDAY Core",
        provider: "llamacpp",
        role: "brain",
        endpoint: "http://127.0.0.1:40888/v1",
        apiKey: KEY,
        type: "local",
        status: "ready",
        capabilities: { chat: true, vision: true, audio: true, tools: true },
      });
      await models.stopCore();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.[1]).toMatchObject({
        id: "friday-core",
        endpoint: "",
        apiKey: "",
        status: "unavailable",
      });
      expect(JSON.stringify(calls[1])).not.toContain(KEY);
    } finally {
      spies.forEach((restore) => restore());
      unbind();
    }
    expect(logged.join("\n")).not.toContain(KEY);
    expect(models.coreKernelRow()).toMatchObject({ endpoint: "", apiKey: "" });
  });

  it("a kernel that refuses the push never breaks the start", async () => {
    const unbind = models.bindCoreKernel(async () => {
      throw new Error("kernel down");
    });
    try {
      const out = await models.startCore({
        launch,
        spawn: () => child(),
        probe: keyedProbe(),
        stepMs: 1,
      });
      expect(out.ok).toBe(true);
      await models.stopCore();
    } finally {
      unbind();
    }
  });
});

describe("coreCapabilities", () => {
  it("claims vision and audio only with the projector loaded", () => {
    const caps = ["text", "image", "video-frames", "audio-30s", "tools"];
    expect(llama.coreCapabilities({ caps, mmproj: "/p" })).toEqual({
      chat: true,
      vision: true,
      audio: true,
      tools: true,
    });
    expect(llama.coreCapabilities({ caps, mmproj: null })).toMatchObject({
      vision: false,
      audio: false,
    });
  });
});

describe("the source keeps the key off disk and off argv", () => {
  it("never writes a key file or uses --api-key in the launch code", () => {
    const text = readFileSync(path.join(root, "electron/llama-runtime.cjs"), "utf8");
    expect(text).not.toMatch(/writeFile|api-key-file|"--api-key"|slot-save-path"/);
  });
});
