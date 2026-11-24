/**
 * FRIDAY · desktop speech-to-text
 *
 * The renderer's Web Speech API only works in Chromium with a live connection
 * to Google's servers — inside the packaged EXE that is neither private nor
 * reliable. This module runs REAL on-device transcription through
 * kernel/stt.py (faster-whisper) using the same shared Python resolver every
 * other Python feature uses.
 *
 * A persistent `--serve` worker keeps WhisperModel loaded across utterances.
 * One-shot `--probe` / `--audio` remain for cheap import checks and tests.
 * One request is still one utterance file. Lines marked `stream` are partial
 * text from that same worker and do not finish the request.
 *
 * Contract:
 *   · audio bytes are written to the FRIDAY root cache and deleted afterwards
 *   · nothing is faked — a missing dependency is reported, not silently empty
 *   · Auto Mode can require the local engine so it remains fully offline
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { killProcessTree, trackOwned } = require("./app-lifecycle.cjs");
const paths = require("./friday-paths.cjs");
const { parseJsonLine } = require("./json-line.cjs");
const { resolvePython } = require("./python.cjs");
const { boundedInit, fetchCompat } = require("./net-fetch.cjs");
// The credential store is owned by models.cjs — read it, never duplicate it.
const modelsApi = require("./models.cjs");

function whisperLanguage(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!value || value === "auto" || value === "mixed") return "";
  if (/^(hi|en)(-|$)/.test(value)) return "";
  const iso = value.slice(0, 2);
  return /^[a-z]{2}$/.test(iso) ? iso : "";
}

const SCRIPT = path.join(__dirname, "..", "kernel", "stt.py");
const MODELS = ["tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"];
const DEFAULT_MODEL = "small";
const crashTimes = [];
const CRASH_WINDOW_MS = 60000;
const CRASH_LIMIT = 3;

function recordSttCrash(now = Date.now()) {
  crashTimes.push(now);
  const recent = crashTimes.filter((at) => now - at < CRASH_WINDOW_MS);
  crashTimes.length = 0;
  crashTimes.push(...recent);
  return recent.length >= CRASH_LIMIT;
}

/**
 * Cloud transcription fallback.
 *
 * faster-whisper needs Python plus a model download, so a fresh machine has
 * no on-device transcriber and the microphone would be dead. When the owner
 * has already connected a provider that exposes the OpenAI-compatible
 * /audio/transcriptions endpoint, that provider is used instead — same stored
 * key, same endpoint override, no new credential store.
 */
const CLOUD_STT = [
  { id: "openai", model: "gpt-4o-transcribe" },
  { id: "groq", model: "whisper-large-v3" },
];

function cloudEngine() {
  const root = paths.root();
  if (!root) return null;
  let keys = {};
  try {
    keys = modelsApi.readKeys(root) || {};
  } catch {
    keys = {};
  }
  for (const entry of CLOUD_STT) {
    const key = keys[entry.id] || process.env[modelsApi.CLOUD?.[entry.id]?.env || ""] || null;
    if (!key) continue;
    const urls = modelsApi.resolveEndpoints(root, entry.id);
    const base = urls?.base;
    if (!base) continue;
    return { id: entry.id, model: entry.model, base, key };
  }
  return null;
}

async function cloudTranscribe(engine, file, language) {
  const form = new FormData();
  const bytes = fs.readFileSync(file);
  form.append("file", new Blob([bytes]), path.basename(file));
  form.append("model", engine.model);
  const locked = whisperLanguage(language);
  if (locked) form.append("language", locked);
  const started = Date.now();
  // A long recording takes a while to upload, but not forever: the whole call is bounded.
  const bounded = boundedInit(
    { method: "POST", headers: { Authorization: `Bearer ${engine.key}` }, body: form },
    120_000,
  );
  let res;
  let body;
  try {
    res = await fetchCompat(`${engine.base}/audio/transcriptions`, bounded.init);
    body = await res.text();
  } finally {
    bounded.clear();
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: "engine-failed",
      error: `HTTP ${res.status} — ${body.slice(-300)}`,
    };
  }
  let text = "";
  try {
    text = String(JSON.parse(body)?.text || "");
  } catch {
    text = body.trim();
  }
  return {
    ok: true,
    text,
    language: language || "",
    model: engine.model,
    elapsedMs: Date.now() - started,
    engine: `cloud:${engine.id}`,
  };
}

let cachedStatus = null;
let installing = null;

/**
 * One transcription runs at a time (the worker holds a single model). A second one used to be refused at once
 * with "busy", and the utterance it carried was lost: a short follow-up spoken while the last turn was still being
 * transcribed, or a wake probe that overlapped a turn. Now it waits its turn, in order. Only a real backlog (more
 * than `maxWaiting` waiting, or a wait longer than `waitMs`) is refused, and the caller still gets the same
 * "busy" answer it always handled.
 */
function createTurnGate({
  maxWaiting = 2,
  waitMs = 25_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let running = false;
  const queue = [];
  function leave() {
    const next = queue.shift();
    if (next) {
      clearTimer(next.timer);
      next.resolve(once(leave));
    } else {
      running = false;
    }
  }
  function once(fn) {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      fn();
    };
  }
  return {
    /** Resolves to a release function, or null when the backlog is full or the wait ran out. */
    enter() {
      if (!running) {
        running = true;
        return Promise.resolve(once(leave));
      }
      if (queue.length >= maxWaiting) return Promise.resolve(null);
      return new Promise((resolve) => {
        const entry = { resolve, timer: null };
        entry.timer = setTimer(() => {
          const at = queue.indexOf(entry);
          if (at >= 0) queue.splice(at, 1);
          resolve(null);
        }, waitMs);
        if (entry.timer && typeof entry.timer.unref === "function") entry.timer.unref();
        queue.push(entry);
      });
    },
    /**
     * For a provisional (speculative) decode: the gate only when it is free right now, never a place in the line.
     * A speculative read that waited would take the place of a final one, or run after it for nothing.
     */
    tryEnter() {
      if (running) return null;
      running = true;
      return once(leave);
    },
    waiting: () => queue.length,
    busy: () => running,
  };
}
const turnGate = createTurnGate();
let worker = null;
let workerSeq = 0;
let workerGeneration = 0;
let lastLocalLayers = {
  dependency: "missing",
  worker: "stopped",
  inference: "unverified",
  loadCount: 0,
  model: DEFAULT_MODEL,
  reason: null,
  moonshineReady: false,
  windowsSpeech: false,
  cudaRuntimeReady: false,
};

/** What the speech worker last said it holds (models, load times, idle time, unloads, memory, fallbacks). */
let lastWorkerCache = null;

const finiteOrNull = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The cache fields of a worker `status` answer, trimmed to plain values for the Voice Diagnostics rows. Null when the
 * answer carries none (an older worker): the rows then say so instead of showing zeros.
 */
