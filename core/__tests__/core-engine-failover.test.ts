/**
 * FRIDAY Core starts through the dual engine start path (`llama-runtime.startEngine`): the own build first when it is
 * the chosen one, the official engine when it does not come up, `noteHealth` in the marker, and every hardening of the
 * old start kept (key proof, stop during load, setting re-read, one tracked child). The Install Manager and Doctor have a
 * `friday-runtime-llm` row that installs through `installOwnEngine`. Fake spawn, probe and disk: no hardware, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, "../..");
const models = require_(path.join(repo, "electron/models.cjs"));
const llama = require_(path.join(repo, "electron/llama-runtime.cjs"));
const engines = require_(path.join(repo, "electron/engine-install.cjs"));
const toolchain = require_(path.join(repo, "electron/toolchain.cjs"));
const catalog = require_(path.join(repo, "electron/installer-catalog.cjs"));
const sel = require_(path.join(repo, "electron/llm-engine-select.cjs"));
const core = require_(path.join(repo, "electron/friday-core.cjs"));
const manifest = require_(path.join(repo, "config/friday-core.json"));

const OFFICIAL_BIN = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const OWN_BIN = llama.OWN_NAME as string;
const FACTS = { ramGb: 16, cores: 8, cpuModel: "CPU X", gpu: null };
const TS = 1_800_000_000_000;
// A fake per-launch key, built at run time so the secret scanner never sees a key-shaped literal.
const KEY = ["fk", "failover", "key", String(246813579)].join("-");
const PORT = 40631;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-failover-"));
});
afterEach(async () => {
  await models.stopCore();
  rmSync(dir, { recursive: true, force: true });
});

function put(base: string, name: string, bin: string, marker: Record<string, unknown>) {
  const where = path.join(base, name);
  mkdirSync(where, { recursive: true });
  writeFileSync(path.join(where, bin), name);
  writeFileSync(
    path.join(where, ".friday-engine.json"),
    JSON.stringify({ tag: name.split("-")[0], backend: "cpu", installedAt: TS, ...marker }),
  );
  return where;
}
const official = () => put(llama.engineDir(dir), "b12230-cpu", OFFICIAL_BIN, {});
const own = () =>
  put(llama.ownEngineDir(dir), "b12230-friday-native", OWN_BIN, { origin: "friday-own" });
const ownMarker = () =>
  JSON.parse(
    readFileSync(
      path.join(llama.ownEngineDir(dir), "b12230-friday-native", ".friday-engine.json"),
      "utf8",
    ),
  );

/** The disk of FRIDAY Core's default variant at its pinned sizes, so `coreLaunch` can plan a model. */
function disk() {
  const have = new Map<string, number>();
  for (const f of core.variantOf(manifest, "e4b").files)
    have.set(core.diskPath(dir, f.disk), f.bytes);
  return (p: string) => (have.has(p) ? { size: have.get(p) } : undefined);
}

type Behave = "healthy" | "crash" | "hang";

/** Fake processes: every spawn is recorded, `behave(bin)` says how that engine acts, kills are counted per binary. */
function procs(behave: (bin: string) => Behave = () => "healthy") {
  const spawned: { bin: string; args: string[]; env: Record<string, string> }[] = [];
  const kills: string[] = [];
  const children: EventEmitter[] = [];
  const spawn = (bin: string, args: string[], opts: { env: Record<string, string> }) => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    // No pid on purpose: with a pid, a Windows stop goes to taskkill and never reaches this fake's kill.
    child["kill"] = () => {
      kills.push(path.basename(bin));
      return true;
    };
    spawned.push({ bin, args, env: opts.env });
    children.push(child);
    if (behave(bin) === "crash") setImmediate(() => child.emit("exit", 1));
    return child;
  };
  const probe = async (url: string, init?: { headers?: Record<string, string> }) => {
    const current = spawned.at(-1)?.bin ?? "";
    if (url.endsWith("/health")) return { ok: behave(current) === "healthy", status: 200 };
    return init?.headers?.["Authorization"] === `Bearer ${KEY}`
      ? { ok: true, status: 200 }
      : { ok: false, status: 401 };
  };
  const options = (over: Record<string, unknown> = {}) => ({
    root: dir,
    spawn,
    probe,
    stepMs: 1,
    timeoutMs: 5000,
    engine: { stat: disk(), facts: FACTS, key: KEY, port: PORT, cpus: 4 },
    ...over,
  });
  return { spawned, kills, children, options };
}

