/**
 * FRIDAY's own llama.cpp build and the official one, used together: marker origin, source order of the own install
 * (release asset with a SHA-256, local build, official), same-tag rule, engine choice from the ordered folders, the
 * two-failed-checks demotion, the cold standby under a governor lease, the owner-started or idle bench, and the
 * plain-object state for Doctor and the Install Manager. Fake spawn, probe, request and disk: no hardware, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, "../..");
const llama = require_(path.join(repo, "electron/llama-runtime.cjs"));
const engines = require_(path.join(repo, "electron/engine-install.cjs"));
const sel = require_(path.join(repo, "electron/llm-engine-select.cjs"));
const core = require_(path.join(repo, "electron/friday-core.cjs"));
const manifest = require_(path.join(repo, "config/friday-core.json"));

const OFFICIAL_BIN = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const OWN_BIN = llama.OWN_NAME as string;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const FACTS = { ramGb: 16, cores: 8, cpuModel: "CPU X", gpu: null };
const TS = 1_800_000_000_000;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-dual-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const officialBase = () => llama.engineDir(dir) as string;
const ownBase = () => llama.ownEngineDir(dir) as string;

function put(
  base: string,
  name: string,
  bin: string,
  marker: Record<string, unknown> | null,
  at = TS,
) {
  const where = path.join(base, name);
  mkdirSync(where, { recursive: true });
  writeFileSync(path.join(where, bin), name);
  if (marker)
    writeFileSync(
      path.join(where, ".friday-engine.json"),
      JSON.stringify({ tag: name.split("-")[0], backend: "cpu", installedAt: at, ...marker }),
    );
  return where;
}
const official = (tag = "b12230", marker: Record<string, unknown> | null = {}) =>
  put(officialBase(), `${tag}-cpu`, OFFICIAL_BIN, marker);
const own = (tag = "b12230", marker: Record<string, unknown> | null = {}) =>
  put(ownBase(), `${tag}-friday-native`, OWN_BIN, marker && { origin: "friday-own", ...marker });

/** A stored bench for the two tags, as the bench step writes it. */
function bench(winner: "own" | "official", ownTag = "b12230", officialTag = "b12230") {
  expect(
    sel.writeBench(
      dir,
      {
        winner,
        ownTps: winner === "own" ? 12 : 10,
        officialTps: 10,
        sameTokens: 32,
        fingerprint: { ...FACTS, ownTag, officialTag },
      },
      { now: () => TS },
    ),
  ).toBe(true);
}

/** A fake disk for FRIDAY Core's default variant (the pinned sizes), so `coreLaunch` can plan a model. */
function disk() {
  const have = new Map<string, number>();
  for (const f of core.variantOf(manifest, "e4b").files)
    have.set(core.diskPath(dir, f.disk), f.bytes);
  return (p: string) => (have.has(p) ? { size: have.get(p) } : undefined);
}

/** Fake processes: every spawn is recorded, `outcome(bin)` says how that engine behaves. */
function procs(outcome: (bin: string) => "healthy" | "crash" = () => "healthy") {
  const spawned: { bin: string; args: string[]; env: Record<string, string>; child: any }[] = [];
  const stopped: string[] = [];
  const tracked: string[] = [];
  const deps = {
    spawn: (bin: string, args: string[], opts: { env: Record<string, string> }) => {
      const child: any = new EventEmitter();
      child.pid = 100 + spawned.length;
      child.kill = () => {
        stopped.push(bin);
        setImmediate(() => child.emit("exit", 0));
        return true;
      };
      spawned.push({ bin, args, env: opts.env, child });
      if (outcome(bin) === "crash") setImmediate(() => child.emit("exit", 1));
      return child;
    },
    track: (_role: string, _child: unknown, bin: string) => {
      tracked.push(bin);
      return true;
    },
    stop: (child: any) => child.kill(),
    probe: async () => ({ ok: outcome(spawned.at(-1)?.bin ?? "") === "healthy" }),
    sleep: () => new Promise<void>((r) => setImmediate(r)),
    stopWaitMs: 0,
    port: 40777,
    cpus: 4,
    key: ["fk", "dual", "test"].join("-"),
  };
  return { spawned, stopped, tracked, deps };
}