function workerCacheOf(ping) {
  if (!ping || typeof ping !== "object" || !Array.isArray(ping.loadedModels)) return null;
  const level = String(ping.memory?.level || "");
  const byKind = {};
  for (const [kind, count] of Object.entries(ping.fallbacks?.byKind || {}).slice(0, 16)) {
    if (finiteOrNull(count) !== null) byKind[String(kind).slice(0, 40)] = count;
  }
  return {
    loadedModels: ping.loadedModels.slice(0, 8).map((row) => ({
      name: String(row?.name || "").slice(0, 80),
      engine: String(row?.engine || "").slice(0, 24),
      loadMs: finiteOrNull(row?.loadMs),
    })),
    idleSec: finiteOrNull(ping.idleSec),
    unloadCount: finiteOrNull(ping.unloadCount) ?? 0,
    memory: {
      level: level === "high" || level === "critical" ? level : "ok",
      known: ping.memory?.known === true,
      availableMb: finiteOrNull(ping.memory?.availableMb),
      totalMb: finiteOrNull(ping.memory?.totalMb),
    },
    fallbacks: { total: finiteOrNull(ping.fallbacks?.total) ?? 0, byKind },
  };
}

function noteWorkerCache(ping) {
  const cache = workerCacheOf(ping);
  if (cache) lastWorkerCache = cache;
}

function copyLadder(parsed) {
  if (!parsed || typeof parsed !== "object") return;
  // The kernel's own verdict (kernel/stt.py cuda_runtime_ready: cuBLAS 12 and cuDNN 9 found), never a driver reading.
  if (typeof parsed.cudaRuntimeReady === "boolean")
    lastLocalLayers.cudaRuntimeReady = parsed.cudaRuntimeReady;
  if (typeof parsed.moonshineReady === "boolean")
    lastLocalLayers.moonshineReady = parsed.moonshineReady;
  if (typeof parsed.windowsSpeech === "boolean")
    lastLocalLayers.windowsSpeech = parsed.windowsSpeech;
}

function scriptPath() {
  if (fs.existsSync(SCRIPT)) return SCRIPT;
  const packaged = path.join(process.resourcesPath || "", "kernel", "stt.py");
  return fs.existsSync(packaged) ? packaged : SCRIPT;
}

function audioDir() {
  const dir = path.join(paths.ensureDir("cache"), "stt-in");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* reported by the write that follows */
  }
  return dir;
}

function run(exe, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      {
        timeout,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        // Never the program folder: a child that stands in it keeps it alive after an uninstall.
        cwd: os.tmpdir(),
        env: { ...process.env, FRIDAY_ROOT: paths.root() || process.env.FRIDAY_ROOT || "" },
      },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: stdout || "",
          stderr: stderr || String(error?.message || ""),
        }),
    );
  });
}

async function python() {
  const found = await resolvePython();
  return found ? [found.exe, found.prefix || []] : null;
}

const parse = parseJsonLine;

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") {
      killProcessTree(child.pid);
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

function rejectPending(session, error) {
  for (const wait of session.pending.values()) {
    try {
      wait.reject(error);
    } catch {
      /* already settled */
    }
  }
  session.pending.clear();
}

function attachWorker(child, generation) {
  const session = {
    child,
    generation,
    alive: true,
    loaded: false,
    modelName: null,
    loadCount: 0,
    buf: "",
    pending: new Map(),
    intentional: false,
    err: "",
    // A worker that has not been asked anything yet is new, not idle (releaseIdle).
    lastUsedAt: Date.now(),
  };
  child.stderr?.on("data", (chunk) => {
    session.err += String(chunk);
    if (session.err.length > 4000) session.err = session.err.slice(-2000);
  });
  child.stdout?.on("data", (chunk) => {
    session.buf += String(chunk);
    const lines = session.buf.split(/\r?\n/);
    session.buf = lines.pop() || "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      const id = msg && msg.id;
      if (id != null && session.pending.has(id)) {
        if (msg.stream) {
          const wait = session.pending.get(id);
          if (typeof wait.onStream === "function") wait.onStream(msg);
          continue;
        }
        const wait = session.pending.get(id);
        session.pending.delete(id);
        wait.resolve(msg);
      }
    }
  });
  const fail = (why) => {
    if (!session.alive) return;
    session.alive = false;
    if (session.intentional) {
      lastLocalLayers.worker = "stopped";
      lastLocalLayers.inference = "unverified";
      rejectPending(session, new Error("STT worker shutting down"));
      if (worker && worker.generation === generation) worker = null;
      return;
    }
    lastLocalLayers.worker = "crashed";
    lastLocalLayers.inference = "failed";
    lastLocalLayers.reason = session.err ? `${why} — ${session.err.slice(-400)}` : why;
    cachedStatus = null;
    rejectPending(session, new Error(why));
    if (worker && worker.generation === generation) worker = null;
  };
  child.on("error", (error) => fail(String(error?.message || error)));
  child.on("close", () => fail("STT worker exited"));
  child.stdin?.on("error", (error) => fail(String(error?.message || error)));
  return session;
}

