/**
 * FRIDAY · desktop speech-to-text
 *
 * The renderer's Web Speech API only works in Chromium with a live connection
 * to Google's servers — inside the packaged EXE that is neither private nor
 * reliable. This module runs REAL on-device transcription through
 * kernel/stt.py (FRIDAY Ear) using the same shared Python resolver every
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
const { scrubPaths } = require("./path-scrub.cjs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { trackOwned } = require("./app-lifecycle.cjs");
const { createVoiceWorker, childEnv } = require("./voice-worker.cjs");
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
/** The most audio one transcribe request may carry: about six minutes of 16 kHz mono 16-bit WAV (11.5 MB). */
const MAX_TRANSCRIBE_BYTES = 12 * 1024 * 1024;
/** The most an end-of-turn score may carry: a score reads the last moments of a turn, never a dictation. */
const MAX_SCORE_BYTES = 4 * 1024 * 1024;

/** What a test replaces: the interpreter, a one-shot run, the weights, the spawn and the cloud calls. Empty in the app. */
const hooks = {};

/**
 * Cloud transcription fallback.
 *
 * FRIDAY Ear needs Python plus a model download, so a fresh machine has
 * no on-device transcriber and the microphone would be dead. When the owner
 * has already connected a provider that exposes the OpenAI-compatible
 * /audio/transcriptions endpoint, that provider is used instead — same stored
 * key, same endpoint override, no new credential store.
 */
const CLOUD_STT = [
  { id: "openai", model: "gpt-4o-transcribe" },
  { id: "groq", model: "whisper-large-v3" },
];

/**
 * The cloud-voice gate (consent, allowed provider, privacy mode, billing), wired by main from electron/voice-cloud.cjs.
 * It is asked at the status check and again right before an upload. Nothing wired, a throw, or anything but
 * `{ ok: true }` is a refusal: the cloud transcriber stays closed (fail closed).
 */
let cloudGate = null;
function setCloudGate(gate) {
  cloudGate = typeof gate === "function" ? gate : null;
}
function cloudAllowed(engine) {
  try {
    return cloudGate?.(engine.id)?.ok === true;
  } catch {
    return false;
  }
}

function cloudEngine() {
  if (hooks.cloudEngine) return hooks.cloudEngine();
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
  if (hooks.cloudTranscribe) return hooks.cloudTranscribe(engine, file, language);
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
/**
 * The owner's own view of the resident speech worker: what it holds (model, weights folder, load count, lease) and
 * when it was last asked. The process itself belongs to electron/voice-worker.cjs; `alive` reads that module's cached
 * status, so a stale handle is simply not alive and is never set back to null.
 */
let worker = null;
let workerSeq = 0;
/** What the next start loads: written by loadWorker, read once by the module's init. */
let startPlan = null;
let voiceWorker = null;
const initialLayers = () => ({
  dependency: "missing",
  worker: "stopped",
  inference: "unverified",
  loadCount: 0,
  model: DEFAULT_MODEL,
  reason: null,
  moonshineReady: false,
  windowsSpeech: false,
  cudaRuntimeReady: false,
});
let lastLocalLayers = initialLayers();

/** The first status ping of a run (a cold Python, its imports, an antivirus scan) gets 90 s; every later one 30 s. */
const INIT_FIRST_MS = 90_000;
const INIT_MS = 30_000;
/** True once a start of this run answered its ping; useForTests clears it. */
let everReady = false;

/**
 * The speech profile's idle unload (electron/voice-weights.cjs `budgetFor`, read only): how long the worker keeps its
 * models with nothing to do. `speechIdleMs` is what main last told us (setSpeechProfile); until then the profile this
 * PC's memory and processor give, with no GPU reading (a GPU PC refines it when main asks for the budget).
 */
let speechIdleMs = 0;
/** A changed idle time rides the next request to the worker, so a busy worker is never pinged for it. */
let idleDirty = false;

function profileIdleMs() {
  if (speechIdleMs > 0) return speechIdleMs;
  try {
    const gb = (bytes) => bytes / 1024 ** 3;
    const budget = require("./voice-weights.cjs").budgetFor(
      gb(os.totalmem()),
      gb(os.freemem()),
      0,
      {},
      { cpuThreads: os.cpus().length || 4 },
    );
    return Number(budget?.idleUnloadMs) || 0;
  } catch {
    return 0;
  }
}

/** `{ idleUnloadSec }` for a request to the worker (kernel/stt.py configure_idle), or nothing when no profile is known. */
function idleUnloadField() {
  const ms = profileIdleMs();
  return ms > 0 ? { idleUnloadSec: Math.round(ms / 1000) } : {};
}

/**
 * The voice budget's profile (main calls this after it reads one): its `idleUnloadMs` is the worker's idle time from now
 * on. A live idle worker is told at once with a light status; a busy one gets it on its next request.
 */
async function setSpeechProfile(profile) {
  const ms = Number(profile?.idleUnloadMs);
  if (!Number.isFinite(ms) || ms <= 0) return { ok: false };
  if (ms === speechIdleMs && !idleDirty) return { ok: true, idleUnloadSec: Math.round(ms / 1000) };
  speechIdleMs = ms;
  idleDirty = true;
  const session = worker;
  if (session?.alive && session.pending.size === 0 && !streamEar.active()) {
    try {
      await workerRequest(session, { op: "status" }, INIT_MS);
    } catch {
      /* the next request carries it */
    }
  }
  return { ok: true, idleUnloadSec: Math.round(ms / 1000) };
}

/**
 * The crash-loop breaker. The module opens it after three crashes in a minute and cools 30 s (one probe start, closed
 * by a good start). A second open with no good turn between holds the next start for 5 minutes. There is no offline
 * recogniser outside this worker except the Windows-speech rung, which a one-shot PowerShell can serve without the
 * child (`windowsSpeechOneShot`, a wav and a rung seen ready before): while the breaker is open a short turn is
 * heard through it. When that rung is not there the bridge says listening is paused and Retry works after the cool-down.
 */
const BREAKER_COOL_MS = 30_000;
const CRASH_LOOP_HOLD_MS = 300_000;
const crashLoop = { seenUntil: 0, opens: 0, holdUntil: 0 };
const CRASH_LOOP_LINES = {
  en: "Listening paused. Press Retry in a moment.",
  hi: "सुनना रुका हुआ है। थोड़ी देर में Retry दबाइए।",
  hinglish: "Sunna ruka hua hai. Thodi der mein Retry dabao.",
};

/** Counts each new open of the module's breaker once; the second one in a row sets the 5 minute hold. */
function noteBreaker() {
  const until = Number(getVoiceWorker().status().breakerUntil) || 0;
  if (until <= 0 || until === crashLoop.seenUntil) return;
  crashLoop.seenUntil = until;
  crashLoop.opens += 1;
  if (crashLoop.opens >= 2) {
    crashLoop.holdUntil = Math.max(
      crashLoop.holdUntil,
      until - BREAKER_COOL_MS + CRASH_LOOP_HOLD_MS,
    );
  }
}

/** Milliseconds until a start is allowed again; 0 when it is. */
function crashLoopWaitMs() {
  noteBreaker();
  const until = Math.max(Number(getVoiceWorker().status().breakerUntil) || 0, crashLoop.holdUntil);
  return Math.max(0, until - Date.now());
}

/** A turn went well: the loop is over and the next open is a first one again. */
function crashLoopClear() {
  crashLoop.seenUntil = 0;
  crashLoop.opens = 0;
  crashLoop.holdUntil = 0;
}

/** The one-shot Windows-speech rung (System.Speech dictation, installed language pack, no download). Null when it cannot hear. */
async function windowsSpeechOneShot(file) {
  if ((hooks.platform || process.platform) !== "win32") return null;
  if (!lastLocalLayers.windowsSpeech || !/\.wav$/i.test(String(file))) return null;
  // The path travels in an environment variable: pasted into the script, U+2018 and U+2019 would act as quotes.
  const script =
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; " +
    "$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine; " +
    "$e.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); " +
    "$e.SetInputToWaveFile($env:FRIDAY_STT_WAV); $r = $e.Recognize(); if ($r) { $r.Text }";
  try {
    const result = await run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      20_000,
      { FRIDAY_STT_WAV: String(file) },
    );
    const text = String(result?.stdout || "").trim();
    return result?.ok && text ? text : null;
  } catch {
    return null;
  }
}