describe("origin of an engine folder", () => {
  it("a marker with no origin is official, an own marker says friday-own, and nothing is rewritten", () => {
    const oldFolder = official("b12000", { id: "llama.cpp" });
    const before = readFileSync(path.join(oldFolder, ".friday-engine.json"), "utf8");
    own("b12230");
    const entries = llama.engineEntries(dir) as { origin: string; tag: string }[];
    expect(entries.map((e) => `${e.origin}:${e.tag}`).sort()).toEqual([
      "official:b12000",
      "own:b12230",
    ]);
    llama.chooseEngine(dir, { facts: FACTS });
    expect(readFileSync(path.join(oldFolder, ".friday-engine.json"), "utf8")).toBe(before);
    expect(engines.detectEngine(dir, engines.ENGINES["llama.cpp"]).origin).toBe("official");
  });

  it("the installer writes origin official for the official engine and friday-own for the own build", async () => {
    const files = [{ name: OWN_BIN, sha256: sha("own-exe") }];
    const local = path.join(dir, "out");
    mkdirSync(local, { recursive: true });
    writeFileSync(path.join(local, OWN_BIN), "own-exe");
    const deps = {
      health: async () => ({ ok: true }),
      now: () => TS,
    };
    const done = await engines.installOwnEngine(
      dir,
      { record: { tag: "b12230", variant: "friday-native", files }, localDir: local, pin: null },
      deps,
    );
    expect(done).toMatchObject({ ok: true, source: "local", tag: "b12230" });
    const marker = JSON.parse(
      readFileSync(path.join(ownBase(), "b12230-friday-native", ".friday-engine.json"), "utf8"),
    );
    expect(marker).toMatchObject({ origin: "friday-own", tag: "b12230", source: "local-build" });
    expect(engines.detectEngine(dir, engines.ENGINES["friday-runtime-llm"])).toMatchObject({
      installed: true,
      origin: "friday-own",
    });
  });
});