function workerRequest(session, payload, timeoutMs, onStream) {
  const id = ++workerSeq;
  if (session) session.lastUsedAt = Date.now();
  return new Promise((resolve, reject) => {
    if (!session?.alive || !session.child?.stdin || session.child.stdin.destroyed) {
      reject(new Error("STT worker is not running"));
      return;
    }
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error("STT worker timed out"));
      // A worker that missed its deadline is hung. Callers drop their reference and start a fresh worker, so
      // without this the hung process stayed alive for the whole session with its model in memory, and every
      // timeout left one more behind. The process exit then clears the rest of its pending requests.
      killTree(session.child);
    }, timeoutMs);
    session.pending.set(id, {
      onStream: typeof onStream === "function" ? onStream : null,
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      session.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    } catch (error) {
      session.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function prepareWeights(model, onEvent) {
  // Weights the build already downloaded are being moved into this root: wait
  // for that instead of fetching the same model a second time.
  await require("./staged-assets.cjs").whenIdle();
  const weights = require("./voice-weights.cjs");
  return weights.ensureSttWeights(model, paths.root() || "", {
    exists: (file) => fs.existsSync(file),
    downloadModel: require("./model-download.cjs").downloadModel,
    verify: "size",
    onEvent,
  });
}

/**
 * Progress for any speech download, as one event shape for the whole app (the window draws a bar from it).
 * The sink is set once by the main process; a missing sink drops the event and nothing else changes.
 */
let progressSink = null;
function setProgressSink(sink) {
  progressSink = typeof sink === "function" ? sink : null;
}
function reportProgress(payload) {
  try {
    progressSink?.(payload);
  } catch {
    /* progress is a view, never a reason to stop a download */
  }
}

/** A download event from the model downloader, as the bar needs it. */
function downloadReporter(size, label) {
  return (event) => {
    const raw = String(event?.status || "");
    if (!raw || raw === "already on disk") return;
    reportProgress({
      stage: "download",
      model: size,
      status: label,
      progress: typeof event?.progress === "number" ? Math.round(event.progress) : null,
      gbDone: typeof event?.gbDone === "number" ? event.gbDone : null,
      gbTotal: typeof event?.gbTotal === "number" ? event.gbTotal : null,
      speedMbps: typeof event?.speedMbps === "number" ? event.speedMbps : null,
      etaSeconds: typeof event?.etaSeconds === "number" ? event.etaSeconds : null,
      host: String(event?.host || ""),
    });
  };
}

/** The listening language the last real request named (a warm-up or a turn). A preview sends none and keeps it. */
let listeningPref = "";

function noteListeningPref(req) {
  const pref = String(req?.speechPref || req?.speech_pref || "").trim();
  if (pref) listeningPref = pref.slice(0, 32);
}

/**
 * Which small sizes are on disk, so the first choice is one that needs no download, and what this PC and the
 * listening language allow (memory, language) so Auto picks a size that fits instead of always small.
 */
function cachedSizes() {
  const have = require("./voice-weights.cjs").installedSizes(paths.root() || "", (file) =>
    fs.existsSync(file),
  );
  return {
    baseCached: have.includes("base"),
    smallCached: have.includes("small"),
    ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    language: listeningPref,
  };
}

const backgroundFetches = new Map();
const failedFetches = new Map();
const FETCH_RETRY_MS = 10 * 60 * 1000;

/**
 * Fetch a size that is not on disk while listening carries on with one that is. One fetch per size at
 * a time; a failed one is not started again for ten minutes, so a bad line does not retry on every word.
 */
function fetchInBackground(size) {
  if (backgroundFetches.has(size)) return backgroundFetches.get(size);
  if (Date.now() - (failedFetches.get(size) || 0) < FETCH_RETRY_MS) return null;
  const job = prepareWeights(size, downloadReporter(size, `Downloading speech model ${size}`))
    .then((result) => {
      if (result?.ok) {
        failedFetches.delete(size);
        reportProgress({
          stage: "ready",
          model: size,
          status: `Speech model ${size} is ready`,
          progress: 100,
        });
      } else {
        failedFetches.set(size, Date.now());
        reportProgress({
          stage: "failed",
          model: size,
          status: `Speech model ${size} did not download`,
          progress: null,
          error: String(result?.error || "").slice(0, 200),
        });
      }
      return result;
    })
    .catch((error) => {
      failedFetches.set(size, Date.now());
      return { ok: false, error: String(error?.message || error) };
    })
    .finally(() => backgroundFetches.delete(size));
  backgroundFetches.set(size, job);
  return job;
}

/**
 * Which weights to open for a request: the size asked for when it is on disk, otherwise the nearest size
 * that is (listening never waits on a download while any speech model is installed) and the asked-for
 * size is fetched in the background. Only a PC with no speech model at all waits for a download.
 */
async function chooseWeights(wanted, onEvent) {
  await require("./staged-assets.cjs").whenIdle();
  const weights = require("./voice-weights.cjs");
  const root = paths.root() || "";
  const have = weights.installedSizes(root, (file) => fs.existsSync(file));
  if (have.includes(wanted)) return { ...(await prepareWeights(wanted, onEvent)), size: wanted };
  const stand = weights.nearestInstalled(wanted, have);
  if (stand) {
    void fetchInBackground(wanted);
    return {
      ok: true,
      dir: path.join(root, "cache", "stt", stand),
      size: stand,
      substituted: wanted,
      downloaded: false,
    };
  }
  return {
    ...(await prepareWeights(
      wanted,
      onEvent || downloadReporter(wanted, "Downloading speech model, first time only"),
    )),
    size: wanted,
  };
}

// The resource governor's load leases (electron/load-lease.cjs). Absent: the worker loads exactly as it always did.
let loadLeases = null;
let speechHeld = null;
/** The most the speech worker waits for the governor's answer before it loads as before (ms). */
const SPEECH_LEASE_BOUND_MS = 400;
function setLoadLeases(api) {
  loadLeases = api && typeof api.acquire === "function" ? api : null;
}

/** Speech sizes the PC could load for `wanted`: itself first, then smaller installed ones, each with its weight memory. */
function speechLoadOptions(wanted) {
  const weights = require("./voice-weights.cjs");
  const have = new Set(weights.installedSizes(paths.root() || "", (file) => fs.existsSync(file)));
  const at = weights.SIZE_ORDER.indexOf(wanted);
  const sizes = [wanted, ...weights.SIZE_ORDER.slice(0, Math.max(0, at)).reverse()].filter(
    (size, index) => index === 0 || have.has(size),
  );
  const onGpu = process.env.FRIDAY_STT_CUDA === "1";
  return sizes
    .map((size) => ({
      size,
      need: Number(weights.manifestOf(weights.STT_CATALOG[size])?.minRamGb) || 0,
    }))
    .filter((row) => row.need > 0)
    .map((row) => ({
      size: row.size,
      option: { [onGpu ? "vramGb" : "ramGb"]: row.need, hint: row.size },
    }));
}

/**
 * Ask the governor for the speech worker's memory before it loads, as the voice priority. Resolves the size to load
 * (a smaller installed one when `wanted` does not fit) and `done` / `fail` for the caller to settle the lease. The
 * lease stays held while the worker lives (its `alive` check lets the governor drop it when the worker is gone).
 * Voice is never blocked: a refusal loads the smallest installed size anyway, and the owner already has the reason.
 */
async function leaseSpeechLoad(wanted) {
  const plain = { size: wanted, done() {}, fail() {}, release() {} };
  try {
    const rows = speechLoadOptions(wanted);
    if (!rows.length) return plain;
    const holder = { loading: true };
    const asked = loadLeases.acquire({
      owner: "speech-worker",
      kind: "speech",
      priority: "voice",
      label: "The speech model",
      options: rows.map((row) => row.option),
      alive: () => holder.loading || Boolean(worker?.alive),
    });
    // Voice never waits long for the governor: past the bound the worker loads as before, and a lease that lands
    // afterwards is handed back, since no worker holds it.
    let timer = null;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), SPEECH_LEASE_BOUND_MS);
      timer.unref?.();
    });
    const taken = await Promise.race([Promise.resolve(asked), late]);
    clearTimeout(timer);
    if (!taken) {
      Promise.resolve(asked).then(
        (after) => {
          try {
            after?.lease?.release?.();
          } catch {
            /* already gone */
          }
        },
        () => {},
      );
      return plain;
    }
    if (taken.state === "refused") return { ...plain, size: rows[rows.length - 1].size };
    if (taken.state !== "granted") return plain;
    const size = rows.find((row) => row.size === taken.hint)?.size ?? wanted;
    const giveBack = () => {
      holder.loading = false;
      taken.lease.release();
    };
    return {
      size,
      done() {
        holder.loading = false;
        taken.lease.loaded?.();
      },
      fail: giveBack,
      // The worker is gone (closed for memory, muted, shut down): its lease goes back with it.
      release: giveBack,
    };
  } catch {
    return plain;
  }
}

/** The load itself runs in the governor's one-at-a-time model-load slot; voice never gives up waiting for it. */
async function guardedLoad(run) {
  if (!loadLeases) return run();
  const slot = await loadLeases.runLoad("voice", run);
  return slot.ran ? slot.value : run();
}

async function ensureWorker(model, onEvent, options = {}) {
  const wanted = MODELS.includes(model) ? model : DEFAULT_MODEL;
  const resident =
    worker?.alive && worker.loaded && (worker.modelName === wanted || worker.leasedFor === wanted);
  if (!loadLeases || options.load === false || resident) return loadWorker(model, onEvent, options);
  // One lease per resident worker: the one it holds is replaced, never stacked.
  speechHeld?.fail();
  const held = await leaseSpeechLoad(wanted);
  speechHeld = held;
  try {
    const session = await loadWorker(held.size, onEvent, options);
    // Only a worker that got the size it asked for counts as already leased for it; a smaller one asks again later.
    if (session && held.size === wanted) session.leasedFor = wanted;
    return session;
  } catch (error) {
    held.fail();
    throw error;
  } finally {
    held.done();
  }
}

