/**
 * FRIDAY · live service health monitor (one canonical prober).
 *
 * Companion to `system-monitor.cjs`: that one measures the machine, this one
 * measures FRIDAY's own moving parts — the Python kernel, the local model
 * engines, the database and the workspace root. Every field is the result of a
 * live probe on this machine; a service that cannot be reached reports
 * `state: "offline"` with the reason, never a decorative "OK".
 *
 * Exactly one interval for the whole app: renderers subscribe, the monitor
 * probes once and broadcasts `system:health` to every window.
 */
const fs = require("node:fs");
const paths = require("./friday-paths.cjs");

const PROBE_MS = 5000;
const TIMEOUT_MS = 1500;

const OLLAMA = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");

function engineProbeList(context = {}) {
  const { LOCAL_ENGINES, localEndpointCandidates } = require("./models.cjs");
  const userData =
    typeof context.userData === "function" ? context.userData() : context.userData || null;
  const probes = [{ id: "ollama", name: "Ollama", urls: [`${OLLAMA}/api/tags`] }];
  for (const [id, spec] of Object.entries(LOCAL_ENGINES || {})) {
    const path = id === "llamacpp" ? "/health" : "/v1/models";
    const endpoints = localEndpointCandidates(id, userData);
    probes.push({
      id,
      name: spec.name,
      urls: endpoints.map((endpoint) => `${endpoint}${path}`),
    });
  }
  return probes;
}

const service = (id, name, state, detail, latencyMs = null) => ({
  id,
  name,
  state, // "online" | "offline" | "degraded" | "unknown"
  detail: detail || "",
  latencyMs,
  at: Date.now(),
});

/** GET with a hard timeout. Resolves `{ ok, ms, status, error }` — never throws. */
async function probe(url, timeout = TIMEOUT_MS) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, ms: Date.now() - started, status: response.status, error: null };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      status: 0,
      error: err?.name === "AbortError" ? `no answer in ${timeout}ms` : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function kernelHealth(kernelUrl) {
  if (!kernelUrl) return service("kernel", "Python kernel", "unknown", "kernel URL not configured");
  const result = await probe(`${kernelUrl}/health`);
  return result.ok
    ? service("kernel", "Python kernel", "online", `${kernelUrl} answered`, result.ms)
    : service(
        "kernel",
        "Python kernel",
        "offline",
        result.error || `HTTP ${result.status} from ${kernelUrl}`,
        null,
      );
}

async function engineHealth(context = {}) {
  return Promise.all(
    engineProbeList(context).map(async (engine) => {
      let firstFailure = null;
      for (const url of engine.urls) {
        const result = await probe(url);
        firstFailure ||= result;
        if (result.ok) {
          return service(engine.id, engine.name, "online", `serving at ${url}`, result.ms);
        }
      }
      const result = firstFailure || { status: 0, error: "no endpoint configured" };
      return service(engine.id, engine.name, "offline", result.error || `HTTP ${result.status}`);
    }),
  );
}

/** The database and workspace root are file-system facts, not network probes. */
function storageHealth() {
  const out = [];
  const root = paths.root();
  if (!root) {
    out.push(service("workspace", "FRIDAY folder", "offline", "no FRIDAY folder selected yet"));
    out.push(service("database", "Database", "unknown", "waiting for a FRIDAY folder"));
    return out;
  }
  const verified = paths.verifyRoot(root);
  out.push(
    verified.ok
      ? service("workspace", "FRIDAY folder", "online", root)
      : service("workspace", "FRIDAY folder", "degraded", verified.error || "root not usable"),
  );
  try {
    const file = paths.databaseFile();
    const stat = fs.statSync(file);
    const mb = Math.round((stat.size / (1024 * 1024)) * 10) / 10;
    out.push(service("database", "Database", "online", `${file} · ${mb} MB`));
  } catch (err) {
    out.push(
      service("database", "Database", "offline", `not created yet (${String(err?.code || err)})`),
    );
  }
  return out;
}

/** One measured snapshot of every FRIDAY service. Never throws. */
async function sample(context = {}) {
  const [kernel, engines] = await Promise.all([
    kernelHealth(context.kernelUrl),
    engineHealth(context),
  ]);
  const services = [kernel, ...storageHealth(), ...engines];
  const offline = services.filter((s) => s.state === "offline");
  const required = services.filter((s) => s.id === "kernel" || s.id === "workspace");
  return {
    at: Date.now(),
    services,
    online: services.filter((s) => s.state === "online").length,
    total: services.length,
    // Required services decide the headline; an absent optional engine is
    // normal on a machine that only uses cloud models.
    state: required.every((s) => s.state === "online")
      ? offline.length
        ? "degraded"
        : "healthy"
      : "blocked",
  };
}

// -------------------------------------------------------------- broadcast ---
let timer = null;
let subscribers = 0;
let latest = null;
let publish = null;
let context = {};
let inFlight = null;
let sampleGeneration = 0;

function tick() {
  if (inFlight) return inFlight;
  const generation = sampleGeneration;
  inFlight = (async () => {
    try {
      const next = await sample(context);
      if (generation === sampleGeneration) {
        latest = next;
        publish?.(latest);
      }
    } catch {
      /* keep the previous snapshot — a probe failure must never crash main */
    } finally {
      inFlight = null;
      if (generation !== sampleGeneration) tick();
    }
    return latest;
  })();
  return inFlight;
}

/** Wire the broadcast channel once (main process owns `send`). */
function init(send, ctx = {}) {
  publish = (value) => send("system:health", value);
  context = { ...context, ...ctx };
}

function subscribe() {
  subscribers += 1;
  if (!timer) {
    void tick();
    timer = setInterval(() => void tick(), PROBE_MS);
    timer.unref?.();
  }
  return latest;
}

function unsubscribe() {
  subscribers = Math.max(0, subscribers - 1);
  if (subscribers === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function stop() {
  subscribers = 0;
  if (timer) clearInterval(timer);
  timer = null;
}

/** Last probe, or a fresh one when nothing is subscribed yet. */
async function snapshot() {
  if (latest && Date.now() - latest.at < PROBE_MS) return latest;
  await tick();
  if (latest && Date.now() - latest.at < PROBE_MS) return latest;
  await tick();
  return latest;
}

/** Drop the cached snapshot and probe again. Used when the kernel child exits. */
function invalidate() {
  latest = null;
  sampleGeneration += 1;
  void tick();
}

module.exports = { sample, snapshot, subscribe, unsubscribe, init, stop, invalidate, PROBE_MS };