describe("installing the own build: release asset, local build, then official", () => {
  const ASSET = "friday-runtime-llm-b12230-friday-native-win-x64.zip";
  const record = (over: Record<string, unknown> = {}) => ({
    name: "friday-runtime-llm",
    tag: "b12230",
    variant: "friday-native",
    assetName: ASSET,
    sha256: sha(ASSET),
    files: [{ name: OWN_BIN, sha256: sha("own-exe") }],
    ...over,
  });
  const fakes = (exeText = "own-exe") => {
    const log: string[] = [];
    return {
      log,
      deps: {
        download: async (url: string, dest: string) => {
          log.push(`download ${decodeURIComponent(url.split("/").pop()!)}`);
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, ASSET);
        },
        extract: async (_zip: string, dest: string) => {
          mkdirSync(dest, { recursive: true });
          writeFileSync(path.join(dest, OWN_BIN), exeText);
          return { ok: true };
        },
        health: async () => ({ ok: true }),
        now: () => TS,
      },
    };
  };

  it("a null SHA-256 never installs the owner's release asset (no download), and the answer is official", async () => {
    const f = fakes();
    const out = await engines.installOwnEngine(
      dir,
      { record: record({ sha256: null }), officialTag: "b12230" },
      f.deps,
    );
    expect(f.log).toEqual([]);
    expect(out).toMatchObject({ ok: false, fellBack: "official" });
    expect(out.attempts[0]).toMatchObject({ source: "release", ok: false });
    expect(out.error).toContain("official llama.cpp stays in use");
    expect(existsSync(ownBase())).toBe(false);
    expect(engines.ENGINES["friday-runtime-llm"].pinned).toBeNull();
  });

  it("installs the release asset when its SHA-256 is recorded, and checks the unpacked files against the record", async () => {
    const f = fakes();
    const pin = engines.ownPin(record(), "owner/repo");
    expect(pin.assets[0].url).toContain(`/owner/repo/releases/download/friday-runtime-llm-b12230/`);
    const out = await engines.installOwnEngine(
      dir,
      { record: record(), pin, officialTag: "b12230" },
      f.deps,
    );
    expect(f.log).toEqual([`download ${ASSET}`]);
    expect(out).toMatchObject({ ok: true, source: "release", outdated: false });
    expect(existsSync(path.join(ownBase(), "b12230-friday-native", OWN_BIN))).toBe(true);
  });

  it("refuses an unpacked file that does not match the recorded SHA-256 and falls back", async () => {
    const f = fakes("tampered");
    const pin = engines.ownPin(record(), "owner/repo");
    const out = await engines.installOwnEngine(
      dir,
      { record: record(), pin, officialTag: "b12230" },
      f.deps,
    );
    expect(out).toMatchObject({ ok: false, fellBack: "official" });
    expect(out.attempts[0].reason).toContain("does not match its recorded SHA-256");
    expect(existsSync(ownBase()) ? readdirSync(ownBase()) : []).toEqual([]);
  });

  it("adopts a local build only when every file matches the record and nothing extra is in the folder", async () => {
    const local = path.join(dir, "out");
    mkdirSync(local, { recursive: true });
    writeFileSync(path.join(local, OWN_BIN), "own-exe");
    writeFileSync(path.join(local, "extra.dll"), "x");
    const f = fakes();
    const bad = await engines.installOwnEngine(
      dir,
      { record: record({ sha256: null }), localDir: local, officialTag: "b12230" },
      f.deps,
    );
    expect(bad.ok).toBe(false);
    expect(bad.attempts[1]).toMatchObject({ source: "local", ok: false });
    expect(bad.attempts[1].reason).toContain("extra.dll");
    rmSync(path.join(local, "extra.dll"));
    const good = await engines.installOwnEngine(
      dir,
      { record: record({ sha256: null }), localDir: local, officialTag: "b12230" },
      f.deps,
    );
    expect(good).toMatchObject({ ok: true, source: "local" });
  });

  it("flags an own build of another tag than the official engine as outdated", async () => {
    const f = fakes();
    const pin = engines.ownPin(record(), "owner/repo");
    const out = await engines.installOwnEngine(
      dir,
      { record: record(), pin, officialTag: "b12300" },
      f.deps,
    );
    expect(out).toMatchObject({ ok: true, outdated: true, tag: "b12230", officialTag: "b12300" });
  });
});

describe("choosing the engine from the ordered folders", () => {
  it("official while not benched, own after an own-winning bench for the same fingerprint", () => {
    official();
    own();
    expect(llama.chooseEngine(dir, { facts: FACTS })).toMatchObject({
      engine: "official",
      reason: "not-benched",
    });
    bench("own");
    const pick = llama.chooseEngine(dir, { facts: FACTS });
    expect(pick).toMatchObject({ engine: "own", reason: "bench-own", outdated: false });
    expect(pick.bin).toContain(OWN_BIN);
    expect(pick.standbyBin).toContain(OFFICIAL_BIN);
  });

  it("a bench taken for another PC is ignored, and the owner's prefer setting beats the bench", () => {
    official();
    own();
    bench("own");
    expect(llama.chooseEngine(dir, { facts: { ...FACTS, ramGb: 32 } }).engine).toBe("official");
    expect(llama.chooseEngine(dir, { facts: FACTS, prefer: "official" }).engine).toBe("official");
    bench("official");
    expect(llama.chooseEngine(dir, { facts: FACTS, prefer: "own" }).engine).toBe("own");
  });

  it("another tag keeps the official engine and says the own build is outdated", () => {
    official("b12300");
    own("b12230");
    bench("own", "b12230", "b12300");
    expect(llama.chooseEngine(dir, { facts: FACTS })).toMatchObject({
      engine: "official",
      outdated: true,
      reason: "own-outdated",
    });
    expect(llama.engineState(dir, { facts: FACTS, plan: { ok: false } }).rows.outdated).toBe(
      "own build outdated",
    );
  });

  it("two failed health checks demote the own folder, one failure does not, a pass resets the count", () => {
    official();
    const folder = own();
    bench("own");
    const entry = () => llama.engineEntries(dir).find((e: any) => e.origin === "own");
    expect(engines.noteHealth(entry(), false)).toMatchObject({ demoted: false, fails: 1 });
    expect(llama.chooseEngine(dir, { facts: FACTS }).engine).toBe("own");
    expect(engines.noteHealth(entry(), true)).toMatchObject({ demoted: false, fails: 0 });
    expect(engines.noteHealth(entry(), false).demoted).toBe(false);
    expect(engines.noteHealth(entry(), false)).toMatchObject({ demoted: true, fails: 2 });
    const marker = JSON.parse(readFileSync(path.join(folder, ".friday-engine.json"), "utf8"));
    expect(marker.healthy).toBe(false);
    expect(llama.chooseEngine(dir, { facts: FACTS })).toMatchObject({
      engine: "official",
      reason: "only-official",
    });
  });

  it("coreLaunch uses the chosen engine, its backend and a cold standby plan, and writes nothing", async () => {
    official();
    own("b12230", { backend: "cpu" });
    bench("own");
    const before = readdirSync(dir).length;
    const out = await llama.coreLaunch(dir, {
      stat: disk(),
      facts: FACTS,
      port: 40555,
      key: "k",
      cpus: 4,
    });
    expect(out).toMatchObject({ ok: true, engine: "own", outdated: false, gpu: false });
    expect(out.bin).toContain(OWN_BIN);
    expect(out.standby.bin).toContain(OFFICIAL_BIN);
    expect(out.standbyPlan.args).toEqual(["-c", "2048", "-np", "1"]);
    expect(readdirSync(dir).length).toBe(before);
    const plain = await llama.coreLaunch(dir, {
      stat: disk(),
      facts: { ...FACTS, ramGb: 8 },
      port: 40555,
      key: "k",
    });
    expect(plain.engine).toBe("official");
  });
});