function crashLoopReply(waitMs) {
  return {
    ok: false,
    reason: "crash-loop",
    error: CRASH_LOOP_LINES.en,
    lines: { ...CRASH_LOOP_LINES },
    retry: true,
    retryAfterMs: Math.max(1, waitMs),
  };
}

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

/** What the worker last said about the optional large Hinglish ear: its files are ready, and why a request for it was skipped. */
let lastHinglishEar = { ready: null, skipped: "" };

/** The three own ears as the kernel's status last listed them (kernel/stt.py own_ears_status), trimmed to plain values. */
let lastOwnEars = [];

function cleanOwnEars(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((ear) => ear && typeof ear === "object" && typeof ear.id === "string")
    .slice(0, 8)
    .map((ear) => ({
      id: ear.id.slice(0, 60),
      label: String(ear.label || ear.id).slice(0, 80),
      catalogId: String(ear.catalogId || "").slice(0, 60),
      ready: ear.ready === true,
      loaded: ear.loaded === true,
      error: ear.error ? scrubPaths(String(ear.error)).slice(0, 300) : "",
    }));
}

function copyLadder(parsed) {
  if (!parsed || typeof parsed !== "object") return;
  if (Array.isArray(parsed.ownEars)) lastOwnEars = cleanOwnEars(parsed.ownEars);
  if (typeof parsed.hinglishEarTrelisReady === "boolean")
    lastHinglishEar.ready = parsed.hinglishEarTrelisReady;
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

function run(exe, args, timeout = 120000, extraEnv = {}) {
  if (hooks.run) return hooks.run(exe, args, timeout, extraEnv);
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
        env: childEnv(process.env, {
          FRIDAY_ROOT: paths.root() || process.env.FRIDAY_ROOT || "",
          ...extraEnv,
        }),
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
  if (hooks.python) return hooks.python();
  const found = await resolvePython();
  return found ? [found.exe, found.prefix || []] : null;
}

const parse = parseJsonLine;

/** The one lifecycle owner for the speech child. This file never spawns, buffers or kills a process itself. */
function getVoiceWorker() {
  if (voiceWorker) return voiceWorker;
  voiceWorker = createVoiceWorker({
    role: "stt",
    script: async () => (startPlan?.py || (await python()))?.[0],
    args: async () => {
      const py = startPlan?.py || (await python());
      return py ? [...py[1], scriptPath(), "--serve"] : [];
    },
    env: () => ({
      FRIDAY_ROOT: paths.root() || process.env.FRIDAY_ROOT || "",
      FRIDAY_STT_TIER: "auto",
      FRIDAY_RAM_GB: String(Math.round((os.totalmem() / 1024 ** 3) * 10) / 10),
    }),
    idleUnloadMs: 0,
    // The first open cools 30 s (one probe start then); the second in a row holds CRASH_LOOP_HOLD_MS (noteBreaker).
    breaker: { max: 3, windowMs: 60_000, coolMs: BREAKER_COOL_MS },
    init: initWorker,
    spawn: (command, args, options) => {
      const child = (hooks.spawn || spawn)(command, args, options);
      trackOwned("stt", child, command);
      return child;
    },
    ...(hooks.killTree ? { killTree: hooks.killTree } : {}),
    onExit: onWorkerExit,
  });
  return voiceWorker;
}

/** A handle for one generation of the child: it is alive exactly while the module says that generation is up. */
function makeSession(generation) {
  return {
    generation,
    loaded: false,
    modelName: null,
    modelPath: "",
    loadCount: 0,
    leasedFor: null,
    // Set by init when the child started but cannot serve (no speech package, model did not load).
    failure: "",
    // A worker that has not been asked anything yet is new, not idle (releaseIdle).
    lastUsedAt: Date.now(),
    // Requests this file has in flight on that child (an idle check and a score never queue behind them).
    pending: new Map(),
    get alive() {
      const view = getVoiceWorker().status();
      return view.generation === generation && (view.state === "ready" || view.state === "busy");
    },
  };
}

/**
 * The module's ready gate: the status ping and the model load. A transport failure here (exit, deadline) throws and the
 * module stops the child; a child that answers "no package" or "model did not load" is flagged on its handle and
 * stopped by startWorker, so a missing package never counts as a crash.
 */
async function initWorker(send, info) {
  const plan = startPlan || { wanted: DEFAULT_MODEL, modelPath: "", loadModel: false };
  const session = makeSession(info.generation);
  worker = session;
  lastLocalLayers.worker = "ready";
  // The first ping of a run may wait out an antivirus scan of a cold Python and its imports; later ones are warm.
  const ping = await send(
    { op: "status", ...idleUnloadField() },
    { hardMs: everReady ? INIT_MS : INIT_FIRST_MS },
  );
  everReady = true;
  idleDirty = false;
  copyLadder(ping);
  noteWorkerCache(ping);
  if (ping?.dependency === "missing" || ping?.available === false) {
    // The light status leaves the Windows recogniser question out until it is probed; this is the one branch that
    // needs it (no speech package: does a ladder rung serve instead?), so the probe runs here, once per start.
    if (typeof ping?.windowsSpeech !== "boolean") {
      try {
        copyLadder(await send({ op: "probe" }, { hardMs: INIT_FIRST_MS }));
      } catch {
        /* the rung stays off: a dead worker is reported by the module */
      }
    }
    lastLocalLayers.dependency = "missing";
    lastLocalLayers.reason = scrubPaths(
      ping?.error || "The FRIDAY Ear speech engine is not installed yet.",
    );
    if (!(lastLocalLayers.moonshineReady || lastLocalLayers.windowsSpeech) || plan.loadModel) {
      session.failure = lastLocalLayers.reason;
    }
    return;
  }
  if (!plan.loadModel) return;
  lastLocalLayers.dependency = "ready";
  const loaded = await guardedLoad(() =>
    send({ op: "load", model: plan.wanted, model_path: plan.modelPath }, { hardMs: 180000 }),
  );
  if (!loaded?.ok) {
    lastLocalLayers.inference = "failed";
    lastLocalLayers.reason = scrubPaths(loaded?.error || "STT model failed to load");
    session.failure = lastLocalLayers.reason;
    return;
  }
  session.loaded = true;
  session.modelName = plan.wanted;
  session.modelPath = plan.modelPath;
  session.loadCount = loaded.loadCount || 1;
  lastLocalLayers = {
    dependency: "ready",
    worker: "ready",
    inference: "verified",
    loadCount: session.loadCount,
    model: plan.wanted,
    reason: null,
    moonshineReady: Boolean(lastLocalLayers.moonshineReady),
    windowsSpeech: Boolean(lastLocalLayers.windowsSpeech),
    cudaRuntimeReady: Boolean(lastLocalLayers.cudaRuntimeReady),
  };
}

/** Every exit of the child, on purpose or not: the stream ends, the layers say what happened. */
function onWorkerExit(info) {
  if (!info.intentional) noteBreaker();
  if (worker && worker.generation > info.generation) return; // an older child, already replaced
  if (worker && worker.generation === info.generation) streamEar.drop(worker);
  if (info.intentional) {
    lastLocalLayers.worker = "stopped";
    if (lastLocalLayers.inference !== "failed") lastLocalLayers.inference = "unverified";
    return;
  }
  lastLocalLayers.worker = "crashed";
  lastLocalLayers.inference = "failed";
  const tail = String(info.stderrTail || "").slice(-400);
  lastLocalLayers.reason = tail ? `STT worker exited — ${scrubPaths(tail)}` : "STT worker exited";
  cachedStatus = null;
}

/**
 * One request to the resident worker, through the module: `hardMs` is the deadline that kills the child, `limits` may
 * add a soft miss (slow is not dead) and a stall count for a stream feed. Resolves with the reply envelope, ok:false
 * included; rejects only when the transport fails (a typed VoiceWorkerError).
 */
async function workerRequest(session, payload, hardMs, onStream, limits = {}) {
  if (!session?.alive) throw new Error("STT worker is not running");
  const key = ++workerSeq;
  session.lastUsedAt = Date.now();
  session.pending.set(key, { op: payload?.op });
  const body =
    idleDirty && payload && payload.idleUnloadSec === undefined
      ? { ...payload, ...idleUnloadField() }
      : payload;
  idleDirty = false;
  try {
    return await getVoiceWorker().request(body, {
      hardMs,
      ...(limits.softMs ? { softMs: limits.softMs } : {}),
      ...(limits.stallMisses ? { stallMisses: limits.stallMisses } : {}),
      ...(typeof onStream === "function" ? { onStream } : {}),
      ...(typeof limits.onSlow === "function" ? { onSlow: limits.onSlow } : {}),
    });
  } finally {
    session.pending.delete(key);
    session.lastUsedAt = Date.now();
  }
}

/** Start the child (single flight in the module). A child that started but cannot serve is stopped, never left alive. */
async function startWorker() {
  const voice = getVoiceWorker();
  // A second crash loop holds the next start for 5 minutes, past the module's own 30 s cool-down.
  if (crashLoopWaitMs() > 0) {
    throw Object.assign(new Error("The speech worker is paused after repeated crashes."), {
      code: "breaker-open",
    });
  }
  await voice.ensure();
  const session = worker;
  if (session?.failure && session.generation === voice.status().generation) {
    await voice.stop();
    throw new Error(session.failure);
  }
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
          error: scrubPaths(String(result?.error || "").slice(0, 200)),
        });
      }
      return result;
    })
    .catch((error) => {
      failedFetches.set(size, Date.now());
      return { ok: false, error: scrubPaths(error?.message || error) };
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
  if (hooks.weights) return hooks.weights(wanted, onEvent);
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
  if (!worker?.alive) {
    const py = await python();
    if (!py) throw new Error("Python 3.12+ was not found — install it from Install Manager.");
    startPlan = { py, wanted, modelPath, loadModel };
    await startWorker();
  }
  const session = worker;
  if (!session?.alive) throw new Error("STT worker is not running");
  if (!loadModel) return session;
  // A start shared with another caller may have loaded a different size: switch it, as an alive worker always did.
  if (session.modelName && session.modelName !== wanted) {
    const loaded = await guardedLoad(() =>
      workerRequest(session, { op: "load", model: wanted, model_path: modelPath }, 180000),
    );
    if (!loaded?.ok) throw new Error(loaded?.error || "STT model reload failed");
    session.loaded = true;
    session.modelName = wanted;
    session.modelPath = modelPath;
    session.loadCount = loaded.loadCount || session.loadCount;
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
  }
  return session;
}

/** The streaming ear (voice.streamEngine). The same words kernel/stream_ear.py accepts; "off" is the shipped default. */
const STREAM_ENGINES = ["off", "auto", "nemotron", "stream-ear-nemotron"];
/** kernel/stream_ear.py MAX_FEED_BYTES: the largest chunk of audio one feed may carry. */
const MAX_FEED_BYTES = 1_048_576;
const STREAM_HOTWORDS_MAX = 64;
const STREAM_HOTWORD_CHARS = 40;
const STREAM_ID_CHARS = 64;
/** A stream nobody feeds is closed (audio dropped) after this long, so the turn gate is never held for good. */
const STREAM_IDLE_MS = 15_000;
/** Per-call worker limits (ms). A hard deadline kills the worker (voice-worker.cjs), so they are generous. */
const STREAM_OPEN_MS = 25_000;
/** A feed that has not answered in this long is a soft miss: slow, not dead. Two in a row, with no stream line between, kill it. */
const STREAM_FEED_MS = 8_000;
/** The most a feed may take before it is killed whatever its misses (the quick IPC budget is 30 s). */
const STREAM_FEED_HARD_MS = 30_000;
const STREAM_CLOSE_MS = 20_000;
/**
 * The model warm-up (op stream-warm) is the one slow load, so it has its own limit. A miss ends only the warm attempt
 * (the renderer falls back to the ordinary decode); it never kills the worker and never counts toward the breaker.
 */
const STREAM_WARM_MS = 120_000;

/** At most four execution-provider names (letters and digits); anything else is dropped. Warm and open send the same list. */
function cleanStreamProviders(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && /^[A-Za-z0-9]{2,32}$/.test(item))
    .slice(0, 4);
}