async function loadWorker(model, onEvent, options = {}) {
  let wanted = MODELS.includes(model) ? model : DEFAULT_MODEL;
  const loadModel = options.load !== false;
  let modelPath = "";
  if (loadModel) {
    const prepared = await chooseWeights(wanted, onEvent);
    if (!prepared.ok) throw new Error(prepared.error || "speech weights are not on disk");
    modelPath = prepared.dir;
    if (prepared.size) wanted = prepared.size;
  }
  if (worker?.alive) {
    if (!loadModel) return worker;
    if (worker.modelName && worker.modelName !== wanted) {
      const loaded = await guardedLoad(() =>
        workerRequest(worker, { op: "load", model: wanted, model_path: modelPath }, 180000),
      );
      if (!loaded?.ok) throw new Error(loaded?.error || "STT model reload failed");
      worker.loaded = true;
      worker.modelName = wanted;
      worker.modelPath = modelPath;
      worker.loadCount = loaded.loadCount || worker.loadCount;
      lastLocalLayers = {
        dependency: "ready",
        worker: "ready",
        inference: "verified",
        loadCount: worker.loadCount,
        model: wanted,
        reason: null,
        moonshineReady: Boolean(lastLocalLayers.moonshineReady),
        windowsSpeech: Boolean(lastLocalLayers.windowsSpeech),
        cudaRuntimeReady: Boolean(lastLocalLayers.cudaRuntimeReady),
      };
    }
    return worker;
  }
  const py = await python();
  if (!py) throw new Error("Python 3.12+ was not found — install it from Install Manager.");
  const generation = ++workerGeneration;
  const child = spawn(py[0], [...py[1], scriptPath(), "--serve"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // The worker and everything it starts (the Windows speech probe included) must not stand in the program folder.
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      FRIDAY_ROOT: paths.root() || process.env.FRIDAY_ROOT || "",
      FRIDAY_STT_TIER: "auto",
      FRIDAY_RAM_GB: String(Math.round((os.totalmem() / 1024 ** 3) * 10) / 10),
    },
  });
  trackOwned("stt", child, py[0]);
  const session = attachWorker(child, generation);
  worker = session;
  lastLocalLayers.worker = "ready";
  const ping = await workerRequest(session, { op: "status" }, 30000);
  copyLadder(ping);
  noteWorkerCache(ping);
  if (ping?.dependency === "missing" || ping?.available === false) {
    lastLocalLayers.dependency = "missing";
    lastLocalLayers.reason = ping?.error || "faster-whisper is not installed yet.";
    if (!(lastLocalLayers.moonshineReady || lastLocalLayers.windowsSpeech) || loadModel) {
      throw new Error(lastLocalLayers.reason);
    }
    session.loaded = false;
    return session;
  }
  if (!loadModel) return session;
  lastLocalLayers.dependency = "ready";
  const loaded = await guardedLoad(() =>
    workerRequest(session, { op: "load", model: wanted, model_path: modelPath }, 180000),
  );
  if (!loaded?.ok) {
    lastLocalLayers.inference = "failed";
    lastLocalLayers.reason = loaded?.error || "STT model failed to load";
    throw new Error(lastLocalLayers.reason);
  }
  session.loaded = true;
  session.modelName = wanted;
  session.modelPath = modelPath;
  session.loadCount = loaded.loadCount || 1;
  lastLocalLayers = {
    dependency: "ready",
    worker: "ready",
    inference: "verified",
    loadCount: session.loadCount,
    model: wanted,
    reason: null,
    moonshineReady: Boolean(lastLocalLayers.moonshineReady),
    windowsSpeech: Boolean(lastLocalLayers.windowsSpeech),
    cudaRuntimeReady: Boolean(lastLocalLayers.cudaRuntimeReady),
  };
  return session;
}

function snapshotStatus({ localOnly, py, probeReason, pythonPath }) {
  const layers = { ...lastLocalLayers };
  const localReady = layers.dependency === "ready" && layers.inference === "verified";
  let value;
  if (localReady) {
    value = {
      available: true,
      ready: true,
      engine: "faster-whisper",
      model: layers.model,
      python: pythonPath,
      dependency: layers.dependency,
      worker: layers.worker,
      inference: layers.inference,
      loadCount: layers.loadCount,
      reason: null,
    };
  } else if (layers.dependency === "ready") {
    value = {
      available: true,
      ready: false,
      engine: "faster-whisper",
      model: layers.model,
      python: pythonPath,
      dependency: layers.dependency,
      worker: layers.worker,
      inference: layers.inference,
      loadCount: layers.loadCount,
      reason: layers.reason,
    };
  } else {
    value = {
      available: false,
      ready: false,
      engine: "faster-whisper",
      python: pythonPath,
      dependency: layers.dependency,
      worker: layers.worker,
      inference: layers.inference,
      loadCount: layers.loadCount,
      reason: layers.reason || probeReason || "faster-whisper is not installed yet.",
    };
  }
  value.moonshineReady = Boolean(layers.moonshineReady);
  value.windowsSpeech = Boolean(layers.windowsSpeech);
  value.cudaRuntimeReady = Boolean(layers.cudaRuntimeReady);
  value.cache = worker?.alive ? lastWorkerCache : null;
  if (!value.available && (value.moonshineReady || value.windowsSpeech)) {
    value.available = true;
    value.ready = false;
    value.engine = value.moonshineReady ? "moonshine" : "windows-speech";
  }
  if (!value.available && !localOnly) {
    const engine = cloudEngine();
    if (engine) {
      value = {
        ...value,
        available: true,
        ready: true,
        engine: `cloud:${engine.id}`,
        model: engine.model,
        reason: value.reason,
        moonshineReady: Boolean(layers.moonshineReady),
        windowsSpeech: Boolean(layers.windowsSpeech),
      };
    }
  }
  if (py && !pythonPath) value.python = py[0];
  return value;
}