describe("starting the engine and the standby", () => {
  it("an own build that never comes up is recorded and the official engine takes over; a second failure demotes it", async () => {
    official();
    own();
    bench("own");
    const p = procs((bin) => (bin.includes("friday-runtime-llm") ? "crash" : "healthy"));
    const common = { ...p.deps, stat: disk(), facts: FACTS, timeoutMs: 5000 };
    const first = await llama.startEngine(dir, common);
    expect(first).toMatchObject({ ok: true, engine: "official" });
    expect(first.tried).toMatchObject([{ engine: "own" }]);
    expect(p.spawned.map((s) => path.basename(s.bin))).toEqual([OWN_BIN, OFFICIAL_BIN]);
    expect(p.tracked).toHaveLength(2);
    const ownMarker = () =>
      JSON.parse(
        readFileSync(path.join(ownBase(), "b12230-friday-native", ".friday-engine.json"), "utf8"),
      );
    expect(ownMarker().healthFails).toBe(1);
    expect(ownMarker().healthy).toBeUndefined();
    await llama.startEngine(dir, common);
    expect(ownMarker().healthy).toBe(false);
    p.spawned.length = 0;
    const third = await llama.startEngine(dir, common);
    expect(third.engine).toBe("official");
    expect(p.spawned.map((s) => path.basename(s.bin))).toEqual([OFFICIAL_BIN]);
  });

  it("starts the standby text-only with -c 2048 -np 1 under a governor lease, tracked, and gives the lease back on exit", async () => {
    official();
    own();
    bench("own");
    const launch = await llama.coreLaunch(dir, {
      stat: disk(),
      facts: FACTS,
      port: 40555,
      key: "k",
      cpus: 4,
    });
    const asked: any[] = [];
    let released = 0;
    const governor = {
      acquire: async (req: unknown) => {
        asked.push(req);
        return { state: "granted", lease: { release: () => (released += 1), loaded: () => {} } };
      },
    };
    const p = procs();
    const out = await llama.startStandby(dir, launch, { ...p.deps, governor, stat: disk() });
    expect(out).toMatchObject({ ok: true, mode: "cold", port: 40777 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "llm", queue: false });
    const args = p.spawned[0]!.args;
    expect(args.slice(args.indexOf("-c"), args.indexOf("-c") + 4)).toEqual([
      "-c",
      "2048",
      "-np",
      "1",
    ]);
    expect(args).not.toContain("--mmproj");
    expect(path.basename(p.spawned[0]!.bin)).toBe(OFFICIAL_BIN);
    expect(p.spawned[0]!.args.join(" ")).not.toContain(p.deps.key);
    expect(p.spawned[0]!.env["LLAMA_API_KEY"]).toBe(p.deps.key);
    expect(p.tracked).toHaveLength(1);
    p.spawned[0]!.child.emit("exit", 0);
    expect(released).toBe(1);
  });

  it("starts no standby process when the governor refuses memory", async () => {
    official();
    own();
    bench("own");
    const launch = await llama.coreLaunch(dir, {
      stat: disk(),
      facts: FACTS,
      port: 40555,
      key: "k",
    });
    const p = procs();
    const governor = { acquire: async () => ({ state: "refused", reason: "no-room" }) };
    const out = await llama.startStandby(dir, launch, { ...p.deps, governor, stat: disk() });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("no-room");
    expect(p.spawned).toHaveLength(0);
  });
});

