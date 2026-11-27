/**
 * FRIDAY Core hardening in the main process: the renderer can never write the Core row, a stop during a slow load
 * kills the pending runtime, the owner's setting is re-read after the load, the child is tracked by the one lifecycle
 * owner, the loopback port must answer to this launch's key (and only to it) before Core is ready, and a joined
 * release file is opened exclusively so a planted link is never followed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const models = require_(path.join(root, "electron/models.cjs"));
const lifecycle = require_(path.join(root, "electron/app-lifecycle.cjs"));
const download = require_(path.join(root, "electron/model-download.cjs"));
const mainSource = readFileSync(path.join(root, "electron/main.cjs"), "utf8");

// A fake per-launch key, built at run time so the secret scanner never sees a key-shaped literal.
const KEY = ["fk", "hardening", "key", String(987654321)].join("-");

type Probe = (url: string, init?: { headers?: Record<string, string> }) => Promise<unknown>;

const launch = {
  ok: true,
  bin: "x",
  args: ["-m", "m"],
  env: { LLAMA_API_KEY: KEY },
  port: 40999,
  key: KEY,
  baseUrl: "http://127.0.0.1:40999/v1",
  variant: "e4b",
  fridayName: "FRIDAY Core",
  vision: true,
};

function child(onKill: () => void = () => undefined, exitOnKill = true) {
  const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
  // No pid on purpose: with a pid, a Windows stop goes to taskkill (a real process tree kill) and never reaches this fake's kill.
  c["kill"] = () => {
    onKill();
    if (exitOnKill) c.emit("exit", 0);
    return true;
  };
  return c;
}

/** A llama.cpp server that is healthy, and answers /v1/models 401 without this launch's key and 200 with it. */
const keyedServer: Probe = async (url, init) => {
  if (url.endsWith("/health")) return { ok: true, status: 200 };
  if (url.endsWith("/v1/models"))
    return init?.headers?.["Authorization"] === `Bearer ${KEY}`
      ? { ok: true, status: 200 }
      : { ok: false, status: 401 };
  return { ok: false, status: 404 };
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  await models.stopCore();
  lifecycle.usePidRegistry(null);
});