/** Can FRIDAY transcribe on this machine right now? Cached — this may spawn. */
async function status(force = false, options = {}) {
  const localOnly = Boolean(options?.localOnly);
  const warm = Boolean(options?.warm);
  if (
    cachedStatus &&
    !force &&
    !warm &&
    Date.now() - cachedStatus.at < 60000 &&
    (!localOnly || cachedStatus.value.engine === "faster-whisper")
  )
    return cachedStatus.value;

  const py = await python();
  if (!py) {
    const whisperApi = require("./whisper-cpp.cjs");
    const layout = require("./runtime-layout.cjs");
    const runtimeRoot = paths.hasRoot() ? paths.dir("runtime") : "";
    const packRoots = layout.resourceRoots({
      resourcesPath: process.resourcesPath,
      devRoot: path.join(__dirname, ".."),
      execPath: process.execPath,
    });
    if (
      runtimeRoot &&
      (layout.findPack("whisper-cpp", packRoots) || layout.findPack("ggml-base", packRoots))
    ) {
      try {
        require("./bundled-runtime.cjs").materialise({
          resourcesRoots: packRoots,
          runtimeRoot,
          ids: ["whisper-cpp", "ggml-base"],
          prove: false,
        });
      } catch {
        /* a missing pack stays a missing engine */
      }
    }
    const whisper = whisperApi.locateFrom([runtimeRoot, paths.root(), process.resourcesPath]);
    if (whisper) {
      const value = {
        available: true,
        ready: false,
        engine: "whisper.cpp",
        model: "base",
        python: null,
        dependency: "ready",
        worker: "stopped",
        inference: "unverified",
        loadCount: 0,
        reason:
          "whisper.cpp is on disk. Listening still needs a wav capture; this build does not mark it ready.",
      };
      if (!localOnly) cachedStatus = { at: Date.now(), value };
      return value;
    }
    lastLocalLayers = {
      dependency: "missing",
      worker: worker?.alive ? lastLocalLayers.worker : "stopped",
      inference: "unverified",
      loadCount: lastLocalLayers.loadCount || 0,
      model: DEFAULT_MODEL,
      reason: require("./voice-install.cjs").explain("no-python"),
      moonshineReady: false,
      windowsSpeech: false,
      cudaRuntimeReady: false,
    };
    const value = snapshotStatus({ localOnly, py: null, pythonPath: null });
    if (!localOnly) cachedStatus = { at: Date.now(), value };
    return value;
  }

  if (warm) {
    try {
      const voiceInstall = require("./voice-install.cjs");
      const boot = voiceInstall.bootModel({ requested: "auto", ...cachedSizes() });
      await ensureWorker(boot.model);
    } catch (error) {
      const voiceInstall = require("./voice-install.cjs");
      lastLocalLayers.reason = voiceInstall.classifyDownloadError(
        String(error?.message || error),
      ).line;
      if (lastLocalLayers.dependency !== "ready") lastLocalLayers.dependency = "missing";
      if (lastLocalLayers.inference !== "verified") lastLocalLayers.inference = "failed";
    }
  } else if (worker?.alive) {
    try {
      const ping = await workerRequest(worker, { op: "status" }, 15000);
      copyLadder(ping);
      noteWorkerCache(ping);
      lastLocalLayers.dependency =
        ping?.dependency === "ready" || ping?.available ? "ready" : "missing";
      lastLocalLayers.worker = "ready";
      lastLocalLayers.inference =
        ping?.inference === "verified" || ping?.modelLoaded ? "verified" : "unverified";
      lastLocalLayers.loadCount = ping?.loadCount || lastLocalLayers.loadCount;
      lastLocalLayers.model = ping?.model || lastLocalLayers.model;
      lastLocalLayers.reason = ping?.error || null;
    } catch {
      lastLocalLayers.worker = "crashed";
    }
  } else {
    const probe = await run(py[0], [...py[1], scriptPath(), "--probe"], 30000);
    const parsed = parse(probe.stdout);
    copyLadder(parsed);
    if (parsed?.ok && parsed.dependency !== "missing" && parsed.available !== false) {
      lastLocalLayers.dependency = "ready";
      lastLocalLayers.reason = null;
      lastLocalLayers.model = parsed.model || DEFAULT_MODEL;
    } else {
      lastLocalLayers.dependency = "missing";
      lastLocalLayers.reason =
        parsed?.error || (probe.stderr || "faster-whisper is not installed yet.").slice(-400);
    }
    lastLocalLayers.worker = "stopped";
    lastLocalLayers.inference = "unverified";
  }

  const value = snapshotStatus({ localOnly, py, pythonPath: py[0] });
  if (!localOnly) cachedStatus = { at: Date.now(), value };
  return value;
}

/**
 * The kernel's own CUDA verdict for the voice budget: true only when the speech kernel found cuBLAS 12 and cuDNN 9 (and
 * the card was asked for). Read from the cached status, or from the one-shot probe that status already runs when nothing
 * is cached; it never starts a worker. Anything slow, failed or unknown is false: the budget then stays on the CPU.
 */
async function cudaRuntimeVerdict({ statusFn = status, timeoutMs = 8000 } = {}) {
  let timer = null;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => statusFn(false)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return value?.cudaRuntimeReady === true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const PACKAGE_FLOOR = { "faster-whisper": "1.2.1", av: "17.0.0" };
const AV_CEILING = 19;

/** Versions of the two speech packages in this interpreter, and the newest faster-whisper on PyPI (read only, 4 s). */
async function probePackages(py) {
  const voiceInstall = require("./voice-install.cjs");
  const code =
    "import json, importlib.metadata as m\n" +
    "o = {}\n" +
    "for n in ('faster-whisper', 'av'):\n" +
    "    try:\n        o[n] = m.version(n)\n" +
    "    except Exception:\n        o[n] = None\n" +
    "print(json.dumps(o))";
  const out = await run(py[0], [...py[1], "-c", code], 30000);
  let versions = {};
  try {
    versions = JSON.parse(
      String(out.stdout || "")
        .trim()
        .split(/\r?\n/)
        .pop() || "{}",
    );
  } catch {
    versions = {};
  }
  const fw = versions["faster-whisper"] || null;
  const av = versions.av || null;
  const satisfied = Boolean(
    fw &&
    av &&
    voiceInstall.versionAtLeast(fw, PACKAGE_FLOOR["faster-whisper"]) &&
    voiceInstall.versionAtLeast(av, PACKAGE_FLOOR.av) &&
    Number(String(av).split(".")[0]) < AV_CEILING,
  );
  let latest = null;
  try {
    const bounded = boundedInit({}, 4000);
    try {
      const res = await fetchCompat("https://pypi.org/pypi/faster-whisper/json", bounded.init);
      const body = res.ok ? await res.json() : null;
      latest = String(body?.info?.version || "") || null;
    } finally {
      bounded.clear();
    }
  } catch {
    latest = null; // offline: the installed engine is still used
  }
  return {
    versions: { "faster-whisper": fw, av },
    satisfied,
    latest,
    updateAvailable: Boolean(fw && latest && !voiceInstall.versionAtLeast(fw, latest)),
  };
}

/** Install the transcriber into the same interpreter Install Manager uses. */
async function install(options = {}) {
  if (installing) return installing;
  installing = (async () => {
    const voiceInstall = require("./voice-install.cjs");
    let py = await python();
    if (!py) {
      const { ensureManagedPython } = require("./toolchain.cjs");
      const managed = await ensureManagedPython("3.12");
      if (managed?.exe) py = [managed.exe, managed.prefix || []];
    }
    if (!py) {
      return { ok: false, cause: "no-python", error: voiceInstall.explain("no-python") };
    }
    const pip = await run(py[0], [...py[1], "-m", "pip", "--version"], 20000);
    if (!pip.ok) {
      const cause =
        voiceInstall.classifyInstallLog(pip.stderr) === "unknown"
          ? "no-pip"
          : voiceInstall.classifyInstallLog(pip.stderr);
      return { ok: false, cause, error: voiceInstall.explain(cause, pip.stderr) };
    }
    // Look first: a package that is already there and in range is not installed again, and a Fix voice
    // press on a working engine no longer runs pip. The newest release is only read, never forced.
    const found = await probePackages(py);
    const needed = options.upgrade || !found.satisfied;
    reportProgress({
      stage: "check",
      status: found.satisfied
        ? `Speech engine is installed (faster-whisper ${found.versions["faster-whisper"]})`
        : "Speech engine needs an install",
      progress: null,
      versions: found.versions,
      latest: found.latest,
      updateAvailable: found.updateAvailable,
    });
    const result = needed
      ? await (async () => {
          reportProgress({
            stage: "install",
            status: "Installing the speech engine",
            progress: null,
          });
          return run(
            py[0],
            [
              ...py[1],
              "-m",
              "pip",
              "install",
              "--upgrade",
              "faster-whisper>=1.2.1",
              "av>=17.0.0,<19",
            ],
            600000,
          );
        })()
      : { ok: true, stdout: "", stderr: "" };
    if (!result.ok) {
      const cause = voiceInstall.classifyInstallLog(`${result.stderr} ${result.stdout}`);
      return { ok: false, cause, error: voiceInstall.explain(cause, result.stderr) };
    }
    const imported = await run(py[0], [...py[1], "-c", "import faster_whisper"], 60000);
    if (!imported.ok) {
      return {
        ok: false,
        cause: "import-failed",
        error: voiceInstall.explain("import-failed", imported.stderr),
      };
    }
    cachedStatus = null;
    lastLocalLayers.dependency = "ready";
    const now = await status(true, { warm: true, localOnly: true });
    return now.ready
      ? {
          ok: true,
          model: now.model,
          skippedInstall: !needed,
          versions: found.versions,
          latest: found.latest,
          updateAvailable: found.updateAvailable,
        }
      : {
          ok: false,
          cause: "import-failed",
          error: voiceInstall.explain("import-failed", now.reason),
        };
  })().finally(() => {
    installing = null;
  });
  return installing;
}

/**
 * The owner's decoding settings, sent to the worker only when set: `hotwords` (the owner's dictionary, never empty)
 * and `multilingual` (the opt-in language check on every phrase). Nothing is sent otherwise, so listening is as before.
 */
function decodeExtras(req) {
  const hotwords = String(req.hotwords || "")
    .trim()
    .slice(0, 200);
  return {
    ...(hotwords ? { hotwords } : {}),
    ...(req.multilingual === true ? { multilingual: true } : {}),
    // A provisional pass is a not-final read of the audio so far: the worker never counts or records it, and it
    // alone can be cancelled by the utterance id it carries.
    ...(req.provisional === true ? { provisional: true } : {}),
    ...(req.provisional === true && cleanUtteranceId(req.utteranceId)
      ? { utteranceId: cleanUtteranceId(req.utteranceId) }
      : {}),
    // A live pass (live words) is a provisional read that wants timed words from the lean path of the worker.
    ...(req.provisional === true && req.livePass === true ? { live: true } : {}),
  };
}

/** What an early read answers on an engine that is not the local speech worker; live words then read the plain way. */
const EARLY_READ_UNSUPPORTED = {
  error: "Early reads need the local speech worker.",
  unsupportedEngine: true,
};

const LIVE_MAX_WORDS = 400;
const LIVE_MAX_SEGMENTS = 64;
const finite = (n) => typeof n === "number" && Number.isFinite(n);

/** The timed words and segments of a live pass, kept only when well formed and bounded; nothing for any other reply. */
function liveReplyFields(parsed) {
  if (!parsed || !Array.isArray(parsed.words)) return {};
  const words = [];
  for (const w of parsed.words) {
    if (words.length >= LIVE_MAX_WORDS) break;
    const text = typeof w?.text === "string" ? w.text.trim().slice(0, 64) : "";
    if (text && finite(w.start) && finite(w.end)) words.push({ text, start: w.start, end: w.end });
  }
  const segments = (Array.isArray(parsed.segments) ? parsed.segments : [])
    .filter((g) => finite(g?.start) && finite(g?.end))
    .slice(0, LIVE_MAX_SEGMENTS)
    .map((g) => ({ start: g.start, end: g.end }));
  return { words, segments };
}

/**
 * The model name a live pass reads with: the one the worker already holds (a guess never loads or switches a model),
 * or "" when this is not a live pass or no worker is loaded.
 */
function liveModel(req, session) {
  if (req?.provisional !== true || req.livePass !== true) return "";
  return session?.alive && session.loaded && session.modelName ? String(session.modelName) : "";
}

/** A plain token (letters, digits, dot, dash, underscore, colon; 64 at most) or empty: it is written to the worker. */
function cleanUtteranceId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{1,64}$/.test(text) ? text : "";
}