describe("the bench: owner-started or idle under a lease, one engine after the other", () => {
  const plan = { ok: true, model: "/m/core.gguf" };
  const measuring = () => {
    const p = procs();
    const request = async () => {
      const own = path.basename(p.spawned.at(-1)!.bin) === OWN_BIN;
      return {
        tokens: Array.from({ length: 32 }, (_, i) => i + 1),
        timings: { predicted_per_second: own ? 12 : 10 },
      };
    };
    return {
      p,
      deps: {
        ...p.deps,
        request,
        plan,
        facts: FACTS,
        stat: () => ({ size: 3 * 1024 ** 3 }),
        clock: () => TS,
      },
    };
  };

  it("refuses without the owner and without an idle lease, and never during a voice turn", async () => {
    official();
    own();
    const { p, deps } = measuring();
    expect(await llama.runBench(dir, deps)).toMatchObject({ ran: false, reason: "not-idle" });
    expect(await llama.runBench(dir, { ...deps, idle: () => true })).toMatchObject({
      reason: "not-idle",
    });
    const asked: unknown[] = [];
    const governor = {
      acquire: async (r: unknown) => (
        asked.push(r),
        { state: "refused", reason: "deferred-voice" }
      ),
    };
    expect(await llama.runBench(dir, { ...deps, idle: () => true, governor })).toMatchObject({
      ran: false,
      reason: "governor-refused",
    });
    expect(
      await llama.runBench(dir, { ...deps, ownerStarted: true, voiceBusy: () => true }),
    ).toMatchObject({ ran: false, reason: "voice-turn" });
    expect(p.spawned).toHaveLength(0);
    expect(asked).toHaveLength(1);
  });

  it("runs own then official, stops each, stores the verdict, and releases the lease", async () => {
    official();
    own();
    const { p, deps } = measuring();
    let released = 0;
    const governor = {
      acquire: async () => ({ state: "granted", lease: { release: () => (released += 1) } }),
    };
    const out = await llama.runBench(dir, { ...deps, idle: () => true, governor });
    expect(out).toMatchObject({
      ok: true,
      ran: true,
      stored: true,
      winner: "own",
      ownTps: 12,
      officialTps: 10,
    });
    expect(p.spawned.map((s) => path.basename(s.bin))).toEqual([OWN_BIN, OFFICIAL_BIN]);
    expect(p.stopped).toHaveLength(2);
    expect(released).toBe(1);
    expect(
      sel.readBench(dir, { fingerprint: { ...FACTS, ownTag: "b12230", officialTag: "b12230" } }),
    ).toMatchObject({
      winner: "own",
    });
    expect(llama.chooseEngine(dir, { facts: FACTS }).engine).toBe("own");
  });

  it("stores nothing when nothing was measured, and runs nothing when the tags differ", async () => {
    official();
    own();
    const { deps } = measuring();
    const silent = { ...deps, request: async () => ({ tokens: [], timings: {} }) };
    const none = await llama.runBench(dir, { ...silent, ownerStarted: true });
    expect(none).toMatchObject({ ran: true, stored: false, ok: false });
    expect(existsSync(path.join(dir, sel.BENCH_FILE))).toBe(false);
    rmSync(officialBase(), { recursive: true, force: true });
    official("b12300");
    const { p, deps: again } = measuring();
    expect(await llama.runBench(dir, { ...again, ownerStarted: true })).toMatchObject({
      ran: false,
      outdated: true,
      winner: "official",
      reason: "own-outdated",
    });
    expect(p.spawned).toHaveLength(0);
  });

  it("stopping mid-bench kills the running engine, starts no second one and stores nothing", async () => {
    official();
    own();
    const controller = new AbortController();
    const { p, deps } = measuring();
    const slow = async () => {
      controller.abort();
      return { tokens: [1], timings: { predicted_per_second: 5 } };
    };
    const out = await llama.runBench(dir, {
      ...deps,
      request: slow,
      ownerStarted: true,
      signal: controller.signal,
    });
    expect(out).toMatchObject({ ran: false, stopped: true, stored: false });
    expect(p.spawned).toHaveLength(1);
    expect(p.stopped.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(dir, sel.BENCH_FILE))).toBe(false);
  });
});