describe("the renderer never writes the Core row", () => {
  function guard(): (name: string, payload: unknown) => boolean {
    const start = mainSource.indexOf("function touchesCoreRow(");
    expect(start).toBeGreaterThan(-1);
    const end = mainSource.indexOf("\n}\n", start) + 3;
    return new Function(`${mainSource.slice(start, end)}\nreturn touchesCoreRow;`)();
  }

  it("refuses model.add and model.sync for friday-core, and lets every other id through", () => {
    const touches = guard();
    expect(touches("model.add", { id: "friday-core", endpoint: "http://evil" })).toBe(true);
    expect(touches("model.add", { id: " Friday-Core " })).toBe(true);
    expect(touches("model.sync", { models: [{ id: "a" }, { id: "friday-core" }] })).toBe(true);
    expect(touches("model.add", { id: "ollama:llama3" })).toBe(false);
    expect(touches("model.sync", { models: [{ id: "a" }, { id: "b" }] })).toBe(false);
    expect(touches("model.sync", {})).toBe(false);
    expect(touches("model.list", { id: "friday-core" })).toBe(false);
  });

  it("refuses a renderer model.remove of friday-core, and lets other removals through", () => {
    const touches = guard();
    expect(touches("model.remove", { id: "friday-core" })).toBe(true);
    expect(touches("model.remove", { id: "ollama:llama3" })).toBe(false);
  });

  it("is checked in the kernel:rpc handler before anything reaches the kernel", () => {
    const handler = mainSource.slice(mainSource.indexOf('ipcMain.handle("kernel:rpc"'));
    const check = handler.indexOf("touchesCoreRow(name, payload)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(handler.indexOf("kernelRequest("));
    expect(handler.slice(check, check + 200)).toMatch(/denied: true/);
  });
});

describe("stopCore during a slow load", () => {
  it("kills the pending child and leaves no Core behind", async () => {
    let kills = 0;
    let healthy = false;
    const c = child(() => (kills += 1), false);
    const pending = models.startCore({
      launch,
      spawn: () => c,
      probe: async (url: string, init: never) =>
        healthy ? keyedServer(url, init) : { ok: false, status: 0 },
      stepMs: 2,
      timeoutMs: 5000,
    });
    await wait(15);
    expect(await models.stopCore()).toBe(true);
    expect(kills).toBe(1);
    healthy = true;
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(models.coreEndpoint()).toBeNull();
    expect(kills).toBe(1);
  });

  it("stops Core after the load when the setting was turned off meanwhile", async () => {
    let kills = 0;
    let enabled = true;
    const out = await models.startCore({
      launch,
      spawn: () => child(() => (kills += 1)),
      probe: async (url: string, init: never) => {
        const res = await keyedServer(url, init);
        if (url.endsWith("/health")) enabled = false;
        return res;
      },
      isEnabled: () => enabled,
      stepMs: 1,
    });
    expect(out.ok).toBe(false);
    expect(kills).toBe(1);
    expect(models.coreEndpoint()).toBeNull();
  });

  it("starts normally while the setting stays on", async () => {
    const out = await models.startCore({
      launch,
      spawn: () => child(),
      probe: keyedServer,
      isEnabled: () => true,
      stepMs: 1,
    });
    expect(out.ok).toBe(true);
    expect(models.coreEndpoint()).toMatchObject({ apiKey: KEY });
  });
});

describe("the Core child is registered with the lifecycle owner", () => {
  it("tracks the spawned child as an owned runner", async () => {
    const tracked: unknown[][] = [];
    lifecycle.usePidRegistry({ track: (...a: unknown[]) => (tracked.push(a), true) });
    const c = child();
    await models.startCore({ launch, spawn: () => c, probe: keyedServer, stepMs: 1 });
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toEqual(["runner", c, "x"]);
    expect(lifecycle.OWNED_ROLES.has("runner")).toBe(true);
  });
});

describe("the loopback port must answer to this launch's key", () => {
  it("is ready only on 401 without the key and 200 with it", async () => {
    const seen: Array<[string, string | undefined]> = [];
    const out = await models.startCore({
      launch,
      spawn: () => child(),
      probe: async (url: string, init: { headers?: Record<string, string> }) => {
        seen.push([url, init?.headers?.["Authorization"]]);
        return keyedServer(url, init);
      },
      stepMs: 1,
    });
    expect(out.ok).toBe(true);
    const models_ = seen.filter(([u]) => u.endsWith("/v1/models"));
    expect(models_.map(([, auth]) => auth)).toEqual([undefined, `Bearer ${KEY}`]);
    expect(models_[0]?.[0]).toBe("http://127.0.0.1:40999/v1/models");
  });

  for (const [label, noKey, withKey] of [
    ["answers 200 without the key (a squatter)", 200, 200],
    ["refuses this launch's key", 401, 401],
    ["answers 500 with the key", 401, 500],
  ] as const) {
    it(`stops Core when the port ${label}`, async () => {
      let kills = 0;
      const out = await models.startCore({
        launch,
        spawn: () => child(() => (kills += 1)),
        probe: async (url: string, init: { headers?: Record<string, string> }) => {
          if (url.endsWith("/health")) return { ok: true, status: 200 };
          const status = init?.headers?.["Authorization"] ? withKey : noKey;
          return { ok: status === 200, status };
        },
        stepMs: 1,
      });
      expect(out.ok).toBe(false);
      expect(kills).toBe(1);
      expect(models.coreEndpoint()).toBeNull();
    });
  }

  it("stops Core when the key check cannot be made", async () => {
    let kills = 0;
    const out = await models.startCore({
      launch,
      spawn: () => child(() => (kills += 1)),
      probe: async (url: string) => {
        if (url.endsWith("/health")) return { ok: true, status: 200 };
        throw new Error("socket closed");
      },
      stepMs: 1,
    });
    expect(out.ok).toBe(false);
    expect(kills).toBe(1);
    expect(models.coreEndpoint()).toBeNull();
  });

  it("sends the local type in the router row only with the loopback endpoint", () => {
    expect(models.coreKernelRow(null)).not.toHaveProperty("type");
    expect(
      models.coreKernelRow({ baseUrl: launch.baseUrl, apiKey: KEY, model: "friday-core" }),
    ).toMatchObject({ type: "local", endpoint: "http://127.0.0.1:40999/v1" });
  });
});

describe("a joined release file is opened exclusively", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "friday-join-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const partA = Buffer.from("first part;");
  const partB = Buffer.from("second part");
  const whole = Buffer.concat([partA, partB]);
  const asset = {
    name: "m.gguf",
    bytes: whole.length,
    sha256: createHash("sha256").update(whole).digest("hex"),
    parts: [
      { file: "m.gguf.001", bytes: partA.length, url: "https://example.invalid/1" },
      { file: "m.gguf.002", bytes: partB.length, url: "https://example.invalid/2" },
    ],
  };

  function stage() {
    const cache = path.join(dir, ".cache", "friday-release");
    mkdirSync(cache, { recursive: true });
    writeFileSync(path.join(cache, "m.gguf.001"), partA);
    writeFileSync(path.join(cache, "m.gguf.002"), partB);
    return [path.join(cache, "m.gguf.001"), path.join(cache, "m.gguf.002")];
  }

  it("refuses to write through a planted link", async () => {
    const victim = path.join(dir, "victim.txt");
    writeFileSync(victim, "keep me");
    const link = path.join(dir, "link.part");
    try {
      symlinkSync(victim, link);
    } catch {
      return; // a PC that cannot make links has nothing to plant
    }
    await expect(download.joinParts(stage(), link)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("removes a planted link before the join and never writes through it", async () => {
    const victim = path.join(dir, "victim.txt");
    writeFileSync(victim, "keep me");
    const finalPath = path.join(dir, "m.gguf");
    try {
      symlinkSync(victim, `${finalPath}.join.part`);
    } catch {
      return;
    }
    stage();
    const bytes = await download.fetchReleaseFile(asset, finalPath, { dest: dir });
    expect(bytes).toBe(whole.length);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(lstatSync(finalPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(finalPath)).toEqual(whole);
    expect(existsSync(`${finalPath}.join.part`)).toBe(false);
  });

  it("opens the join file with wx after removing any old one", () => {
    const text = readFileSync(path.join(root, "electron/model-download.cjs"), "utf8");
    const join = text.slice(
      text.indexOf("function joinParts("),
      text.indexOf("async function fetchReleaseFile"),
    );
    expect(join).toMatch(/flags: "wx"/);
    const fetch = text.slice(text.indexOf("async function fetchReleaseFile"));
    expect(fetch.indexOf("fs.rmSync(joining")).toBeLessThan(
      fetch.indexOf("joinParts(staged, joining)"),
    );
  });
});