const names = (p: { spawned: { bin: string }[] }) => p.spawned.map((s) => path.basename(s.bin));

describe("FRIDAY Core starts through the dual engine start path", () => {
  it("runs the own build when it is the chosen engine and reports which engine it is", async () => {
    official();
    own();
    sel.writeBench(
      dir,
      {
        winner: "own",
        ownTps: 12,
        officialTps: 10,
        sameTokens: 32,
        fingerprint: { ...FACTS, ownTag: "b12230", officialTag: "b12230" },
      },
      { now: () => TS },
    );
    const p = procs();
    const out = await models.startCore(p.options());
    expect(out).toMatchObject({ ok: true, running: true, engine: "own" });
    expect(names(p)).toEqual([OWN_BIN]);
    expect(models.coreEndpoint()).toMatchObject({ apiKey: KEY, model: "friday-core" });
    expect(ownMarker().healthFails).toBeUndefined();
  });

  it("an own build that crashes is recorded and the official engine takes over in the same start", async () => {
    official();
    own();
    const p = procs((bin) => (bin.includes("friday-runtime-llm") ? "crash" : "healthy"));
    // No stored bench and the two tags equal: the own build is tried first, as `chooseEngine` says.
    const out = await models.startCore(p.options({ prefer: "own" }));
    expect(out).toMatchObject({ ok: true, engine: "official" });
    expect(names(p)).toEqual([OWN_BIN, OFFICIAL_BIN]);
    expect(ownMarker().healthFails).toBe(1);
    expect(models.coreEndpoint()).toMatchObject({ baseUrl: `http://127.0.0.1:${PORT}/v1` });
  });

  it("a second failed start demotes the own folder and the third start goes straight to official", async () => {
    official();
    own();
    const p = procs((bin) => (bin.includes("friday-runtime-llm") ? "crash" : "healthy"));
    await models.startCore(p.options({ prefer: "own" }));
    await models.stopCore();
    await models.startCore(p.options({ prefer: "own" }));
    await models.stopCore();
    expect(ownMarker().healthy).toBe(false);
    p.spawned.length = 0;
    const third = await models.startCore(p.options({ prefer: "own" }));
    expect(third).toMatchObject({ ok: true, engine: "official" });
    expect(names(p)).toEqual([OFFICIAL_BIN]);
  });

  it("a start that works clears the failure count of the engine that came up", async () => {
    official();
    own();
    const first = procs((bin) => (bin.includes("friday-runtime-llm") ? "crash" : "healthy"));
    await models.startCore(first.options({ prefer: "own" }));
    await models.stopCore();
    expect(ownMarker().healthFails).toBe(1);
    const good = procs();
    const out = await models.startCore(good.options({ prefer: "own" }));
    expect(out).toMatchObject({ ok: true, engine: "own" });
    expect(ownMarker().healthFails).toBe(0);
  });

  it("reports the failure of both engines and leaves no endpoint", async () => {
    official();
    own();
    const p = procs(() => "crash");
    const out = await models.startCore(p.options({ prefer: "own" }));
    expect(out).toMatchObject({
      ok: false,
      running: false,
      error: expect.stringMatching(/stopped while loading/),
    });
    expect(out.tried).toHaveLength(2);
    expect(models.coreEndpoint()).toBeNull();
  });

  it("says plainly that the runtime is not installed when no engine folder exists", async () => {
    const p = procs();
    const out = await models.startCore(p.options());
    expect(out).toMatchObject({ ok: false, running: false });
    expect(out.error).toMatch(/not installed/);
    expect(p.spawned).toHaveLength(0);
  });
});