/** "hi", "en", "hi-en" or "": a short lowercase language tag; anything else reads as no preference. */
function cleanStreamLocale(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/_/g, "-") : "";
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(text) ? text : "";
}

/** At most 64 trimmed, deduplicated words of at most 40 characters; a non-string or longer entry is dropped. */
function cleanStreamHotwords(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const word = item.trim();
    if (word && word.length <= STREAM_HOTWORD_CHARS) seen.add(word);
    if (seen.size >= STREAM_HOTWORDS_MAX) break;
  }
  return [...seen];
}

const EARS_ENUMS = {
  vad: ["auto", "silero", "energy"],
  eagerness: ["eager", "normal", "patient"],
  denoise: ["off", "rnnoise", "gtcrn", "dpdfnet2"],
  scene: ["score", "off"],
  otherVoice: ["off", "score", "hold"],
};
const EARS_BOOLS = ["eagerTurn", "pcAudioRef"];

const earsNumber = (value, lo, hi, whole) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.min(hi, Math.max(lo, value));
  return whole ? Math.round(n) : Math.round(n * 100) / 100;
};

/**
 * The listening settings the renderer sends with stream-open, clamped here again (main never trusts the renderer):
 * vadStart 0.2-0.9, vadEnd 0.05 up to vadStart - 0.05, minSpeechMs 60-400, preRollMs 200-1000, enum words from their
 * lists, booleans only as booleans. Anything else is dropped, so the worker falls back to its own defaults.
 */