/** Provisional decodes in flight, by utterance id ("" for one without a clean id). A cancel marks the entry. */
const provisionals = new Map();

/**
 * Run one provisional decode: it never waits for the gate (a final decode owns the worker, or it is not wanted), a
 * cancel makes its answer "cancelled" whatever the worker returned, and the text of a cancelled one is never given
 * back. `run` is the decode itself (injected so a test needs no worker).
 */
async function runProvisional(req, run, gate = turnGate) {
  const release = gate.tryEnter();
  if (!release) {
    return { ok: false, reason: "busy", error: "A transcription is already running." };
  }
  const key = cleanUtteranceId(req.utteranceId);
  const entry = { cancelled: false };
  provisionals.set(key, entry);
  try {
    const result = await run(req);
    if (entry.cancelled || result?.reason === "cancelled") {
      return {
        ok: false,
        reason: "cancelled",
        cancelled: true,
        final: false,
        ...(key ? { utteranceId: key } : {}),
      };
    }
    return provisionalReply(req, result);
  } finally {
    if (provisionals.get(key) === entry) provisionals.delete(key);
    release();
  }
}

/**
 * Cancel a provisional decode (this utterance, or every one when the id is empty). It does not enter the gate and
 * does not wait for the decode: it marks the entry and writes one cancel line to the worker, which reads its input on
 * its own thread. The worker is never killed and the line carries no id, so nothing is left pending.
 */
function cancelTranscribe(req = {}, session = worker) {
  const key = cleanUtteranceId(req.utteranceId);
  let flagged = 0;
  for (const [id, entry] of provisionals) {
    if (key && id !== key) continue;
    entry.cancelled = true;
    flagged += 1;
  }
  let signalled = false;
  if (flagged > 0 && session?.alive && session.child?.stdin && !session.child.stdin.destroyed) {
    try {
      session.child.stdin.write(`${JSON.stringify({ op: "cancel", utteranceId: key })}\n`);
      signalled = true;
    } catch {
      /* the worker went away; the decode is flagged and its answer is dropped anyway */
    }
  }
  return { ok: true, cancelled: flagged > 0, signalled };
}

/** The not-final marker a provisional answer carries (the same text fields, plus final:false and the utterance). */
function provisionalReply(req, result) {
  if (req.provisional !== true || !result?.ok) return result;
  const utteranceId = String(req.utteranceId || "")
    .trim()
    .slice(0, 64);
  const heard = Number(result.audio?.durationMs ?? 0);
  return {
    ...result,
    final: false,
    audioMs: Number.isFinite(heard) && heard > 0 ? Math.round(heard) : 0,
    ...(utteranceId ? { utteranceId } : {}),
  };
}

/**
 * Transcribe one utterance.
 * @param {{ audioBase64?: string, audioBytes?: Uint8Array, path?: string, mime?: string, language?: string, model?: string, initialPrompt?: string, hotwords?: string, multilingual?: boolean, localOnly?: boolean, provisional?: boolean, utteranceId?: string }} req
 */
async function transcribe(req = {}, onPartial) {
  if (req.provisional === true) {
    // Only a worker that is already up and loaded reads speculatively: a cold start is never paid for a guess.
    return runProvisional(req, (r) =>
      worker?.alive && worker.loaded
        ? transcribeNow(r, onPartial)
        : { ok: false, reason: "not-ready", error: "The speech worker is not loaded yet." },
    );
  }
  const release = await turnGate.enter();
  if (!release) {
    return { ok: false, reason: "busy", error: "A transcription is already running." };
  }
  try {
    return await transcribeNow(req, onPartial);
  } finally {
    release();
  }
}