describe("the hardening of the old start is kept on the new path", () => {
  it("stopCore during a slow load kills the pending runtime once and never tries the other engine", async () => {
    official();
    own();
    const p = procs(() => "hang");
    const pending = models.startCore(p.options({ prefer: "own" }));
    await new Promise((r) => setTimeout(r, 25));
    expect(await models.stopCore()).toBe(true);
    const out = await pending;
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/stopped while loading/) });
    expect(names(p)).toEqual([OWN_BIN]);
    expect(p.kills).toEqual([OWN_BIN]);
    expect(models.coreEndpoint()).toBeNull();
    expect(ownMarker().healthFails).toBeUndefined();
  });

  it("the port must answer to this launch's key: a squatter is killed and Core stays down", async () => {
    official();
    own();
    const p = procs();
    const out = await models.startCore(
      p.options({
        prefer: "own",
        probe: async (url: string) => ({ ok: true, status: url.endsWith("/health") ? 200 : 200 }),
      }),
    );
    expect(out).toMatchObject({
      ok: false,
      error: expect.stringMatching(/did not answer to this launch's key/),
    });
    expect(p.kills).toEqual([OWN_BIN]);
    expect(models.coreEndpoint()).toBeNull();
  });

  it("the owner's setting is re-read after the load: switched off means the runtime is stopped", async () => {
    official();
    own();
    let enabled = true;
    const p = procs();
    const base = p.options({ prefer: "own" });
    const out = await models.startCore({
      ...base,
      probe: async (url: string, init?: { headers?: Record<string, string> }) => {
        const res = await (base.probe as (u: string, i?: unknown) => Promise<unknown>)(url, init);
        if (url.endsWith("/health")) enabled = false;
        return res;
      },
      isEnabled: () => enabled,
    });
    expect(out.ok).toBe(false);
    expect(p.kills).toEqual([OWN_BIN]);
    expect(models.coreEndpoint()).toBeNull();
  });

  it("tracks every spawned engine child with the one lifecycle owner, failed ones included", async () => {
    official();
    own();
    const tracked: string[] = [];
    const lifecycle = require_(path.join(repo, "electron/app-lifecycle.cjs"));
    lifecycle.usePidRegistry({
      track: (_role: string, _child: unknown, bin: string) => (
        tracked.push(path.basename(bin)),
        true
      ),
    });
    try {
      const p = procs((bin) => (bin.includes("friday-runtime-llm") ? "crash" : "healthy"));
      await models.startCore(p.options({ prefer: "own" }));
      expect(tracked).toEqual([OWN_BIN, OFFICIAL_BIN]);
    } finally {
      lifecycle.usePidRegistry(null);
    }
  });

  it("a start while Core runs answers already running and spawns nothing", async () => {
    official();
    const p = procs();
    await models.startCore(p.options());
    const again = await models.startCore(p.options());
    expect(again).toMatchObject({ ok: true, running: true, detail: "already running" });
    expect(p.spawned).toHaveLength(1);
  });
});