function cleanStreamEars(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, list] of Object.entries(EARS_ENUMS)) {
    if (typeof value[key] === "string" && list.includes(value[key])) out[key] = value[key];
  }
  for (const key of EARS_BOOLS) if (typeof value[key] === "boolean") out[key] = value[key];
  const start = earsNumber(value.vadStart, 0.2, 0.9, false);
  if (start !== null) out.vadStart = start;
  const ceiling = Math.round(((start ?? 0.5) - 0.05) * 100) / 100;
  const end = earsNumber(value.vadEnd, 0.05, ceiling, false);
  if (end !== null) out.vadEnd = end;
  const minSpeech = earsNumber(value.minSpeechMs, 60, 400, true);
  if (minSpeech !== null) out.minSpeechMs = minSpeech;
  const preRoll = earsNumber(value.preRollMs, 200, 1000, true);
  if (preRoll !== null) out.preRollMs = preRoll;
  const owner = value.ownerEmbedding;
  if (
    Array.isArray(owner) &&
    owner.length >= 64 &&
    owner.length <= 1024 &&
    owner.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    out.ownerEmbedding = owner.map((n) => Math.min(100, Math.max(-100, n)));
  }
  return out;
}

const refused = (reason) => ({ ok: false, fallback: true, reason });

/** An "auto" ear this PC is too small or too slow for reads `auto-<reason>`; any other reason is the worker's own. */
const autoRefusal = (reason) =>
  reason === "low-ram" || reason === "few-cores" || reason === "slow" ? `auto-${reason}` : reason;

/** The stored bench of the "auto" streaming ear, `<FRIDAY_ROOT>/cache/stream-ear-auto.json`; a wiped cache re-benches once. */
const STREAM_AUTO_FILE = "stream-ear-auto.json";
const STREAM_AUTO_VERSION = 1;

/** What this PC is, for the "auto" rule: RAM, processor count and model, and whether the speech kernel verified CUDA. */
function streamAutoFacts() {
  const cpus = os.cpus() || [];
  return {
    totalRamGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    cores: cpus.length,
    cpu: String(cpus[0]?.model || "").slice(0, 80),
    gpu: Boolean(lastLocalLayers.cudaRuntimeReady),
  };
}

/** The facts that decide whether a stored bench still describes this PC: any change re-runs it. */
function streamAutoFingerprint(facts) {
  return [
    Math.round(Number(facts?.totalRamGb) || 0),
    Math.floor(Number(facts?.cores) || 0),
    String(facts?.cpu || ""),
    facts?.gpu ? "gpu" : "cpu",
  ].join("|");
}

function readStreamAutoFile() {
  try {
    // A read never creates the folder; only a measured bench writes.
    return JSON.parse(fs.readFileSync(path.join(paths.dir("cache"), STREAM_AUTO_FILE), "utf8"));
  } catch {
    return null;
  }
}

function writeStreamAutoFile(record) {
  try {
    const file = path.join(paths.ensureDir("cache"), STREAM_AUTO_FILE);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    /* an unwritable cache costs one more bench on the next start, never the stream */
  }
}

/**
 * The "auto" verdict of the streaming ear (rule and numbers: electron/voice-weights.cjs STREAM_AUTO). `decide(bench)`
 * answers `{ on, reason }`: the hardware check first (no worker call), then the stored bench when its fingerprint is
 * this PC's, else `bench()` once (the kernel's stream-warm with `bench`, which also loads the model) and the measured
 * p95 is stored. A bench that measured nothing is not stored, so the next turn tries again. `view()` is the status and
 * Doctor line. Every dependency is injectable, so tests use fake facts, a fake store and a fake bench.
 */
function createStreamAuto({
  facts = streamAutoFacts,
  readStore = readStreamAutoFile,
  writeStore = writeStreamAutoFile,
} = {}) {
  // Looked up on use: the weights table is not loaded with this module.
  const weights = {
    get rule() {
      return require("./voice-weights.cjs").STREAM_AUTO;
    },
    streamAutoHardware: (f) => require("./voice-weights.cjs").streamAutoHardware(f),
    streamAutoBenchPassed: (ms) => require("./voice-weights.cjs").streamAutoBenchPassed(ms),
  };
  let last = { on: null, reason: "not-checked", p95Ms: null };

  const note = (verdict) => {
    last = verdict;
    return verdict;
  };

  function stored(fingerprint) {
    let record = null;
    try {
      record = readStore();
    } catch {
      record = null;
    }
    if (!record || record.v !== STREAM_AUTO_VERSION || record.fingerprint !== fingerprint)
      return null;
    const p95 = record.p95Ms;
    return typeof p95 === "number" && Number.isFinite(p95) && p95 >= 0 ? p95 : null;
  }

  /** The stored p95 for this PC, or null when the bench must (re)run. */
  function known() {
    let current;
    try {
      current = facts();
    } catch {
      return false;
    }
    return (
      !weights.streamAutoHardware(current).eligible ||
      stored(streamAutoFingerprint(current)) !== null
    );
  }

  async function decide(bench) {
    let current;
    try {
      current = facts();
    } catch {
      current = {};
    }
    const hardware = weights.streamAutoHardware(current);
    if (!hardware.eligible) return { ...note({ on: false, reason: hardware.reason, p95Ms: null }) };
    const fingerprint = streamAutoFingerprint(current);
    const kept = stored(fingerprint);
    if (kept !== null) {
      return note({
        on: weights.streamAutoBenchPassed(kept),
        reason: weights.streamAutoBenchPassed(kept) ? "ok" : "slow",
        p95Ms: kept,
      });
    }
    let reply = null;
    try {
      const rule = weights.rule;
      reply = await bench({ chunks: rule.benchChunks, chunkMs: rule.chunkMs });
    } catch {
      reply = null;
    }
    const p95 = reply?.bench?.p95Ms;
    if (!reply?.ok || typeof p95 !== "number" || !Number.isFinite(p95) || p95 < 0) {
      // Nothing measured (no pin yet, a load that failed, a slow first load): the same fallback, and no verdict kept.
      const reason = String(reply?.reason || "bench-failed").slice(0, 48);
      return { ...note({ on: false, reason, p95Ms: null }), reply };
    }
    const providers = Array.isArray(reply.bench.providers)
      ? reply.bench.providers.filter((p) => typeof p === "string").slice(0, 4)
      : [];
    try {
      writeStore({
        v: STREAM_AUTO_VERSION,
        fingerprint,
        p95Ms: Math.round(p95 * 10) / 10,
        providers,
      });
    } catch {
      /* not stored: the next start benches again */
    }
    const passed = weights.streamAutoBenchPassed(p95);
    return { ...note({ on: passed, reason: passed ? "ok" : "slow", p95Ms: p95 }), reply };
  }

  /** The status and Doctor line: `{ state, reason, p95Ms, limitMs, detail }`. */
  function view() {
    const rule = weights.rule;
    const state = last.on === null ? "unknown" : last.on ? "on" : "off";
    let detail = "the live streaming ear decides on its first use (a quick speed check)";
    if (last.on === true) {
      detail = `the live streaming ear is on: a 320 ms chunk took ${last.p95Ms} ms (limit ${rule.p95LimitMs} ms)`;
    } else if (last.reason === "slow") {
      detail = `the live streaming ear stays off: a 320 ms chunk took ${last.p95Ms} ms, over the ${rule.p95LimitMs} ms limit; choose an engine in Settings to use it anyway`;
    } else if (last.on === false && last.reason !== "low-ram" && last.reason !== "few-cores") {
      detail = `the live streaming ear could not be measured yet (${last.reason}); the ordinary listening path runs`;
    } else if (last.on === false) {
      let current = {};
      try {
        current = facts();
      } catch {
        current = {};
      }
      detail = weights.streamAutoHardware(current).detail || detail;
    }
    return { state, reason: last.reason, p95Ms: last.p95Ms, limitMs: rule.p95LimitMs, detail };
  }

  return { decide, known, view };
}