async function transcribeNow(req = {}, onPartial) {
  noteListeningPref(req);
  const state = await status(false, { localOnly: Boolean(req.localOnly) });
  const ladderReady = Boolean(state.moonshineReady || state.windowsSpeech);
  if (!state.available && !ladderReady)
    return { ok: false, reason: "unavailable", error: state.reason };

  // A speculative read is only ever made by the local speech worker that already holds the model. A cloud engine
  // (a paid, remote call for every guess, and not cancellable) or a one-shot process never reads early.
  if (req.provisional === true && state.engine !== "faster-whisper") {
    return { ok: false, reason: "not-ready", ...EARLY_READ_UNSUPPORTED };
  }

  let file = req.path && fs.existsSync(req.path) ? req.path : null;
  let temporary = false;
  if (!file) {
    const bytes = req.audioBytes
      ? Buffer.from(req.audioBytes)
      : Buffer.from(String(req.audioBase64 || ""), "base64");
    if (!bytes.length) return { ok: false, reason: "no-audio", error: "No audio was captured." };
    const ext = /wav/i.test(req.mime || "") ? "wav" : /ogg/i.test(req.mime || "") ? "ogg" : "webm";
    file = path.join(audioDir(), `${crypto.randomBytes(8).toString("hex")}.${ext}`);
    try {
      fs.writeFileSync(file, bytes);
    } catch (error) {
      return { ok: false, reason: "write-failed", error: String(error?.message || error) };
    }
    temporary = true;
  }

  const started = Date.now();
  try {
    if (String(state.engine || "").startsWith("cloud:")) {
      const engine = cloudEngine();
      if (!engine)
        return { ok: false, reason: "unavailable", error: "the connected transcriber went away" };
      return await cloudTranscribe(engine, file, req.language);
    }
    if (state.engine === "whisper.cpp") {
      const whisperApi = require("./whisper-cpp.cjs");
      const found = whisperApi.locateFrom([paths.root(), process.resourcesPath]);
      if (!found) {
        return { ok: false, reason: "unavailable", error: "whisper.cpp files are missing" };
      }
      if (!/\.wav$/i.test(file)) {
        return {
          ok: false,
          reason: "format",
          error: "whisper.cpp needs a wav capture. This clip is not wav.",
        };
      }
      const warm = await openWhisperServer(found);
      if (warm && warm.mode() === "server") {
        const job = await warm.submit(file);
        if (job?.url) {
          try {
            const bounded = boundedInit({ method: "POST" }, 120_000);
            let res;
            let body;
            try {
              res = await fetch(job.url, bounded.init);
              body = await res.json().catch(() => ({}));
            } finally {
              bounded.clear();
            }
            const heard = String(body?.text || "").trim();
            if (res.ok && heard) {
              return {
                ok: true,
                text: heard,
                language: "",
                model: "base",
                elapsedMs: Date.now() - started,
                engine: "whisper.cpp",
                mode: "server",
              };
            }
          } catch {
            /* fall through to the one-shot cli */
          }
        }
      }
      const argv = whisperApi.transcribeArgv(found.cli, found.model, file);
      const result = await run(argv[0], argv.slice(1), 120000);
      const text = whisperApi.parseWhisperText(result.stdout);
      if (!result.ok || !text) {
        return {
          ok: false,
          reason: "engine-failed",
          error: (result.stderr || "whisper.cpp returned no text").slice(-400),
        };
      }
      return {
        ok: true,
        text,
        language: "",
        model: "base",
        elapsedMs: Date.now() - started,
        engine: "whisper.cpp",
      };
    }
    const voiceInstall = require("./voice-install.cjs");
    const liveWith = liveModel(req, worker);
    const explicit = MODELS.includes(req.model) ? req.model : "";
    const boot = voiceInstall.bootModel({ requested: explicit || "auto", ...cachedSizes() });
    const model = liveWith || explicit || boot.model;
    const loadBudget = voiceInstall.loadBudgetMs(model);
    const locked = whisperLanguage(req.language);
    const prompt = String(req.initialPrompt || req.initial_prompt || "").trim();
    let parsed;
    const ladderEngine = state.engine === "moonshine" || state.engine === "windows-speech";
    try {
      const session = await ensureWorker(model, undefined, { load: !ladderEngine && !liveWith });
      parsed = await workerRequest(
        session,
        {
          op: "transcribe",
          audio: file,
          model,
          model_path: session.modelPath || "",
          language: locked || req.language || "",
          initial_prompt: prompt.slice(0, 800),
          speech_pref: String(req.speechPref || req.speech_pref || req.language || ""),
          sttSize: String(req.sttSize || req.stt_size || ""),
          keep_wav: Boolean(req.keepWav || req.keep_wav),
          ...decodeExtras(req),
        },
        loadBudget,
        onPartial,
      );
    } catch (error) {
      worker = null;
      lastLocalLayers.worker = "crashed";
      lastLocalLayers.inference = "failed";
      if (recordSttCrash()) {
        return {
          ok: false,
          reason: "crash-loop",
          error:
            "The speech worker stopped after repeated crashes. Listening stays paused until you try again.",
        };
      }
      try {
        if (!ladderEngine && ladderReady) {
          const session = await ensureWorker(model, undefined, { load: false });
          parsed = await workerRequest(
            session,
            {
              op: "transcribe",
              audio: file,
              model,
              model_path: session.modelPath || "",
              language: locked || req.language || "",
              initial_prompt: prompt.slice(0, 800),
              speech_pref: String(req.speechPref || req.speech_pref || req.language || ""),
              sttSize: String(req.sttSize || req.stt_size || ""),
              keep_wav: Boolean(req.keepWav || req.keep_wav),
              ...decodeExtras(req),
            },
            loadBudget,
            onPartial,
          );
        } else if (!ladderEngine) {
          const fallback = voiceInstall.bootModel({
            requested: model,
            failed: true,
            elapsedMs: loadBudget + 1,
            budgetMs: loadBudget,
          }).model;
          const session = await ensureWorker(fallback);
          parsed = await workerRequest(
            session,
            {
              op: "transcribe",
              audio: file,
              model: fallback,
              model_path: session.modelPath || "",
              language: locked || req.language || "",
              initial_prompt: prompt.slice(0, 800),
              speech_pref: String(req.speechPref || req.speech_pref || req.language || ""),
              sttSize: String(req.sttSize || req.stt_size || ""),
              keep_wav: Boolean(req.keepWav || req.keep_wav),
              ...decodeExtras(req),
            },
            voiceInstall.loadBudgetMs(fallback),
            onPartial,
          );
        } else {
          throw error;
        }
      } catch (retryError) {
        return {
          ok: false,
          reason: "engine-failed",
          error: String(retryError?.message || error?.message || retryError).slice(-500),
        };
      }
    }
    if (!parsed) {
      return { ok: false, reason: "engine-failed", error: "the transcriber returned nothing" };
    }
    if (!parsed.ok)
      return {
        ok: false,
        reason: parsed.reason || "failed",
        error: parsed.error,
        sttClass: parsed.sttClass || parsed.reason || "",
        fix: parsed.fix || "",
      };
    lastLocalLayers.inference = "verified";
    lastLocalLayers.loadCount = parsed.loadCount || lastLocalLayers.loadCount;
    lastLocalLayers.model = model;
    cachedStatus = null;
    return {
      ok: true,
      text: String(parsed.text || ""),
      language: parsed.language || locked || "",
      model,
      elapsedMs: Date.now() - started,
      engine: parsed.engine || "faster-whisper",
      noSpeechProb: typeof parsed.noSpeechProb === "number" ? parsed.noSpeechProb : undefined,
      // How sure the model was, so a fluent guess about the wrong language is not trusted as a clear command.
      languageProbability:
        typeof parsed.languageProbability === "number" ? parsed.languageProbability : null,
      avgLogprob: typeof parsed.avgLogprob === "number" ? parsed.avgLogprob : null,
      languageNote: String(parsed.languageNote || ""),
      turnProbability: typeof parsed.turnProbability === "number" ? parsed.turnProbability : null,
      loadCount: parsed.loadCount,
      emptyReason: String(parsed.emptyReason || (parsed.audio && parsed.audio.emptyReason) || ""),
      audio: parsed.audio || null,
      ...liveReplyFields(parsed),
    };
  } finally {
    if (temporary) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* the cache folder is cleaned on next boot */
      }
    }
  }
}