describe("the state for Doctor and the Install Manager", () => {
  it("is a plain object with both engines, the active one, the standby, the bench and the row strings", () => {
    official();
    own();
    bench("own");
    const state = llama.engineState(dir, { facts: FACTS, plan: { ok: false }, prefer: "auto" });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state).toMatchObject({
      prefer: "auto",
      active: "own",
      outdated: false,
      own: { installed: true, tag: "b12230", healthy: true },
      official: { installed: true, tag: "b12230" },
      standby: { engine: "official" },
      bench: { winner: "own", ownTps: 12, officialTps: 10 },
      thresholdsUnverified: true,
    });
    expect(state.rows.status).toContain("own active, official ready as fallback (own +20 percent");
    expect(state.rows.own).toBe("FRIDAY Runtime LLM (own build b12230, native)");
    expect(state.doctor.map((r: { id: string }) => r.id)).toEqual(["own", "official", "status"]);
    expect(JSON.stringify(state)).not.toMatch(/fk-|LLAMA_API_KEY/);
  });

  it("shows an uninstalled own build as not installed and the official engine as active", () => {
    official();
    const state = llama.engineState(dir, { facts: FACTS, plan: { ok: false } });
    expect(state).toMatchObject({ active: "official", own: { installed: false }, standby: null });
    expect(state.doctor[0]).toMatchObject({ id: "own", ok: false, detail: "not installed" });
  });
});

