/**
 * Chat-engine choice between FRIDAY's own llama.cpp build (`friday-runtime-llm`) and the official one.
 *
 * A pure module: it decides, it never starts a process. The caller measures (one engine after the other, never during
 * a voice turn) and passes the runs in. The only file it touches is the bench result under `<root>/cache`.
 *
 * Rules (the same tag for both engines is required for a comparison):
 *  - the own build wins a bench only when its smoke test passed, a prefix of at least 16 greedy tokens equals the
 *    official output, and its decode speed is at least 1.05x. Both thresholds are UNVERIFIED: they are reasoned, not
 *    measured on a PC yet (exact equality of 32 tokens would fail by design for native kernels).
 *  - differing tags: the official engine is used and Doctor says the own build is outdated.
 *  - demotion of a broken folder is `orderedFolders` in llama-runtime.cjs (marker `healthy:false`); pickEngine
 *    consumes that list and an optional `isHealthy` callback, and holds no demotion rule of its own.
 *  - the idle engine is a cold standby (`-c 2048 -np 1`) unless the PC has the memory to keep it hot.
 */
const fs = require("node:fs");
const path = require("node:path");

/** UNVERIFIED thresholds: reasoned, not yet measured on the owner's PC. */
const MIN_PREFIX_TOKENS = 16;
const MIN_SPEEDUP = 1.05;
const THRESHOLDS_UNVERIFIED = true;
const BENCH_VERSION = 1;
const BENCH_FILE = path.join("cache", "llm-engine-auto.json");
const HOT_MIN_TOTAL_GB = 32;
const HOT_HEADROOM_GB = 4;
const STANDBY_ARGS = Object.freeze(["-c", "2048", "-np", "1"]);
const PREFER = ["auto", "own", "official"];
const GB = 1024 ** 3;

const finitePositive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The facts a bench depends on, normalised so the same PC always gives the same value. */
function fingerprint(facts = {}) {
  const ram = Number(facts.ramGb);
  const cores = Number(facts.cores);
  return {
    ramGb: Number.isFinite(ram) ? Math.round(ram) : null,
    cores: Number.isFinite(cores) ? Math.round(cores) : null,
    cpuModel: text(facts.cpuModel),
    gpu: text(facts.gpu),
    ownTag: text(facts.ownTag),
    officialTag: text(facts.officialTag),
  };
}

function sameFingerprint(a, b) {
  if (!a || !b) return false;
  const x = fingerprint(a);
  const y = fingerprint(b);
  return Object.keys(x).every((k) => x[k] === y[k]);
}