/**
 * FRIDAY's own streaming ear, the Electron side: stream-open, stream-feed and stream-close ride the one speech worker
 * (kernel/stream_ear.py StreamHost). One stream at a time. It holds the one turn gate from open to close, so a final
 * decode never runs beside it and a second stream is refused "busy". It is local only (no cloud call exists on this
 * path, so privacy mode holds by construction) and it never opens the microphone: the renderer owns capture.
 *
 * Every refusal is `{ ok: false, fallback: true, reason }` and never a throw, and a reply that carries `fallback`
 * means the stream is over (the gate is already free): the renderer then uses the ordinary transcribe call.
 * `getWorker` may return nothing: a worker that is not up is a "worker" fallback, never a cold start paid for a guess.
 * `guard` wraps the model load (the governor's one-at-a-time load slot, as loadWorker does).
 */
function createStreamEar({
  gate,
  getWorker,
  request,
  guard = (run) => run(),
  ownerEmbedding = async () => null,
  warmFirst = false,
  auto = null,
  warmMs = STREAM_WARM_MS,
  idleMs = STREAM_IDLE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let current = null; // { id, session, release, timer }
  let seq = 0;
  let warming = null; // the one warm-up in flight: a second asker joins it

  const engineOf = (payload) =>
    typeof payload.streamEngine === "string" ? payload.streamEngine.trim().toLowerCase() : "";

  /** The engine word, or the refusal for it. */
  function engineCheck(payload) {
    const engine = engineOf(payload);
    if (!engine || engine === "off") return { refusal: refused("off") };
    if (!STREAM_ENGINES.includes(engine)) return { refusal: refused("bad-engine") };
    return { engine };
  }

  /**
   * Loads the streaming model on the live worker without opening a stream (op stream-warm), so the next stream-open is
   * quick. It holds no turn gate and starts no worker. Its own limit is `warmMs`: a miss answers "warming" (a fallback,
   * the worker keeps loading and is neither killed nor counted by the breaker); a reply of "warming" from the worker
   * is the same fallback.
   */
  function warm(payload = {}) {
    const checked = engineCheck(payload);
    if (checked.refusal) return Promise.resolve(checked.refusal);
    if (warming) return warming;
    const providers = cleanStreamProviders(payload.providers);
    const run = (async () => {
      let session = null;
      try {
        session = await getWorker();
      } catch {
        session = null;
      }
      if (!session?.alive) return refused("worker");
      let timer = null;
      const MISS = Symbol("warm-miss");
      const missed = new Promise((resolve) => {
        timer = setTimer(() => resolve(MISS), warmMs);
        if (timer && typeof timer.unref === "function") timer.unref();
      });
      const ask = (extra = {}) =>
        Promise.race([
          guard(() =>
            request(
              session,
              {
                op: "stream-warm",
                streamEngine: checked.engine,
                locale: cleanStreamLocale(payload.locale),
                ...(providers.length ? { providers } : {}),
                ...extra,
              },
              {},
            ),
          ),
          missed,
        ]);
      try {
        let reply = null;
        if (checked.engine === "auto" && auto) {
          // "auto": the hardware rule, then the stored bench or one bench now (the bench is a warm that also measures).
          const verdict = await auto.decide(async (bench) => {
            reply = await ask({ bench });
            return reply === MISS ? { ok: false, reason: "warming" } : reply;
          });
          if (!verdict.on) return refused(autoRefusal(verdict.reason));
        }
        if (reply === null) reply = await ask();
        if (reply === MISS) return refused("warming");
        if (!reply?.ok) return refused(String(reply?.reason || "engine-failed").slice(0, 64));
        const { op: _op, id: _id, ...rest } = reply;
        return { ...rest, ok: true };
      } catch {
        return refused("worker");
      } finally {
        clearTimer(timer);
      }
    })();
    warming = run.finally(() => {
      warming = null;
    });
    return warming;
  }

  function end(stream) {
    if (!stream || current !== stream) return false;
    current = null;
    clearTimer(stream.timer);
    stream.timer = null;
    stream.release();
    return true;
  }

  function arm(stream) {
    clearTimer(stream.timer);
    stream.timer = setTimer(() => {
      if (current === stream) abort();
    }, idleMs);
    if (stream.timer && typeof stream.timer.unref === "function") stream.timer.unref();
  }

  /** Tells the worker to drop the audio, best effort: the stream is over for the renderer either way. */
  function discard(stream) {
    if (!stream.session?.alive) return;
    Promise.resolve()
      .then(() => {
        // A newer stream may hold the same id by now (a retried open): its open already replaced this one in the worker,
        // so a close with the shared id would end the wrong stream.
        if (current && current !== stream && current.id === stream.id) return null;
        return request(
          stream.session,
          { op: "stream-close", streamId: stream.id, finalize: false },
          { hardMs: STREAM_CLOSE_MS },
        );
      })
      .catch(() => {});
  }

  /** Mute, idle, shutdown: finishes the stream without finalizing and frees the gate at once. */
  function abort() {
    const stream = current;
    if (!end(stream)) return false;
    discard(stream);
    return true;
  }

  /** The worker is gone: nothing to tell it. Only that session's stream is dropped when one is named. */
  function drop(session) {
    const stream = current;
    if (!stream || (session && stream.session !== session)) return false;
    return end(stream);
  }

  function match(payload) {
    const stream = current;
    if (!stream) return null;
    const asked = typeof payload.streamId === "string" ? payload.streamId : stream.id;
    return asked === stream.id ? stream : null;
  }

  async function open(payload = {}) {
    const checked = engineCheck(payload);
    if (checked.refusal) return checked.refusal;
    const { engine } = checked;
    const providers = cleanStreamProviders(payload.providers);
    const gated = engine === "auto" && auto;
    if (gated && !warmFirst && auto.known()) {
      // A verdict this PC already has: no bench, no worker call.
      const verdict = await auto.decide(async () => null);
      if (!verdict.on) return refused(autoRefusal(verdict.reason));
    }
    // A cold model load is minutes on a slow PC and would outlast the open's 25 s limit, which kills the worker: the
    // warm-up takes the load first (its own limit, no gate held), and the open only reuses the loaded model. An "auto"
    // ear with no verdict yet warms first too: the warm runs its bench.
    if (warmFirst || (gated && !auto.known())) {
      const warmed = await warm({ ...payload, streamEngine: engine });
      if (!warmed.ok) return warmed;
    }
    const rawId =
      typeof payload.streamId === "string" ? payload.streamId.replace(/[^\w.:-]/g, "") : "";
    const id = rawId.slice(0, STREAM_ID_CHARS) || `stream-${++seq}`;
    // The same stream asking again (a renderer that lost its reply) starts over; a different one waits for the gate.
    if (current?.id === id) abort();
    const release = gate.tryEnter();
    if (!release) return refused("busy");
    const stream = { id, session: null, release, timer: null };
    let session = null;
    try {
      session = await getWorker();
    } catch {
      session = null;
    }
    if (!session?.alive) {
      release();
      return refused("worker");
    }
    stream.session = session;
    current = stream;
    const hotwords = cleanStreamHotwords(payload.hotwords);
    const ears = cleanStreamEars(payload.ears);
    // The voiceprint never rides the renderer payload: a renderer-sent one is dropped, and main adds its own stored
    // centroid (safeStorage) to the worker request only. A missing or wrong-size one leaves the speaker unknown.
    delete ears.ownerEmbedding;
    try {
      const owner = cleanStreamEars({ ownerEmbedding: await ownerEmbedding() }).ownerEmbedding;
      if (owner) ears.ownerEmbedding = owner;
    } catch {
      /* no voiceprint: the speaker stays unknown */
    }
    let reply;
    try {
      reply = await guard(() =>
        request(
          session,
          {
            op: "stream-open",
            streamId: id,
            streamEngine: engine,
            locale: cleanStreamLocale(payload.locale),
            ...(hotwords.length ? { hotwords } : {}),
            ...(Object.keys(ears).length ? { ears } : {}),
            ...(typeof payload.endpoint === "boolean" ? { endpoint: payload.endpoint } : {}),
            ...(providers.length ? { providers } : {}),
          },
          { hardMs: STREAM_OPEN_MS },
        ),
      );
    } catch {
      end(stream);
      return refused("worker");
    }
    if (current !== stream) {
      // Muted or shut down while the model was loading: the worker may hold a stream nobody wants.
      discard(stream);
      return refused("aborted");
    }
    if (!reply?.ok) {
      end(stream);
      return refused(String(reply?.reason || "engine-failed").slice(0, 64));
    }
    arm(stream);
    const { op: _op, ...rest } = reply;
    return { ...rest, ok: true, streamId: id };
  }

  async function feed(payload = {}) {
    const stream = match(payload);
    if (!stream) return refused("no-stream");
    const pcm = payload.pcm;
    if (typeof pcm !== "string" || !pcm) {
      end(stream);
      discard(stream);
      return refused("bad-audio");
    }
    if (pcm.length > Math.ceil((MAX_FEED_BYTES * 4) / 3) + 8) {
      end(stream);
      discard(stream);
      return refused("too-large");
    }
    let reply;
    try {
      // A slow feed is a soft miss: the first one closes the stream politely (finalize:false, the renderer falls back to
      // the ordinary transcribe call) and keeps the worker; a second miss in a row, with no stream line between, is a
      // stall and the module stops the child. The no-op onStream is what puts the feed under that stall watch.
      reply = await request(
        stream.session,
        { op: "stream-feed", streamId: stream.id, pcm },
        {
          hardMs: STREAM_FEED_HARD_MS,
          softMs: STREAM_FEED_MS,
          stallMisses: 2,
          onStream: () => {},
          onSlow: ({ misses }) => {
            if (misses === 1 && end(stream)) discard(stream);
          },
        },
      );
    } catch {
      end(stream);
      return refused("worker");
    }
    if (current !== stream) return refused("no-stream");
    if (!reply?.ok) {
      end(stream);
      discard(stream);
      return refused(String(reply?.reason || "engine-failed").slice(0, 64));
    }
    arm(stream);
    const { op: _op, ...rest } = reply;
    return {
      ...rest,
      ok: true,
      streamId: stream.id,
      events: Array.isArray(reply.events) ? reply.events : [],
      text: typeof reply.text === "string" ? reply.text : "",
      committed: typeof reply.committed === "string" ? reply.committed : "",
      audioMs: Number(reply.audioMs) || 0,
      endpoint: reply.endpoint && typeof reply.endpoint === "object" ? reply.endpoint : {},
    };
  }

  async function close(payload = {}) {
    const stream = match(payload);
    if (!stream) return refused("no-stream");
    const finalize = payload.finalize !== false;
    clearTimer(stream.timer);
    stream.timer = null;
    let reply;
    try {
      reply = await request(
        stream.session,
        { op: "stream-close", streamId: stream.id, finalize },
        { hardMs: STREAM_CLOSE_MS },
      );
    } catch {
      end(stream);
      return refused("worker");
    }
    end(stream);
    if (!reply?.ok) return refused(String(reply?.reason || "engine-failed").slice(0, 64));
    const { op: _op, ...rest } = reply;
    return {
      ...rest,
      ok: true,
      streamId: stream.id,
      final: reply.final === true,
      text: typeof reply.text === "string" ? reply.text : "",
      words: Array.isArray(reply.words) ? reply.words : [],
      audioMs: Number(reply.audioMs) || 0,
      rtf: Number(reply.rtf) || 0,
    };
  }

  return { open, warm, feed, close, abort, drop, active: () => current?.id ?? "" };
}

/** The "auto" verdict of this PC (status and Doctor read `streamAuto.view()`). */
const streamAuto = createStreamAuto();
/** The live worker, or nothing: the stream ear never starts one (the ordinary transcribe path does that). */
const streamEar = createStreamEar({
  gate: turnGate,
  getWorker: () => (worker?.alive ? worker : null),
  request: (session, payload, limits) =>
    workerRequest(session, payload, limits.hardMs, limits.onStream, limits),
  guard: guardedLoad,
  ownerEmbedding: () => require("./voiceprint.cjs").loadOwnerEmbedding(),
  warmFirst: true,
  auto: streamAuto,
  // Looked up at call time, so a test's fake timers and the real ones both work.
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
});
const streamOpen = (payload) => streamEar.open(payload || {});
const streamWarm = (payload) => streamEar.warm(payload || {});
const streamFeed = (payload) => streamEar.feed(payload || {});
const streamClose = (payload) => streamEar.close(payload || {});

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
      reason: layers.reason || probeReason || "The FRIDAY Ear speech engine is not installed yet.",
    };
  }
  value.moonshineReady = Boolean(layers.moonshineReady);
  value.windowsSpeech = Boolean(layers.windowsSpeech);
  value.cudaRuntimeReady = Boolean(layers.cudaRuntimeReady);
  value.ownEars = lastOwnEars;
  value.streamAuto = streamAuto.view();
  if (typeof lastHinglishEar.ready === "boolean")
    value.hinglishEarTrelisReady = lastHinglishEar.ready;
  if (lastHinglishEar.skipped) value.hinglishEarSkipped = lastHinglishEar.skipped;
  value.cache = worker?.alive ? lastWorkerCache : null;
  if (!value.available && (value.moonshineReady || value.windowsSpeech)) {
    value.available = true;
    value.ready = false;
    value.engine = value.moonshineReady ? "moonshine" : "windows-speech";
  }
  if (!value.available && !localOnly) {
    const engine = cloudEngine();
    // A connected key is not consent: the cloud-voice gate must also say yes (consent, provider, privacy, billing).
    if (engine && cloudAllowed(engine)) {
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
  // Nothing in the status that reaches the renderer names a folder of this PC.
  if (typeof value.reason === "string") value.reason = scrubPaths(value.reason);
  if (typeof value.python === "string") value.python = scrubPaths(value.python);
  return value;
}

/**
 * What a live worker says about itself, read without ever standing in a turn's way. The module's cached status and
 * lastLocalLayers (the model this file loaded) answer by themselves; the worker is asked for its cache rows only
 * when it is idle (not busy, no turn at the gate, no stream open). A ping queued behind a decode used to miss its
 * 15 s deadline and kill the healthy worker; now a missed ping proves nothing and changes nothing.
 */
async function refreshFromWorker() {
  const session = worker;
  const view = getVoiceWorker().status();
  lastLocalLayers.worker = "ready";
  if (view.state !== "ready" || turnGate.busy() || streamEar.active()) return;
  try {
    const ping = await workerRequest(session, { op: "status" }, 60000);
    copyLadder(ping);
    noteWorkerCache(ping);
    lastLocalLayers.dependency =
      ping?.dependency === "ready" || ping?.available ? "ready" : "missing";
    lastLocalLayers.inference =
      ping?.inference === "verified" || ping?.modelLoaded ? "verified" : "unverified";
    lastLocalLayers.loadCount = ping?.loadCount || lastLocalLayers.loadCount;
    lastLocalLayers.model = ping?.model || lastLocalLayers.model;
    lastLocalLayers.reason = ping?.error ? scrubPaths(ping.error) : null;
  } catch {
    /* the module's own view above is the health check */
  }
}

/** Can FRIDAY transcribe on this machine right now? Cached — this may spawn. */
async function status(force = false, options = {}) {
  // This PC only, unless the caller says otherwise in so many words (fail closed).
  const localOnly = options?.localOnly !== false;
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
          "The FRIDAY Ear fallback is on disk. Listening still needs a wav capture; this build does not mark it ready.",
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
      lastLocalLayers.reason = scrubPaths(
        voiceInstall.classifyDownloadError(String(error?.message || error)).line,
      );
      if (lastLocalLayers.dependency !== "ready") lastLocalLayers.dependency = "missing";
      if (lastLocalLayers.inference !== "verified") lastLocalLayers.inference = "failed";
    }
  } else if (worker?.alive) {
    await refreshFromWorker();
  } else if (getVoiceWorker().status().state === "starting") {
    // Loading: the layers are what the start leaves behind. No probe process and no ping queued behind the load.
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
      lastLocalLayers.reason = scrubPaths(
        parsed?.error ||
          (probe.stderr || "The FRIDAY Ear speech engine is not installed yet.").slice(-400),
      );
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
      return { ok: false, cause, error: scrubPaths(voiceInstall.explain(cause, pip.stderr)) };
    }
    // Look first: a package that is already there and in range is not installed again, and a Fix voice
    // press on a working engine no longer runs pip. The newest release is only read, never forced.
    const found = await probePackages(py);
    const needed = options.upgrade || !found.satisfied;
    reportProgress({
      stage: "check",
      status: found.satisfied
        ? `Speech engine is installed (FRIDAY Ear ${found.versions["faster-whisper"]})`
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
      return { ok: false, cause, error: scrubPaths(voiceInstall.explain(cause, result.stderr)) };
    }
    const imported = await run(py[0], [...py[1], "-c", "import faster_whisper"], 60000);
    if (!imported.ok) {
      return {
        ok: false,
        cause: "import-failed",
        error: scrubPaths(voiceInstall.explain("import-failed", imported.stderr)),
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
          error: scrubPaths(voiceInstall.explain("import-failed", now.reason)),
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
    // The opt-in Hinglish ear: only the one named engine is passed on; anything else sends nothing.
    ...(req.hinglishEar === "trelis" ? { hinglishEar: "trelis" } : {}),
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
 * does not wait for the decode: it marks the entry and sends one cancel op to the worker, which reads its input on its
 * own thread and answers it at once. The worker is not stopped for a cancel.
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
  if (flagged > 0 && session?.alive) {
    // The kernel reads its input on its own thread and answers a cancel at once, whatever the decode is doing. The
    // request is written before this call returns; a missing answer is dropped, the decode is flagged anyway.
    signalled = true;
    workerRequest(session, { op: "cancel", utteranceId: key }, 30000).catch(() => {});
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
 * @param {{ audioBase64?: string, audioBytes?: Uint8Array, mime?: string, language?: string, model?: string, initialPrompt?: string, hotwords?: string, multilingual?: boolean, localOnly?: boolean, provisional?: boolean, utteranceId?: string }} req
 */
async function transcribe(req = {}, onPartial) {
  const refusal = refuseUnsafeAudio(req, MAX_TRANSCRIBE_BYTES);
  if (refusal) return refusal;
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

/** The size of the audio a request carries, from its length alone: nothing is decoded or written to find it out. */
function audioSizeOf(req = {}) {
  const raw = req.audioBytes;
  if (raw && (raw.length || raw.byteLength)) return raw.byteLength ?? raw.length;
  const text = String(req.audioBase64 || "");
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - pad);
}

/** Main never reads a path the renderer names, and never takes more audio than a spoken turn is worth. */
function refuseUnsafeAudio(req, cap) {
  if (req.path !== undefined && req.path !== null && req.path !== "") {
    return {
      ok: false,
      reason: "path-not-allowed",
      error: "Audio is sent as bytes only; a file path is not accepted.",
    };
  }
  if (audioSizeOf(req) > cap) {
    return {
      ok: false,
      reason: "audio-too-large",
      error: "That audio is too long to transcribe in one piece.",
    };
  }
  return null;
}

async function transcribeNow(req = {}, onPartial) {
  noteListeningPref(req);
  const state = await status(false, { localOnly: req.localOnly !== false });
  const ladderReady = Boolean(state.moonshineReady || state.windowsSpeech);
  if (!state.available && !ladderReady)
    return { ok: false, reason: "unavailable", error: state.reason };

  // A speculative read is only ever made by the local speech worker that already holds the model. A cloud engine
  // (a paid, remote call for every guess, and not cancellable) or a one-shot process never reads early.
  if (req.provisional === true && state.engine !== "faster-whisper") {
    return { ok: false, reason: "not-ready", ...EARLY_READ_UNSUPPORTED };
  }

  const bytes = req.audioBytes
    ? Buffer.from(req.audioBytes)
    : Buffer.from(String(req.audioBase64 || ""), "base64");
  if (!bytes.length) return { ok: false, reason: "no-audio", error: "No audio was captured." };
  const ext = /wav/i.test(req.mime || "") ? "wav" : /ogg/i.test(req.mime || "") ? "ogg" : "webm";
  const file = path.join(audioDir(), `${crypto.randomBytes(8).toString("hex")}.${ext}`);
  try {
    fs.writeFileSync(file, bytes);
  } catch (error) {
    return { ok: false, reason: "write-failed", error: scrubPaths(error?.message || error) };
  }

  const started = Date.now();
  try {
    if (String(state.engine || "").startsWith("cloud:")) {
      const engine = cloudEngine();
      if (!engine)
        return { ok: false, reason: "unavailable", error: "the connected transcriber went away" };
      // Asked again here: a consent or privacy mode changed since the status check still wins over the upload.
      if (req.localOnly !== false || !cloudAllowed(engine)) {
        return {
          ok: false,
          reason: "cloud-stt-not-allowed",
          error:
            "Cloud transcription is not allowed right now (consent, provider, privacy mode or billing).",
        };
      }
      return await cloudTranscribe(engine, file, req.language);
    }
    if (state.engine === "whisper.cpp") {
      const whisperApi = require("./whisper-cpp.cjs");
      const found = whisperApi.locateFrom([paths.root(), process.resourcesPath]);
      if (!found) {
        return {
          ok: false,
          reason: "unavailable",
          error: "The FRIDAY Ear fallback files are missing",
        };
      }
      if (!/\.wav$/i.test(file)) {
        return {
          ok: false,
          reason: "format",
          error: "The FRIDAY Ear fallback needs a wav capture. This clip is not wav.",
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
          error: scrubPaths(
            (result.stderr || "The FRIDAY Ear fallback returned no text").slice(-400),
          ),
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
        transcribeDeadlineMs(loadBudget, file),
        onPartial,
      );
    } catch (error) {
      lastLocalLayers.worker = "crashed";
      lastLocalLayers.inference = "failed";
      // A child that took no more requests (write failed) is stopped by the module, never left running unreferenced.
      if (error?.code === "write-failed") void getVoiceWorker().stop();
      // The module counts every crash, deadline and failed start: three in a minute open its breaker.
      const waitMs = crashLoopWaitMs();
      if (
        error?.code === "breaker-open" ||
        getVoiceWorker().status().state === "breaker-open" ||
        waitMs > 0
      ) {
        const heard = await windowsSpeechOneShot(file);
        if (heard) {
          return {
            ok: true,
            text: heard,
            language: "",
            model: "windows-speech",
            elapsedMs: Date.now() - started,
            engine: "windows-speech",
          };
        }
        return crashLoopReply(waitMs || 30_000);
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
            transcribeDeadlineMs(loadBudget, file),
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
            transcribeDeadlineMs(voiceInstall.loadBudgetMs(fallback), file),
            onPartial,
          );
        } else {
          throw error;
        }
      } catch (retryError) {
        return {
          ok: false,
          reason: "engine-failed",
          error: scrubPaths(
            String(retryError?.message || error?.message || retryError).slice(-500),
          ),
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
        error: parsed.error === undefined ? parsed.error : scrubPaths(parsed.error),
        sttClass: parsed.sttClass || parsed.reason || "",
        fix: parsed.fix || "",
      };
    lastLocalLayers.inference = "verified";
    crashLoopClear();
    lastLocalLayers.loadCount = parsed.loadCount || lastLocalLayers.loadCount;
    lastLocalLayers.model = model;
    cachedStatus = null;
    if (req.hinglishEar === "trelis") {
      lastHinglishEar.skipped = String(parsed.hinglishEarSkipped || "").slice(0, 160);
    }
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
      ...(parsed.hinglishEarSkipped
        ? { hinglishEarSkipped: String(parsed.hinglishEarSkipped).slice(0, 160) }
        : {}),
      turnProbability: typeof parsed.turnProbability === "number" ? parsed.turnProbability : null,
      loadCount: parsed.loadCount,
      emptyReason: String(parsed.emptyReason || (parsed.audio && parsed.audio.emptyReason) || ""),
      audio: parsed.audio || null,
      ...liveReplyFields(parsed),
    };
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* the cache folder is cleaned on next boot */
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
 * The module's own busy view counts as well as this file's requests: a score never sits in a queue.
 */
async function scoreInWorker(clip, session = worker) {
  // A worker that is still loading is not "no worker": the plain pause closes the turn, no one-shot process starts.
  if (session === worker && getVoiceWorker().status().state === "starting") {
    return { ok: true, ready: false, probability: null, reason: "busy" };
  }
  if (!session?.alive) return null;
  // A score is a short request with its own 20 s deadline, and a request that misses its deadline kills the worker.
  // Queued behind a cold load (or a model reload) it would take the half-loaded worker down with it: only a loaded
  // worker with nothing in flight is asked, and anything else closes the turn on the plain pause.
  if (
    turnGate.busy() ||
    !session.loaded ||
    session.pending.size > 0 ||
    getVoiceWorker().status().state === "busy"
  ) {
    return { ok: true, ready: false, probability: null, reason: "busy" };
  }
  try {
    const audioB64 = Buffer.from(clip).toString("base64");
    const parsed = await workerRequest(session, { op: "score-turn", audioB64 }, 20000);
    if (!parsed || typeof parsed !== "object" || parsed.reason === "unknown-op") return null;
    return {
      ok: true,
      ready: Boolean(parsed.ready),
      probability: typeof parsed.probability === "number" ? parsed.probability : null,
      reason: scrubPaths(String(parsed.reason || "")),
    };
  } catch {
    return null;
  }
}

/**
 * The worker's deadline for one transcribe: the model's load budget, or three times the clip's length when that is longer.
 * A 3 to 5 minute dictation on a CPU decodes in chunks and can outlast a load budget sized for a short utterance.
 * Only a 16 kHz mono 16-bit WAV (what the capture ring sends) is measured; any other clip keeps the load budget.
 */
function transcribeDeadlineMs(loadBudget, file) {
  try {
    if (!/\.wav$/i.test(String(file || ""))) return loadBudget;
    const bytes = fs.statSync(file).size;
    const seconds = Math.max(0, bytes - 44) / 32000;
    return Math.max(loadBudget, Math.round(seconds * 3000));
  } catch {
    return loadBudget;
  }
}

async function scoreTurn(req = {}) {
  if (audioSizeOf(req) > MAX_SCORE_BYTES) {
    return { ok: true, ready: false, probability: null, reason: "audio-too-large" };
  }
  const bytes = turnAudioBuffer(req);
  if (!bytes.length) return { ok: true, ready: false, probability: null, reason: "no-audio" };
  // The clip rides to the warm worker as bytes (no file). A cold worker is skipped: a fresh interpreter with its
  // imports costs one to three seconds, longer than the plain pause it would improve on.
  const warm = await scoreInWorker(bytes);
  if (warm) return warm;
  return { ok: true, ready: false, probability: null, skipped: "cold", reason: "cold" };
}

let whisperSession = null;
let whisperServerTried = false;

function onMute(muted) {
  if (!muted) return { stopped: false };
  streamEar.abort();
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
  if (worker === session) streamEar.drop(session);
  onMute(true);
  if (worker === session) {
    speechHeld?.release();
    speechHeld = null;
  }
  lastLocalLayers.worker = "stopped";
  lastLocalLayers.inference = "unverified";
  cachedStatus = null;
  // The child is stopped on purpose (not a crash): the next turn starts a new one. One that is still starting is
  // stopped too, so a quit never leaves a half-started child behind.
  if (session?.alive || (session === worker && getVoiceWorker().status().state === "starting")) {
    void getVoiceWorker().stop();
  }
}

/**
 * A clean slate with the given replacements (python, run, weights, spawn, killTree, cloudEngine, cloudTranscribe),
 * for tests only: the app never calls it. Calling it with nothing restores every default.
 */
function useForTests(overrides = {}) {
  streamEar.abort();
  const previous = voiceWorker;
  for (const key of Object.keys(hooks)) delete hooks[key];
  Object.assign(hooks, overrides);
  voiceWorker = null;
  worker = null;
  startPlan = null;
  cachedStatus = null;
  cloudGate = null;
  speechHeld = null;
  lastLocalLayers = initialLayers();
  lastWorkerCache = null;
  lastHinglishEar = { ready: null, skipped: "" };
  everReady = false;
  speechIdleMs = 0;
  idleDirty = false;
  crashLoopClear();
  provisionals.clear();
  if (previous) void previous.stop();
}

/**
 * Memory pressure (electron/resource-governor.cjs): close the speech worker when it has nothing in flight and has
 * not been asked anything for `minIdleMs`. It starts again on the next turn. Returns whether it was closed.
 */
function releaseIdle(minIdleMs = 60_000, session = worker) {
  if (!session?.alive || session.pending.size > 0 || streamEar.active()) return false;
  if (getVoiceWorker().status().state === "busy") return false;
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
  scrubPaths,
  cleanStreamEars,
  cleanOwnEars,
  transcribeDeadlineMs,
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
  createStreamEar,
  createStreamAuto,
  streamAutoFingerprint,
  streamOpen,
  streamWarm,
  setSpeechProfile,
  streamFeed,
  streamClose,
  STREAM_ENGINES,
  workerRequest,
  setCloudGate,
  useForTests,
  scoreInWorker,
  workerCacheOf,
  scoreTurn,
  run,
  turnAudioBuffer,
  sweep,
  shutdown,
  releaseIdle,
  onMute,
  MODELS,
  DEFAULT_MODEL,
  tmpdir: os.tmpdir,
};