describe("the one lifecycle owner", () => {
  it("spawns engines only through spawnEngine, which tracks the child, and holds no marker writer", () => {
    const text = readFileSync(path.join(repo, "electron/llama-runtime.cjs"), "utf8");
    expect((text.match(/\bspawn\(/g) || []).length).toBe(1);
    expect(text).toContain('trackOwned)("runner", child, bin)');
    expect(text).not.toMatch(/writeFile|renameSync/);
  });
});

describe("standby and bench fail closed on memory", () => {
  const launchOf = async () => {
    official();
    own();
    bench("own");
    return llama.coreLaunch(dir, { stat: disk(), facts: FACTS, port: 40555, key: "k", cpus: 4 });
  };
  const GOOD = { state: "granted", lease: { release: () => {} } };

  it("starts no standby without a governor, with a plain reason", async () => {
    const launch = await launchOf();
    const p = procs();
    const out = await llama.startStandby(dir, launch, { ...p.deps, stat: disk() });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("governor");
    expect(p.spawned).toHaveLength(0);
  });

  it("an owner-started bench refuses while Core is loaded and RAM would not fit both, with no stop hook", async () => {
    official();
    own();
    const p = procs();
    const deps = {
      ...p.deps,
      plan: { ok: true, model: "/m/core.gguf" },
      facts: FACTS,
      stat: () => ({ size: 8 * 1024 ** 3 }),
      os: { freemem: () => 4 * 1024 ** 3 },
      coreLoaded: () => true,
      ownerStarted: true,
    };
    expect(await llama.runBench(dir, deps)).toMatchObject({ ran: false, reason: "core-loaded" });
    expect(p.spawned).toHaveLength(0);
  });

  it("stops Core first, benches, then brings Core back and releases the lease", async () => {
    official();
    own();
    const order: string[] = [];
    const p = procs();
    const request = async () => ({
      tokens: Array.from({ length: 32 }, (_, i) => i + 1),
      timings: { predicted_per_second: 10 },
    });
    const governor = {
      acquire: async () => (
        order.push("lease"),
        { ...GOOD, lease: { release: () => order.push("release") } }
      ),
    };
    const out = await llama.runBench(dir, {
      ...p.deps,
      request,
      plan: { ok: true, model: "/m/core.gguf" },
      facts: FACTS,
      clock: () => TS,
      stat: () => ({ size: 8 * 1024 ** 3 }),
      os: { freemem: () => 4 * 1024 ** 3, tmpdir, cpus: () => [] },
      coreLoaded: () => true,
      stopCore: async () => void order.push("stop-core"),
      resumeCore: async () => void order.push("resume-core"),
      ownerStarted: true,
      governor,
    });
    expect(out.ran).toBe(true);
    expect(order).toEqual(["stop-core", "lease", "release", "resume-core"]);
  });

  it("an owner-started bench still asks the governor when one is passed and respects a refusal", async () => {
    official();
    own();
    const p = procs();
    let resumed = 0;
    const out = await llama.runBench(dir, {
      ...p.deps,
      plan: { ok: true, model: "/m/core.gguf" },
      stat: () => ({ size: 3 * 1024 ** 3 }),
      ownerStarted: true,
      governor: { acquire: async () => ({ state: "refused", reason: "no-room" }) },
      resumeCore: async () => void (resumed += 1),
    });
    expect(out).toMatchObject({ ran: false, reason: "governor-refused" });
    expect(p.spawned).toHaveLength(0);
    expect(resumed).toBe(0);
  });
});

describe("the marker is re-checked before an engine may be spawned", () => {
  const withFile = (base: string, name: string, bin: string, extra: Record<string, unknown>) =>
    put(base, name, bin, extra);

  it("an official folder whose binary no longer matches the marker hash is demoted and never spawned", async () => {
    withFile(officialBase(), "b12230-cpu", OFFICIAL_BIN, {
      files: [{ name: OFFICIAL_BIN, sha256: sha("b12230-cpu") }],
    });
    withFile(officialBase(), "b12100-cpu", OFFICIAL_BIN, {
      files: [{ name: OFFICIAL_BIN, sha256: sha("not-what-is-on-disk") }],
    });
    const entries = llama.engineEntries(dir) as { name: string; trusted: boolean }[];
    expect(entries.find((e) => e.name === "b12100-cpu")!.trusted).toBe(false);
    expect(entries.find((e) => e.name === "b12230-cpu")!.trusted).toBe(true);
    const p = procs();
    const out = await llama.startEngine(dir, { ...p.deps, stat: disk(), facts: FACTS });
    expect(out.ok).toBe(true);
    expect(p.spawned.map((s) => s.bin).every((b) => b.includes("b12230-cpu"))).toBe(true);
  });

  it("an own build is checked against the recorded sha256 in the own record, not the marker", () => {
    own("b12230", { files: [{ name: OWN_BIN, sha256: sha("b12230-friday-native") }] });
    const good = { files: [{ name: OWN_BIN, sha256: sha("b12230-friday-native") }] };
    const bad = { files: [{ name: OWN_BIN, sha256: sha("something-else") }] };
    const trustedOf = (rec: unknown) =>
      (llama.engineEntries(dir, undefined, rec) as { trusted: boolean }[])[0]!.trusted;
    expect(trustedOf(good)).toBe(true);
    expect(trustedOf(bad)).toBe(false);
  });

  it("a missing listed file makes the folder untrusted", () => {
    own("b12230", { files: [{ name: "missing.dll", sha256: sha("x") }] });
    expect((llama.engineEntries(dir) as { trusted: boolean }[])[0]!.trusted).toBe(false);
  });

  it("a marker in the official folder cannot claim friday-own", () => {
    official("b12230", { origin: "friday-own" });
    const entries = llama.engineEntries(dir) as { origin: string }[];
    expect(entries.map((e) => e.origin)).toEqual(["official"]);
  });
});
