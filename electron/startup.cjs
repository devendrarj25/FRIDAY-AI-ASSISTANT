/**
 * FRIDAY · startup orchestration (real verification, no simulated PASS).
 *
 * One canonical implementation of the documented start-up flow:
 *
 *   detect root → scan registered + installed capabilities → load persistent
 *   state → detect missing/unhealthy → auto-start required services → verify
 *   the real process/endpoint → retry / repair / fallback → re-verify →
 *   restore approved active resources → synchronize → final readiness check
 *
 * Every stage result comes from a live call (a real probe, a real file read, a
 * real engine start). A stage can only report `ok` when the thing it checks
 * actually answered; anything else is `warn` (degraded, FRIDAY still usable) or
 * `missing` (blocks readiness).
 *
 * Everything is injected through `ctx`, so the flow is testable without
 * Electron and there is exactly one code path for dev, packaged and installed
 * builds.
 */
const fs = require("node:fs");
const path = require("node:path");

/** Local engines FRIDAY may start on its own when they are installed.
 * Only engines with a documented zero-argument CLI belong here. llama.cpp and
 * vLLM need a model path; they join auto-start only when `engineStatus().canStart`
 * is true (exactly one matching weight on disk). An explicit services.json wins. */
const AUTOSTART_DEFAULT = ["ollama", "lmstudio", "localai"];
const SERVICE_FILE = "config/services.json";
const MAX_ATTEMPTS = 2;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Which services this machine wants started automatically.
 * `<workspace>/config/services.json` → `{ "autoStart": ["ollama", "lmstudio", "localai"] }`.
 * Missing file = the documented default; an explicit empty array disables
 * auto-start entirely (the owner's choice is always respected).
 */
function readServiceConfig(workspaceRoot) {
  const fallback = { autoStart: [...AUTOSTART_DEFAULT], source: "default" };
  if (!workspaceRoot) return fallback;
  const parsed = readJson(path.join(workspaceRoot, SERVICE_FILE));
  if (!parsed || !Array.isArray(parsed.autoStart)) return fallback;
  return { autoStart: parsed.autoStart.map(String), source: SERVICE_FILE };
}

/**
 * Bring one service up for real.
 *
 * running → nothing to do. Not running → start, then re-probe. A start that
 * did not make the endpoint answer is retried once (repair pass) before the
 * service is reported unavailable with the real reason.
 */
async function ensureService(id, ctx) {
  const { engines, startEngine, log } = ctx;
  const known = engines.find((e) => e.id === id);
  if (!known) {
    return { id, name: id, state: "unknown", detail: `no engine named "${id}"`, attempts: 0 };
  }
  if (known.running) {
    return { id, name: known.name, state: "running", detail: "already answering", attempts: 0 };
  }
  if (!known.canStart) {
    return {
      id,
      name: known.name,
      state: "unavailable",
      detail: known.hint || "this engine must be started manually",
      attempts: 0,
    };
  }

  let last = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let result;
    try {
      result = await startEngine(id);
    } catch (error) {
      result = { ok: false, error: String(error?.message || error) };
    }
    if (result?.ok) {
      return {
        id,
        name: known.name,
        state: attempt === 1 ? "started" : "repaired",
        detail: result.detail || "endpoint verified",
        attempts: attempt,
      };
    }
    last = result?.error || "start failed";
    log?.(`startup: ${id} start attempt ${attempt} failed — ${last}`);
  }
  return { id, name: known.name, state: "unavailable", detail: last, attempts: MAX_ATTEMPTS };
}

/**
 * Final readiness. FRIDAY is READY when everything *required* to use her is
 * real: a workspace on disk and a responding kernel. A missing local engine or
 * a machine with no model configured is `degraded` — usable, honestly flagged —
 * never a silent green light.
 */
function evaluateReadiness(report) {
  const blockers = [];
  const warnings = [];
  if (!report.workspaceRoot) blockers.push("no FRIDAY folder selected");
  else if (!report.workspaceExists)
    blockers.push(`workspace missing on disk: ${report.workspaceRoot}`);
  if (!report.kernelAlive) blockers.push("kernel is not responding");

  for (const service of report.services || []) {
    if (service.state === "unavailable" || service.state === "unknown") {
      warnings.push(`${service.name}: ${service.detail}`);
    }
  }
  if (!report.modelsAvailable) warnings.push("no model is routable yet — add one in Models");
  if (!report.capabilityCount) warnings.push("no capabilities discovered in this workspace");

  return {
    ready: blockers.length === 0,
    state: blockers.length ? "blocked" : warnings.length ? "degraded" : "ready",
    blockers,
    warnings,
  };
}

/**
 * Run the whole flow once. Never throws: a stage that fails is reported and
 * the flow continues, because a broken probe must not stop FRIDAY from
 * starting.
 */