describe("the source keeps the delegation honest", () => {
  const source = readFileSync(path.join(repo, "electron/models.cjs"), "utf8");
  const start = source.slice(
    source.indexOf("async function startCore("),
    source.indexOf("/** Stops a child FRIDAY started"),
  );

  it("startCore delegates to startEngine and no longer picks an engine by itself", () => {
    expect(start).toMatch(/runtime\.startEngine\(/);
    expect(start).not.toMatch(/runtime\.coreLaunch\(/);
    expect(start).toMatch(/coreKeyed\(/);
  });
});

describe("the friday-runtime-llm row of the Install Manager", () => {
  const row = () => toolchain.TOOLS.find((t: { id: string }) => t.id === "friday-runtime-llm");

  it("is an engine row on the own spec with a detector and a plain description", () => {
    expect(row()).toMatchObject({ engine: "friday-runtime-llm", category: "AI Runtimes" });
    expect(typeof row().detect).toBe("function");
    expect(row().manual).toMatch(/official/i);
    expect(engines.ENGINES["friday-runtime-llm"].id).toBe("friday-runtime-llm");
  });

  it("detects the installed own build with its tag, and nothing when it is not there", async () => {
    expect(await row().detect({ root: dir })).toMatchObject({ installed: false });
    own();
    expect(await row().detect({ root: dir })).toMatchObject({ installed: true, status: "Ready" });
  });

  it("install with no release asset and no local build falls back to official and says so", async () => {
    const events: { phase?: string; error?: string; line?: string }[] = [];
    const out = await toolchain.runEngineJob(
      { tool: row(), action: "install", root: dir },
      (e: { phase?: string }) => events.push(e),
      { own: { record: { tag: null, files: [] }, pin: null } },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/official llama\.cpp stays in use/);
    expect(events.at(-1)).toMatchObject({ phase: "Failed" });
    expect(readdirSync(dir)).not.toContain("runtime-own");
  });

  it("install from the local build drop folder adopts it through installOwnEngine", async () => {
    const drop = llama.ownLocalDir(dir) as string;
    mkdirSync(drop, { recursive: true });
    writeFileSync(path.join(drop, OWN_BIN), "own-exe");
    const record = {
      tag: "b12230",
      variant: "friday-native",
      files: [{ name: OWN_BIN, sha256: sha("own-exe") }],
    };
    const events: { phase?: string; line?: string }[] = [];
    const out = await toolchain.runEngineJob(
      { tool: row(), action: "install", root: dir },
      (e: { phase?: string }) => events.push(e),
      {
        own: { record, pin: null, officialTag: "b12230" },
        deps: { health: async () => ({ ok: true }) },
      },
    );
    expect(out).toMatchObject({ ok: true, source: "local" });
    expect(events.at(-1)).toMatchObject({ phase: "Done" });
    expect(engines.detectEngine(dir, engines.ENGINES["friday-runtime-llm"])).toMatchObject({
      installed: true,
      origin: "friday-own",
    });
  });

  it("an own build that is the recorded tag and healthy is never downloaded again", async () => {
    const files = [{ name: OWN_BIN, sha256: sha("own-exe") }];
    const record = {
      tag: "b12230",
      variant: "friday-native",
      assetName: "a.zip",
      sha256: sha("a"),
      files,
    };
    const drop = llama.ownLocalDir(dir) as string;
    mkdirSync(drop, { recursive: true });
    writeFileSync(path.join(drop, OWN_BIN), "own-exe");
    const calls: string[] = [];
    const deps = {
      health: async () => ({ ok: true }),
      download: async () => {
        calls.push("download");
      },
      extract: async () => ({ ok: false, error: "never" }),
      now: () => TS,
    };
    const first = await engines.installOwnEngine(
      dir,
      { record, pin: null, officialTag: "b12230" },
      deps,
    );
    expect(first).toMatchObject({ ok: true, source: "local" });
    const pin = engines.ownPin(record, "owner/repo");
    const second = await engines.installOwnEngine(
      dir,
      { record, pin, officialTag: "b12230" },
      deps,
    );
    expect(second).toMatchObject({ ok: true, source: "release", reused: true });
    expect(calls).toEqual([]);
  });
});

describe("the Doctor row of the own engine", () => {
  const rowOf = (over: Record<string, unknown> = {}) => ({
    id: "friday-runtime-llm",
    name: "friday-runtime-llm",
    installed: true,
    installedVersion: "12230",
    engine: "friday-runtime-llm",
    fit: { state: "ok", reasons: [] },
    engineState: {
      active: "own",
      outdated: false,
      rows: sel.rowNames({
        ownTag: "b12230",
        officialTag: "b12230",
        officialBackend: "cpu",
        active: "own",
        ownTps: 12,
        officialTps: 10,
      }),
    },
    ...over,
  });

  it("shows the row text of rowNames with a repair when the own build is installed", () => {
    const out = catalog.doctorRows([rowOf()]);
    const hit = out.find((r: { id: string }) => r.id === "engine:friday-runtime-llm");
    expect(hit).toMatchObject({
      label: "FRIDAY Runtime LLM (own build b12230, native)",
      status: "ok",
      repair: { id: "friday-runtime-llm", action: "repair" },
    });
    expect(hit.detail).toMatch(/own active, official ready as fallback/);
  });

  it("warns with the outdated text when the tags differ", () => {
    const rows = sel.rowNames({ ownTag: "b12000", officialTag: "b12230", active: "official" });
    const out = catalog.doctorRows([
      rowOf({ engineState: { active: "official", outdated: true, rows } }),
    ]);
    const hit = out.find((r: { id: string }) => r.id === "engine:friday-runtime-llm");
    expect(hit).toMatchObject({ status: "warn" });
    expect(hit.detail).toMatch(/own build outdated/);
  });

  it("is a skip row with an install repair when the own build is not installed yet", () => {
    const out = catalog.doctorRows([
      rowOf({ installed: false, installedVersion: null, engineState: null }),
    ]);
    const hit = out.find((r: { id: string }) => r.id === "engine:friday-runtime-llm");
    expect(hit).toMatchObject({
      status: "skip",
      repair: { id: "friday-runtime-llm", action: "install" },
    });
    expect(hit.detail).toMatch(/official/);
  });
});
