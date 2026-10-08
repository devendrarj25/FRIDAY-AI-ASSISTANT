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
const paths = require("./friday-paths.cjs");
const { resolvePython } = require("./python.cjs");
const { fetchCompat } = require("./net-fetch.cjs");
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
const MODELS = ["tiny", "base", "small", "medium", "large-v3"];
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
  const res = await fetchCompat(`${engine.base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${engine.key}` },
    body: form,
  });
  const body = await res.text();
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
let inFlight = 0;
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
};

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

function parse(stdout) {
  const text = String(stdout || "").trim();
  const start = text.lastIndexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
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
  return session;
}

function workerRequest(session, payload, timeoutMs, onStream) {
  const id = ++workerSeq;
  return new Promise((resolve, reject) => {
    if (!session?.alive || !session.child?.stdin || session.child.stdin.destroyed) {
      reject(new Error("STT worker is not running"));
      return;
    }
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error("STT worker timed out"));
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

async function prepareWeights(model) {
  const weights = require("./voice-weights.cjs");
  return weights.ensureSttWeights(model, paths.root() || "", {
    exists: (file) => fs.existsSync(file),
    downloadModel: require("./model-download.cjs").downloadModel,
  });
}

async function ensureWorker(model) {
  const wanted = MODELS.includes(model) ? model : DEFAULT_MODEL;
  const prepared = await prepareWeights(wanted);
  if (!prepared.ok) throw new Error(prepared.error || "speech weights are not on disk");
  const modelPath = prepared.dir;
  if (worker?.alive) {
    if (worker.modelName && worker.modelName !== wanted) {
      const loaded = await workerRequest(
        worker,
        { op: "load", model: wanted, model_path: modelPath },
        180000,
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
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      FRIDAY_ROOT: paths.root() || process.env.FRIDAY_ROOT || "",
      FRIDAY_STT_TIER: "auto",
      FRIDAY_RAM_GB: String(Math.round((os.totalmem() / 1024 ** 3) * 10) / 10),
    },
  });
  const session = attachWorker(child, generation);
  worker = session;
  lastLocalLayers.worker = "ready";
  const ping = await workerRequest(session, { op: "status" }, 30000);
  if (ping?.dependency === "missing" || ping?.available === false) {
    lastLocalLayers.dependency = "missing";
    lastLocalLayers.reason = ping?.error || "faster-whisper is not installed yet.";
    throw new Error(lastLocalLayers.reason);
  }
  lastLocalLayers.dependency = "ready";
  const loaded = await workerRequest(
    session,
    { op: "load", model: wanted, model_path: modelPath },
    180000,
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
    lastLocalLayers = {
      dependency: "missing",
      worker: worker?.alive ? lastLocalLayers.worker : "stopped",
      inference: "unverified",
      loadCount: lastLocalLayers.loadCount || 0,
      model: DEFAULT_MODEL,
      reason: require("./voice-install.cjs").explain("no-python"),
    };
    const value = snapshotStatus({ localOnly, py: null, pythonPath: null });
    if (!localOnly) cachedStatus = { at: Date.now(), value };
    return value;
  }

  if (warm) {
    try {
      const voiceInstall = require("./voice-install.cjs");
      const boot = voiceInstall.bootModel({ requested: "auto" });
      await ensureWorker(boot.model);
    } catch (error) {
      lastLocalLayers.reason = String(error?.message || error);
      if (lastLocalLayers.dependency !== "ready") lastLocalLayers.dependency = "missing";
      if (lastLocalLayers.inference !== "verified") lastLocalLayers.inference = "failed";
    }
  } else if (worker?.alive) {
    try {
      const ping = await workerRequest(worker, { op: "status" }, 15000);
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

/** Install the transcriber into the same interpreter Install Manager uses. */
async function install() {
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
    const result = await run(
      py[0],
      [...py[1], "-m", "pip", "install", "--upgrade", "faster-whisper"],
      600000,
    );
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
      ? { ok: true, model: now.model }
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
 * Transcribe one utterance.
 * @param {{ audioBase64?: string, path?: string, mime?: string, language?: string, model?: string, initialPrompt?: string, localOnly?: boolean }} req
 */
async function transcribe(req = {}, onPartial) {
  const state = await status(false, { localOnly: Boolean(req.localOnly) });
  if (!state.available) return { ok: false, reason: "unavailable", error: state.reason };

  if (inFlight >= 1)
    return { ok: false, reason: "busy", error: "A transcription is already running." };

  let file = req.path && fs.existsSync(req.path) ? req.path : null;
  let temporary = false;
  if (!file) {
    const bytes = Buffer.from(String(req.audioBase64 || ""), "base64");
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

  inFlight += 1;
  try {
    if (String(state.engine || "").startsWith("cloud:")) {
      const engine = cloudEngine();
      if (!engine)
        return { ok: false, reason: "unavailable", error: "the connected transcriber went away" };
      return await cloudTranscribe(engine, file, req.language);
    }
    const voiceInstall = require("./voice-install.cjs");
    const explicit = MODELS.includes(req.model) ? req.model : "";
    const boot = voiceInstall.bootModel({ requested: explicit || "auto" });
    const model = explicit || boot.model;
    const loadBudget = voiceInstall.loadBudgetMs(model);
    const locked = whisperLanguage(req.language);
    const prompt = String(req.initialPrompt || req.initial_prompt || "").trim();
    const started = Date.now();
    let parsed;
    try {
      const session = await ensureWorker(model);
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
          },
          voiceInstall.loadBudgetMs(fallback),
          onPartial,
        );
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
    if (!parsed.ok) return { ok: false, reason: parsed.reason || "failed", error: parsed.error };
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
      turnProbability: typeof parsed.turnProbability === "number" ? parsed.turnProbability : null,
      loadCount: parsed.loadCount,
    };
  } finally {
    inFlight -= 1;
    if (temporary) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* the cache folder is cleaned on next boot */
      }
    }
  }
}

async function scoreTurn(req = {}) {
  const bytes = Buffer.from(String(req.audioBase64 || ""), "base64");
  if (!bytes.length) return { ok: true, ready: false, probability: null, reason: "no-audio" };
  const ext = /wav/i.test(req.mime || "") ? "wav" : /ogg/i.test(req.mime || "") ? "ogg" : "webm";
  const file = path.join(audioDir(), `${crypto.randomBytes(8).toString("hex")}.${ext}`);
  try {
    fs.writeFileSync(file, bytes);
  } catch (error) {
    return { ok: true, ready: false, probability: null, reason: String(error?.message || error) };
  }
  try {
    const py = await python();
    if (!py) return { ok: true, ready: false, probability: null, reason: "no-python" };
    const runtime = path.join(__dirname, "..", "kernel", "voice_runtime.py");
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

function shutdown() {
  const session = worker;
  worker = null;
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
  install,
  transcribe,
  scoreTurn,
  sweep,
  shutdown,
  MODELS,
  DEFAULT_MODEL,
  tmpdir: os.tmpdir,
};