async function runStartupFlow(ctx) {
  const boot = ctx.boot || (() => {});
  const log = ctx.log || (() => {});
  const started = Date.now();
  const workspaceRoot = ctx.workspaceRoot || null;
  const workspaceExists = Boolean(workspaceRoot && fs.existsSync(workspaceRoot));

  // ---- 1. scan every registered + installed capability -------------------
  let capabilities = { items: [], counts: {} };
  try {
    capabilities = (await ctx.listCapabilities()) || capabilities;
  } catch (error) {
    log(`startup: capability scan failed — ${error?.message || error}`);
  }
  const enabled = capabilities.items.filter((item) => item.enabled);
  boot(
    "Scanning capabilities",
    capabilities.items.length ? "ok" : "warn",
    `${enabled.length}/${capabilities.items.length} enabled · ${Object.keys(capabilities.counts || {}).length} trees`,
  );

  // ---- 2. persistent state ------------------------------------------------
  const persisted = {
    settings: workspaceExists && fs.existsSync(path.join(workspaceRoot, "config")),
    memory: workspaceExists && fs.existsSync(path.join(workspaceRoot, "memory")),
    database: workspaceExists && fs.existsSync(path.join(workspaceRoot, "database")),
  };
  const loaded = Object.entries(persisted)
    .filter(([, present]) => present)
    .map(([key]) => key);
  boot(
    "Loading persistent state",
    loaded.length === 3 ? "ok" : workspaceExists ? "warn" : "missing",
    loaded.length ? loaded.join(", ") : "nothing to restore yet",
  );

  // ---- 3/4. detect unhealthy services and start what is required ----------
  let engines = [];
  try {
    engines = (await ctx.engineStatus()) || [];
  } catch (error) {
    log(`startup: engine status failed — ${error?.message || error}`);
  }
  const config = readServiceConfig(workspaceRoot);
  // With no explicit owner config, every local engine this machine actually has
  // installed and can start is brought up, so models are warm and selectable
  // without the owner starting anything by hand.
  const wanted =
    config.source === "default"
      ? engines.filter((engine) => engine.canStart).map((engine) => engine.id)
      : config.autoStart.filter((id) => engines.some((e) => e.id === id));

  const services = [];
  for (const id of wanted) {
    services.push(await ensureService(id, { engines, startEngine: ctx.startEngine, log }));
  }
  const up = services.filter((s) => s.state !== "unavailable" && s.state !== "unknown");
  if (services.length) {
    boot(
      "Starting local services",
      up.length === services.length ? "ok" : up.length ? "warn" : "warn",
      services.map((s) => `${s.name}: ${s.state}`).join(", "),
    );
  }

  // ---- 5. verify the kernel really answers --------------------------------
  let kernelAlive = false;
  try {
    kernelAlive = Boolean(await ctx.kernelAlive());
  } catch {
    kernelAlive = false;
  }
  boot(
    "Verifying kernel",
    kernelAlive ? "ok" : "missing",
    kernelAlive ? "health check passed" : "no /health response",
  );

  // ---- 6. models actually routable right now ------------------------------
  // A service that was started a moment ago (step 3/4) usually needs a few
  // seconds before it lists its models. Probing once would report "no models"
  // on every cold boot, so when a service was just brought up the probe is
  // retried a bounded number of times before FRIDAY calls the catalogue empty.
  let modelsAvailable = 0;
  const justStarted = services.some((s) => s.state === "started" || s.state === "repaired");
  const attempts = justStarted ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      modelsAvailable = (await ctx.routableModels()) || 0;
    } catch (error) {
      log(`startup: model probe failed — ${error?.message || error}`);
    }
    if (modelsAvailable) break;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  boot(
    "Restoring models",
    modelsAvailable ? "ok" : "warn",
    modelsAvailable ? `${modelsAvailable} routable` : "none routable yet",
  );

  // ---- 7. final readiness -------------------------------------------------
  const report = {
    at: Date.now(),
    ms: Date.now() - started,
    workspaceRoot,
    workspaceExists,
    persisted,
    capabilityCount: capabilities.items.length,
    capabilityEnabled: enabled.length,
    counts: capabilities.counts || {},
    services,
    serviceSource: config.source,
    kernelAlive,
    modelsAvailable,
  };
  const readiness = evaluateReadiness({ ...report, modelsAvailable: modelsAvailable > 0 });
  boot(
    "FRIDAY ready",
    readiness.ready ? "ok" : "missing",
    readiness.ready
      ? readiness.warnings.length
        ? `active · ${readiness.warnings.length} note(s)`
        : "all required subsystems verified"
      : readiness.blockers.join("; "),
  );

  return { ...report, ...readiness };
}

module.exports = {
  AUTOSTART_DEFAULT,
  readServiceConfig,
  ensureService,
  evaluateReadiness,
  runStartupFlow,
};