/** Length of the equal greedy-token prefix of two runs (0 when either has no tokens). */
function commonPrefix(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * The bench verdict from two runs `{ smokePassed, tps, tokens }`. `winner` is "own" or "official", or null with
 * `measured:false` when neither run produced a speed (nothing worth storing).
 */
function decideWinner(ownRun, officialRun) {
  const own = ownRun || {};
  const official = officialRun || {};
  const ownTps = finitePositive(own.tps) ? own.tps : null;
  const officialTps = finitePositive(official.tps) ? official.tps : null;
  const sameTokens = commonPrefix(own.tokens, official.tokens);
  const base = {
    ownTps,
    officialTps,
    sameTokens,
    speedup: null,
    measured: ownTps !== null || officialTps !== null,
  };
  if (!base.measured) return { ...base, winner: null, reason: "nothing-measured" };
  if (own.smokePassed !== true || ownTps === null)
    return { ...base, winner: "official", reason: "own-smoke-failed" };
  if (officialTps === null) return { ...base, winner: "official", reason: "official-unmeasured" };
  if (sameTokens < MIN_PREFIX_TOKENS)
    return { ...base, winner: "official", reason: "tokens-differ" };
  const speedup = ownTps / officialTps;
  if (speedup < MIN_SPEEDUP) return { ...base, speedup, winner: "official", reason: "not-faster" };
  return { ...base, speedup, winner: "own", reason: "own-faster" };
}

const benchPath = (root) => path.join(root, BENCH_FILE);

/**
 * The stored bench, or null when it is missing, broken, of another version, names an unknown winner, or was taken
 * for another fingerprint (pass `{ fingerprint }` to check it).
 */
function readBench(root, { fingerprint: current, fs: fsApi = fs } = {}) {
  if (!root) return null;
  let data;
  try {
    data = JSON.parse(fsApi.readFileSync(benchPath(root), "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.v !== BENCH_VERSION) return null;
  if (data.winner !== "own" && data.winner !== "official") return null;
  if (current && !sameFingerprint(data.fingerprint, current)) return null;
  return data;
}

/**
 * Store a bench (v1) with a temp file and a rename. A bench that measured nothing, or has no winner, is never stored.
 * Returns true when the file was written.
 */
function writeBench(root, bench, { fs: fsApi = fs, now = Date.now } = {}) {
  if (!root || !bench || (bench.winner !== "own" && bench.winner !== "official")) return false;
  if (!finitePositive(bench.ownTps) && !finitePositive(bench.officialTps)) return false;
  const record = {
    v: BENCH_VERSION,
    fingerprint: fingerprint(bench.fingerprint),
    winner: bench.winner,
    ownTps: finitePositive(bench.ownTps) ? bench.ownTps : null,
    officialTps: finitePositive(bench.officialTps) ? bench.officialTps : null,
    sameTokens: Number.isFinite(bench.sameTokens) ? bench.sameTokens : 0,
    spec: text(bench.spec) || "off",
    at: now(),
  };
  const file = benchPath(root);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    fsApi.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fsApi.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fsApi.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean */
    }
    return false;
  }
}

/** The engine kind of a folder entry: a missing or unknown origin counts as official. */
const originOf = (entry) => (entry?.marker?.origin === "friday-own" ? "own" : "official");

/**
 * Choose the engine from `orderedFolders` entries (already ordered, active first, `trusted` false for a demoted
 * marker). `isHealthy(entry)` may veto more. `bench` is a stored bench already checked against the fingerprint.
 * Returns `{ engine, entry, standby, outdated, reason }`; `engine` is null when nothing usable is installed.
 */
function pickEngine({ markers, bench, prefer = "auto", tagsEqual = true, isHealthy } = {}) {
  const usable = (Array.isArray(markers) ? markers : []).filter(
    (e) => e && e.trusted !== false && (typeof isHealthy !== "function" || isHealthy(e)),
  );
  const own = usable.find((e) => originOf(e) === "own") || null;
  const official = usable.find((e) => originOf(e) === "official") || null;
  const outdated = Boolean(own) && tagsEqual === false;
  const done = (engine, reason) => {
    const entry = engine === "own" ? own : engine === "official" ? official : null;
    const standby = engine === "own" ? official : engine === "official" ? own : null;
    return { engine, entry, standby, outdated, reason };
  };
  if (!own && !official) return done(null, "nothing-installed");
  if (!own) return done("official", "only-official");
  if (!official) return done("own", "only-own");
  const choice = PREFER.includes(prefer) ? prefer : "auto";
  if (choice === "own") return done("own", "owner-prefers-own");
  if (choice === "official") return done("official", "owner-prefers-official");
  if (outdated) return done("official", "own-outdated");
  if (bench && bench.winner === "own") return done("own", "bench-own");
  return done("official", bench ? "bench-official" : "not-benched");
}

/**
 * How the idle engine is kept: cold (started on demand with a small context) unless total RAM is at least 32 GB and
 * free RAM is above the model size plus 4 GB. The standby never carries a full context.
 */
function standbyPlan({ totalRamGb, freeRamGb, modelBytes } = {}) {
  const args = [...STANDBY_ARGS];
  const ok = [totalRamGb, freeRamGb].every(
    (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
  );
  if (!ok || !finitePositive(modelBytes)) return { mode: "cold", args, reason: "unknown-memory" };
  const needGb = modelBytes / GB + HOT_HEADROOM_GB;
  if (totalRamGb >= HOT_MIN_TOTAL_GB && freeRamGb >= needGb)
    return { mode: "hot", args, reason: "memory-free" };
  return {
    mode: "cold",
    args,
    reason: totalRamGb < HOT_MIN_TOTAL_GB ? "ram-below-32gb" : "free-ram-low",
  };
}

/**
 * The Install Manager and Doctor strings. `active` is "own" or "official"; the percent comes from the two measured
 * speeds. `outdated` is a row text only when the tags differ.
 */
function rowNames({ ownTag, officialTag, officialBackend, active, ownTps, officialTps } = {}) {
  const own = `FRIDAY Runtime LLM (own build ${text(ownTag) || "unknown"}, native)`;
  const official = `llama.cpp ${text(officialTag) || "unknown"} (official, ${text(officialBackend) || "cpu"})`;
  const gain =
    finitePositive(ownTps) && finitePositive(officialTps)
      ? Math.round((ownTps / officialTps - 1) * 100)
      : null;
  let status = null;
  if (active === "own") {
    status = `FRIDAY Runtime LLM: own active, official ready as fallback${gain !== null ? ` (own ${gain >= 0 ? "+" : ""}${gain} percent on this PC)` : ""}`;
  } else if (active === "official") {
    status = `FRIDAY Runtime LLM: official active${text(ownTag) ? ", own build kept ready" : ""}`;
  }
  const a = text(ownTag);
  const b = text(officialTag);
  const outdated = a && b && a !== b ? "own build outdated" : null;
  return { own, official, status, outdated };
}

module.exports = {
  MIN_PREFIX_TOKENS,
  MIN_SPEEDUP,
  THRESHOLDS_UNVERIFIED,
  BENCH_VERSION,
  BENCH_FILE,
  STANDBY_ARGS,
  fingerprint,
  sameFingerprint,
  commonPrefix,
  decideWinner,
  readBench,
  writeBench,
  pickEngine,
  standbyPlan,
  rowNames,
};