function turnAudioBuffer(req = {}) {
  const raw = req.audioBytes;
  if (raw && (raw.length || raw.byteLength)) {
    return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  }
  return Buffer.from(String(req.audioBase64 || ""), "base64");
}

/**
 * Score the clip in the speech worker that is already running, which holds the model: about a tenth of a second,
 * where a fresh interpreter with its imports took one to three on Windows and held every turn open until the cap.
 * Not while a transcription runs (the answer would only arrive after it, and a quiet turn is better closed on
 * the plain pause than held for a score). Null means no worker is up, and the one-shot process answers as before.
 */
async function scoreInWorker(file, session = worker) {
  if (!session?.alive) return null;
  // A score is a short request with its own 20 s deadline, and a request that misses its deadline kills the worker.
  // Queued behind a cold load (or a model reload) it would take the half-loaded worker down with it: only a loaded
  // worker with nothing in flight is asked, and anything else closes the turn on the plain pause.
  if (turnGate.busy() || !session.loaded || session.pending.size > 0) {
    return { ok: true, ready: false, probability: null, reason: "busy" };
  }
  try {
    const parsed = await workerRequest(session, { op: "score-turn", audio: file }, 20000);
    if (!parsed || typeof parsed !== "object" || parsed.reason === "unknown-op") return null;
    return {
      ok: true,
      ready: Boolean(parsed.ready),
      probability: typeof parsed.probability === "number" ? parsed.probability : null,
      reason: String(parsed.reason || ""),
    };
  } catch {
    return null;
  }
}

async function scoreTurn(req = {}) {
  const bytes = turnAudioBuffer(req);
  if (!bytes.length) return { ok: true, ready: false, probability: null, reason: "no-audio" };
  const ext = /wav/i.test(req.mime || "") ? "wav" : /ogg/i.test(req.mime || "") ? "ogg" : "webm";
  const file = path.join(audioDir(), `${crypto.randomBytes(8).toString("hex")}.${ext}`);
  try {
    fs.writeFileSync(file, bytes);
  } catch (error) {
    return { ok: true, ready: false, probability: null, reason: String(error?.message || error) };
  }
  try {
    const warm = await scoreInWorker(file);
    if (warm) return warm;
    const py = await python();
    if (!py) return { ok: true, ready: false, probability: null, reason: "no-python" };
    const runtime =
      require("./resource-paths.cjs").resolveResourceFile("kernel/voice_runtime.py") ||
      path.join(__dirname, "..", "kernel", "voice_runtime.py");
    const probe = await run(py[0], [...py[1], runtime, "--score", "--audio", file], 12000);
    const parsed = parse(probe.stdout);
    if (!parsed) return { ok: true, ready: false, probability: null, reason: "no score" };
    return {
      ok: true,
      ready: Boolean(parsed.ready),
      probability: typeof parsed.probability === "number" ? parsed.probability : null,
      reason: parsed.reason || "",
    };
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* cache sweep removes it */
    }
  }
}

let whisperSession = null;
let whisperServerTried = false;

function onMute(muted) {
  if (!muted) return { stopped: false };
  if (whisperSession && typeof whisperSession.stop === "function") whisperSession.stop();
  whisperSession = null;
  whisperServerTried = false;
  return { stopped: true };
}

async function openWhisperServer(found) {
  const whisperApi = require("./whisper-cpp.cjs");
  if (!found?.server || whisperServerTried) return whisperSession;
  whisperServerTried = true;
  const session = whisperApi.createWhisperSession({
    binary: found.server,
    cli: found.cli,
    model: found.model,
    port: whisperApi.WHISPER_PORT,
    spawn: (argv) => {
      const { spawn } = require("child_process");
      return spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: "ignore" });
    },
    health: async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 400);
        const res = await fetch(`http://127.0.0.1:${whisperApi.WHISPER_PORT}/health`, {
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        return res.ok;
      } catch {
        return false;
      }
    },
  });
  const started = await session.start();
  if (!started.ok) return null;
  whisperSession = session;
  return session;
}

function shutdown(session = worker) {
  onMute(true);
  if (worker === session) {
    worker = null;
    speechHeld?.release();
    speechHeld = null;
  }
  lastLocalLayers.worker = "stopped";
  lastLocalLayers.inference = "unverified";
  cachedStatus = null;
  if (!session?.child) return;
  session.intentional = true;
  try {
    if (session.alive && session.child.stdin && !session.child.stdin.destroyed) {
      session.child.stdin.write(`${JSON.stringify({ id: ++workerSeq, op: "shutdown" })}\n`);
    }
  } catch {
    /* closing anyway */
  }
  rejectPending(session, new Error("STT worker shutting down"));
  const child = session.child;
  setTimeout(() => killTree(child), 400);
}

/**
 * Memory pressure (electron/resource-governor.cjs): close the speech worker when it has nothing in flight and has
 * not been asked anything for `minIdleMs`. It starts again on the next turn. Returns whether it was closed.
 */
function releaseIdle(minIdleMs = 60_000, session = worker) {
  if (!session?.alive || session.pending.size > 0) return false;
  if (Date.now() - (session.lastUsedAt || 0) < minIdleMs) return false;
  shutdown(session);
  return true;
}

/** Drop stale capture files left behind by a crash. Called at startup. */
function sweep(maxAgeMs = 6 * 60 * 60 * 1000) {
  let removed = 0;
  try {
    const dir = audioDir();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > maxAgeMs) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        /* another process owns it */
      }
    }
  } catch {
    /* no cache yet */
  }
  return { removed };
}

module.exports = {
  status,
  cudaRuntimeVerdict,
  install,
  setProgressSink,
  setLoadLeases,
  speechLoadOptions,
  leaseSpeechLoad,
  transcribe,
  runProvisional,
  cancelTranscribe,
  provisionalReply,
  decodeExtras,
  liveReplyFields,
  liveModel,
  createTurnGate,
  workerRequest,
  scoreInWorker,
  workerCacheOf,
  scoreTurn,
  turnAudioBuffer,
  sweep,
  shutdown,
  releaseIdle,
  onMute,
  MODELS,
  DEFAULT_MODEL,
  tmpdir: os.tmpdir,
};
