/**
 * FRIDAY · neural voice
 *
 * Offline speech is FRIDAY Voice (the own engine over the Supertonic 3 graphs, her default voice) when that
 * model is on disk, through kernel/voice_runtime.py. Until then the Windows SAPI voice speaks.
 * The speaker process stays up so the model is not loaded again for every line.
 *
 * edge-tts is the cloud path: Microsoft neural voices, including
 * hi-IN-SwaraNeural and en-IN-NeerjaNeural. It runs only when the caller
 * passes one of those Neural voice ids and the text is not sensitive.
 * A fresh install asks for Swara. Privacy mode passes no Neural id.
 * Sensitive text stays on the local model or the system voice.
 *
 * Rules kept from the rest of FRIDAY:
 *   · the interpreter comes from the shared resolver (electron/python.cjs)
 *   · every byte written stays inside the selected FRIDAY root (cache/tts)
 *   · nothing is faked: a missing local model is not called ready, and a
 *     failed synth falls back to the existing SAPI voices.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const paths = require("./friday-paths.cjs");
const { resolvePython } = require("./python.cjs");
const { parseJsonLine } = require("./json-line.cjs");
const { classify } = require("./privacy-firewall.cjs");
const { trackOwned } = require("./app-lifecycle.cjs");
const { createVoiceWorker } = require("./voice-worker.cjs");

const RUNTIME_SCRIPT = path.join(__dirname, "..", "kernel", "voice_runtime.py");

/** Voices FRIDAY offers by default — Indian female, Hindi + Indian English. */
const PREFERRED = [
  { id: "hi-IN-SwaraNeural", label: "Swara · Hindi (India) · neural", lang: "hi-IN" },
  { id: "en-IN-NeerjaNeural", label: "Neerja · English (India) · neural", lang: "en-IN" },
  {
    id: "en-IN-NeerjaExpressiveNeural",
    label: "Neerja Expressive · English (India) · neural",
    lang: "en-IN",
  },
  { id: "hi-IN-MadhurNeural", label: "Madhur · Hindi (India) · neural", lang: "hi-IN" },
  { id: "en-IN-PrabhatNeural", label: "Prabhat · English (India) · neural", lang: "en-IN" },
];

let installing = null;
let cachedStatus = null;

const cacheDir = () => {
  const dir = path.join(paths.ensureDir("cache"), "tts");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* reported by the write that follows */
  }
  return dir;
};

function run(exe, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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

/**
 * The local voice styles the speech worker understands. An id is only ever one of these exact words (matched
 * ignoring case, then sent in its canonical spelling), never a path, a flag or free text. An empty style means
 * FRIDAY's own default voice.
 */
const LOCAL_STYLES = [
  "friday",
  "friday-bright",
  "friday-calm",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "M1",
  "M2",
];
const LOCAL_STYLE_DEFAULT = "friday";
/** The engines the worker may name in its status: FRIDAY's own runner, the old package, or none. */
const FRIDAY_VOICE_ENGINES = new Set(["friday-voice", "supertonic-3", "none"]);

/** The states the speech engine reports for itself (kernel `engineState`). */
const FRIDAY_VOICE_ENGINE_STATES = new Set(["idle", "ready", "failing", "stopped"]);

/** A failing or stopped engine says when it tries again, unless its own reason already does. */
function withRetryHint(reason, engineState, retryIn) {
  if (!retryIn || (engineState !== "failing" && engineState !== "stopped")) return reason;
  if (/next try in/i.test(reason)) return reason;
  const hint = `Next try in ${retryIn} s.`;
  return (reason ? `${reason} ${hint}` : hint).slice(0, 200);
}

/** The canonical style id for a value, or "" (the default voice) when it is not on the list. */
function normaliseLocalStyle(style) {
  if (typeof style !== "string") return "";
  const wanted = style.trim().toLowerCase();
  if (!wanted || wanted.length > 16) return "";
  return LOCAL_STYLES.find((id) => id.toLowerCase() === wanted) || "";
}

/**
 * The own speech engine as the worker reports it, made safe to hand to the renderer: a known engine name, flags,
 * a style id from the allowed list, numbers, and a short reason. Anything else reads as "not reported".
 */
function normaliseFridayVoiceStatus(raw) {
  const tts =
    raw && typeof raw === "object" ? (raw.tts && typeof raw.tts === "object" ? raw.tts : raw) : {};
  const engine = FRIDAY_VOICE_ENGINES.has(tts.engine) ? tts.engine : "none";
  const voiceId = normaliseLocalStyle(tts.voiceId) || normaliseLocalStyle(tts.voice);
  const rate = Number(tts.sampleRate);
  const recipe = Number(tts.recipeVersion);
  const reason =
    typeof tts.reason === "string"
      ? tts.reason
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .trim()
          .slice(0, 200)
      : "";
  const failures = Number(tts.failures);
  const retryInS = Number(tts.retryInS);
  const stateRaw = typeof tts.engineState === "string" ? tts.engineState : tts.state;
  const state = typeof stateRaw === "string" ? stateRaw.toLowerCase().slice(0, 32) : "";
  const engineState = FRIDAY_VOICE_ENGINE_STATES.has(tts.engineState) ? tts.engineState : "";
  const retryIn =
    Number.isFinite(retryInS) && retryInS > 0 ? Math.min(3600, Math.ceil(retryInS)) : 0;
  return {
    engine,
    own: engine === "friday-voice" && tts.own === true,
    ready: engine !== "none" && tts.ready !== false,
    voiceId,
    sampleRate: cleanSampleRate(rate),
    recipeVersion: Number.isFinite(recipe) && recipe >= 0 ? Math.floor(recipe) : 0,
    reason: withRetryHint(reason, engineState, retryIn),
    ...(engineState ? { engineState } : {}),
    ...(retryIn ? { retryInS: retryIn } : {}),
    ...(typeof tts.live === "boolean" ? { live: tts.live } : {}),
    ...(/^[a-z0-9-]+$/.test(state) ? { state } : {}),
    ...(Number.isFinite(failures) ? { failures: Math.max(0, Math.floor(failures)) } : {}),
  };
}

/** A worker's sample rate, or 0 when it is not a number from 8000 to 192000. */
function cleanSampleRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 8000 && rate <= 192000 ? Math.round(rate) : 0;
}

/** The running speech worker's own status line, or null when no worker is up (it is never started for this). */
async function askRunningWorker(py) {
  // A busy speaker is never asked (the question would queue behind the clause); the cold read answers instead.
  if (speakerState() !== "ready") return null;
  const answered = await speakerRequest(py, { op: "status" }, 15000);
  return answered && typeof answered === "object" ? answered : null;
}

/** A fresh process's status read: it knows what is installed, not what the running worker is doing. */
async function askColdProcess(py) {
  const probe = await run(py[0], [...py[1], runtimeScript(), "--status"], 20000);
  return probe.ok ? parseJsonLine(probe.stdout) : null;
}

/**
 * What the speech worker says about the own voice engine; never throws, and says why when it cannot tell. The
 * running worker is asked first (live:true); a cold read of the files is the fallback and says live:false.
 */
async function fridayVoiceStatus(py, { ask = askRunningWorker, cold = askColdProcess } = {}) {
  if (!py) {
    return {
      ...normaliseFridayVoiceStatus({ reason: "Python 3.12+ was not found." }),
      live: false,
    };
  }
  try {
    const answered = await ask(py);
    if (answered?.tts && typeof answered.tts === "object" && answered.tts.live === true) {
      return { ...normaliseFridayVoiceStatus(answered), live: true };
    }
  } catch {
    /* the running worker could not be asked: the cold read below is the honest fallback */
  }
  let parsed = null;
  try {
    parsed = await cold(py);
  } catch {
    parsed = null;
  }
  const status = normaliseFridayVoiceStatus(
    parsed || { reason: "the speech runtime did not answer" },
  );
  return { ...status, live: false };
}

/** Is edge-tts importable right now? Cached briefly — this spawns a process. */
async function status(force = false) {
  if (cachedStatus && !force && Date.now() - cachedStatus.at < 60000) return cachedStatus.value;
  const py = await python();
  let value;
  const fridayVoice = await fridayVoiceStatus(py);
  if (!py) {
    value = {
      available: false,
      reason: "Python 3.12+ was not found — install it from Install Manager.",
      engine: "edge-tts",
      networkRequired: true,
      offline: false,
      fridayVoice,
    };
  } else {
    const probe = await run(
      py[0],
      [...py[1], "-c", "import edge_tts,sys;print(edge_tts.__version__)"],
      20000,
    );
    value = probe.ok
      ? {
          available: true,
          version: probe.stdout.trim(),
          python: py[0],
          engine: "edge-tts",
          networkRequired: true,
          offline: false,
          fridayVoice,
        }
      : {
          available: false,
          reason: "edge-tts is not installed yet.",
          python: py[0],
          engine: "edge-tts",
          networkRequired: true,
          offline: false,
          fridayVoice,
        };
  }
  cachedStatus = { at: Date.now(), value };
  return value;
}

/** Install edge-tts with the same pip path every other Python dependency uses. */
async function install() {
  if (installing) return installing;
  installing = (async () => {
    const py = await python();
    if (!py) return { ok: false, error: "No supported Python interpreter found." };
    const result = await run(
      py[0],
      [...py[1], "-m", "pip", "install", "--upgrade", "edge-tts"],
      300000,
    );
    cachedStatus = null;
    const now = await status(true);
    return now.available
      ? { ok: true, version: now.version }
      : { ok: false, error: (result.stderr || "pip install edge-tts failed").slice(-600) };
  })().finally(() => {
    installing = null;
  });
  return installing;
}

/** The neural voices FRIDAY can actually use (live list when possible). */
async function voices() {
  const state = await status();
  if (!state.available) return { available: false, reason: state.reason, voices: PREFERRED };
  const py = await python();
  const listed = await run(py[0], [...py[1], "-m", "edge_tts", "--list-voices"], 45000);
  if (!listed.ok) return { available: true, voices: PREFERRED };
  const found = [];
  for (const line of listed.stdout.split(/\r?\n/)) {
    const name = line.trim().split(/\s+/)[0];
    if (!/^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(name || "")) continue;
    if (!/^(hi|en|mr|bn|ta|te|gu|kn|ml|pa|ur)-IN-/.test(name)) continue;
    found.push({
      id: name,
      label: `${name.split("-")[2].replace("Neural", "")} · ${name.slice(0, 5)} · neural`,
      lang: name.slice(0, 5),
    });
  }
  const merged = [...PREFERRED];
  for (const v of found) if (!merged.some((m) => m.id === v.id)) merged.push(v);
  return { available: true, voices: merged };
}

const pct = (value, base = 1) => {
  const delta = Math.round((Number(value ?? base) / base - 1) * 100);
  return `${delta >= 0 ? "+" : ""}${delta}%`;
};

/**
 * Synthesize one segment and return playable audio bytes.
 * The result is cached on disk by (text, voice, tuning) so repeated lines are
 * instant and cost nothing.
 */
function runtimeScript() {
  if (fs.existsSync(RUNTIME_SCRIPT)) return RUNTIME_SCRIPT;
  const packaged = path.join(process.resourcesPath || "", "kernel", "voice_runtime.py");
  return fs.existsSync(packaged) ? packaged : RUNTIME_SCRIPT;
}

/** Local neural speech is ready only when voice_runtime says so. */
async function localStatus() {
  const py = await python();
  if (!py) return { tts: { ready: false, reason: "Python 3.12+ was not found." } };
  const probe = await run(py[0], [...py[1], runtimeScript(), "--status"], 20000);
  if (!probe.ok) return { tts: { ready: false, reason: "local voice runtime did not answer" } };
  return (
    parseJsonLine(probe.stdout) || {
      tts: { ready: false, reason: "local voice runtime returned no status" },
    }
  );
}

/** The speech worker's lifecycle (spawn, stderr drain, exit, deadlines, breaker, idle unload) is electron/voice-worker.cjs. */
let speaker = null;

/** The speaker leaves memory after this long with no request; the next speak starts it and warms it again. */
const TTS_IDLE_UNLOAD_MS = 10 * 60 * 1000;
/** A speak that has not answered after this long is slow (it keeps running); the hard deadline decides dead. */
const SPEAK_SOFT_MS = 8000;
/** The hard deadline of a warm speaker: this long per PCM_TEXT_CAP characters, never under the minimum. */
const SPEAK_WARM_MS_PER_CAP = 15000;
const SPEAK_WARM_MIN_MS = 8000;
/** A cold or still loading speaker gets this much extra for its model load. */
const SPEAK_COLD_EXTRA_MS = 60000;
/** A cancel never waits behind a clause; if even it is not answered the speaker is hung. */
const CANCEL_DEADLINE_MS = 10000;

/** The generation of the speaker that last finished a warm-up or a speak; any other generation is cold. */
let warmGeneration = -1;
/** The next start comes from a speak, so its init gate runs the warm-up op. */
let warmOnStart = false;
/** The deadlines of the speak requests sent and not yet answered. */
let speakQueuedMs = 0;
let lastSlow = null;
let lastFailure = null;

/** How long a speak of this many characters may take before the speaker is called hung. */
function speakDeadlineMs(chars, warm) {
  const length = Number.isFinite(chars) && chars > 0 ? chars : 0;
  const scaled = Math.max(
    SPEAK_WARM_MIN_MS,
    Math.round((length / PCM_TEXT_CAP) * SPEAK_WARM_MS_PER_CAP),
  );
  return warm ? scaled : scaled + SPEAK_COLD_EXTRA_MS;
}

/** Start-time gate: a speak-started worker is warmed (model loaded) before it counts as ready. */
async function speakerInit(send, { generation }) {
  if (!warmOnStart) return;
  warmOnStart = false;
  const answered = await send({ op: "warm-up", style: "" }, { hardMs: SPEAK_COLD_EXTRA_MS });
  if (answered?.ok === true) {
    warmedOnce = true;
    warmGeneration = generation;
  }
}

function speakerWorker(py) {
  const key = JSON.stringify([py[0], py[1]]);
  if (speaker?.key === key) return speaker.worker;
  if (speaker) speaker.worker.stop().catch(() => {});
  const worker = createVoiceWorker({
    role: "tts",
    script: py[0],
    args: () => [...py[1], runtimeScript(), "--serve"],
    env: () => ({ FRIDAY_ROOT: paths.root() || process.env.FRIDAY_ROOT || "" }),
    idleUnloadMs: TTS_IDLE_UNLOAD_MS,
    init: speakerInit,
    spawn: (exe, args, options) => {
      const child = spawn(exe, args, options);
      trackOwned("tts", child, exe);
      return child;
    },
    onExit: () => {
      // A worker that left (idle unload, crash, restart) is cold: its successor loads the model again.
      warmedOnce = false;
    },
  });
  speaker = { key, worker };
  return worker;
}

/** "cold" | "starting" | "ready" | "busy" | "breaker-open" | "stopped" of the speaker; "cold" when none was made. */
function speakerState() {
  return speaker ? speaker.worker.status().state : "cold";
}

/** The speaker's cached lifecycle view with the last slow or failed request; it never waits for the speaker. */
function speakerHealth() {
  return {
    ...(speaker ? speaker.worker.status() : { role: "tts", state: "cold", pid: null }),
    ...(lastSlow ? { lastSlow } : {}),
    ...(lastFailure ? { lastFailure } : {}),
  };
}

/**
 * Stop the speaker process. It used to have no stop at all: it stayed up after the app closed (a model held in
 * memory, and a file lock on the bundled Python that blocked an update or an uninstall) and a hung one answered
 * every later line with a timeout. The next speak starts a fresh one.
 */
function shutdown() {
  const held = speaker;
  speaker = null;
  warmedOnce = false;
  lastFailure = null;
  lastSlow = null;
  if (held) held.worker.stop().catch(() => {});
}

/** Drop a hung speaker so the next clause is not queued behind it (the supervisor's restart-tts remedy). */
function restartSpeaker() {
  const had = speaker !== null;
  shutdown();
  return { ok: true, restarted: had };
}

const FAILURE_WORDS = {
  deadline: "the local voice took too long and was restarted",
  stalled: "the local voice took too long and was restarted",
  exit: "the local voice stopped unexpectedly",
  "breaker-open": "the local voice is paused after repeated crashes",
  "start-failed": "the local voice could not start",
  "write-failed": "the local voice did not take the request",
};

/** Why the last request got no reply (read once, and only when it is fresh), or "". */
function takeFailureReason() {
  const failure = lastFailure;
  lastFailure = null;
  if (!failure || Date.now() - failure.at > 5000) return "";
  return FAILURE_WORDS[failure.code] || "";
}

/**
 * The reason a worker reply gives: its `reason` string, else the `message` of an `error` object (a plain string
 * `error` of an older kernel stays valid), else the transport failure, else the caller's fallback.
 */
function replyReason(answered, fallback) {
  if (typeof answered?.reason === "string" && answered.reason) return answered.reason;
  const error = answered?.error;
  if (typeof error === "string" && error) return error.slice(0, 200);
  if (error && typeof error === "object" && typeof error.message === "string" && error.message) {
    return error.message.slice(0, 200);
  }
  return (answered ? "" : takeFailureReason()) || fallback;
}

const SPEAK_OPS = new Set(["speak", "speak-pcm"]);

/**
 * One request to the speech worker: its reply, or null when there is none (it hung, died, was stopped or is paused
 * by the breaker). A speak gets a deadline scaled to its text (and a longer one while the model loads), so a hung
 * speaker is killed and the next line starts a fresh one instead of waiting out a fixed two minutes. A status or an
 * echo check never queues behind a busy speaker.
 */
async function speakerRequest(py, payload, timeoutMs = 120000) {
  const op = String(payload?.op || "");
  const speaks = SPEAK_OPS.has(op);
  const worker = speakerWorker(py);
  try {
    if ((op === "echo-shadow" || op === "status") && worker.status().state === "busy") return null;
    if (speaks) {
      warmOnStart = true;
      try {
        await worker.ensure();
      } finally {
        warmOnStart = false;
      }
    }
    const view = worker.status();
    // The speaker answers in order, so a clause also waits for the clauses sent before it: their deadlines count.
    const own = speaks
      ? Math.min(
          timeoutMs,
          speakDeadlineMs(String(payload.text || "").length, view.generation === warmGeneration),
        )
      : timeoutMs;
    const hardMs = speaks ? own + speakQueuedMs : own;
    if (speaks) speakQueuedMs += own;
    let reply;
    try {
      reply = await worker.request(payload, {
        hardMs,
        ...(speaks
          ? {
              softMs: SPEAK_SOFT_MS,
              onSlow: (info) => {
                lastSlow = { op: info.op, elapsedMs: info.elapsedMs };
              },
            }
          : {}),
      });
    } finally {
      if (speaks) speakQueuedMs = Math.max(0, speakQueuedMs - own);
    }
    if (speaks && reply?.ok === true) warmGeneration = worker.status().generation;
    return reply;
  } catch (error) {
    lastFailure = { code: String(error?.code || "unknown"), at: Date.now() };
    return null;
  }
}

/**
 * One line to the running speaker, reply ignored (the per-utterance cancel). It never starts a worker: with none
 * running there is nothing to cancel. True when the line was written; the line goes out before this returns.
 */
function speakerNotify(payload) {
  const state = speakerState();
  if (state !== "ready" && state !== "busy") return false;
  speaker.worker.request(payload, { hardMs: CANCEL_DEADLINE_MS }).catch(() => {});
  return true;
}

/** The reason a reply says a fallback engine spoke, or "" when it is absent or not a clean token. */
const fallbackToken = (value) =>
  typeof value === "string" && PCM_FALLBACK.test(value) ? value : "";

/** The recipe version of the voice recipe that last answered; the WAV cache key carries it. */
let knownRecipe = 0;
/** The engines whose files the WAV cache may hold; a line made by a fallback is never kept. */
const CACHEABLE_ENGINES = ["friday-voice", "supertonic-3"];

function wavCacheFile(dir, { rate, lang, style, spoken, recipe, engine }) {
  const key = crypto
    .createHash("sha1")
    .update(`local3|${recipe}|${engine}|${rate}|${lang}|${style || LOCAL_STYLE_DEFAULT}|${spoken}`)
    .digest("hex");
  return path.join(dir, `${key}.wav`);
}

const cleanRecipe = (value) => {
  const recipe = Number(value);
  return Number.isFinite(recipe) && recipe >= 0 ? Math.floor(recipe) : 0;
};

async function speakLocal(
  { text, rate = 1, lang = "", style = "" } = {},
  { request = speakerRequest, resolvePy = python, cacheDir: dirOf = cacheDir } = {},
) {
  const spoken = String(text || "").trim();
  if (!spoken) return { ok: false, engine: "local", cloud: false, reason: "Nothing to speak." };
  const voiceStyle = normaliseLocalStyle(style);
  const dir = dirOf();
  const parts = { rate, lang, style: voiceStyle, spoken };
  const reply = (engine, file, extra = {}) => ({
    ok: true,
    engine,
    own: engine === "friday-voice" && extra.own === true,
    cloud: false,
    voice: voiceStyle || LOCAL_STYLE_DEFAULT,
    mime: "audio/wav",
    audioBase64: fs.readFileSync(file).toString("base64"),
    path: file,
    ...(extra.fallback ? { fallback: extra.fallback } : {}),
  });
  for (const engine of CACHEABLE_ENGINES) {
    const hit = wavCacheFile(dir, { ...parts, recipe: knownRecipe, engine });
    if (fs.existsSync(hit) && fs.statSync(hit).size > 44) {
      return reply(engine, hit, { own: engine === "friday-voice" });
    }
  }
  const py = await resolvePy();
  if (!py)
    return { ok: false, engine: "local", cloud: false, reason: "Python 3.12+ was not found." };
  const scratch = wavCacheFile(dir, { ...parts, recipe: knownRecipe, engine: "pending" });
  const answered = await request(py, {
    op: "speak",
    text: spoken,
    speed: Number(rate) || 1,
    lang: String(lang || ""),
    style: voiceStyle,
    out: scratch,
  });
  const written = !answered?.ok || !fs.existsSync(scratch) ? 0 : fs.statSync(scratch).size;
  if (!written) {
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
      /* nothing written */
    }
    return {
      ok: false,
      engine: "local",
      cloud: false,
      reason: replyReason(answered, "local neural voice is not installed"),
    };
  }
  const engine = CACHEABLE_ENGINES.includes(answered.engine) ? answered.engine : "supertonic-3";
  const fallback = fallbackToken(answered.fallback);
  if (answered.recipeVersion !== undefined) knownRecipe = cleanRecipe(answered.recipeVersion);
  const own = engine === "friday-voice" && answered.own === true && !fallback;
  if (fallback) {
    // A line a fallback made is played but never kept: the next ask must try the FRIDAY engine again.
    const played = reply(engine, scratch, { fallback });
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
      /* a leftover scratch file is overwritten by the next call */
    }
    return { ...played, path: "" };
  }
  const kept = wavCacheFile(dir, { ...parts, recipe: knownRecipe, engine });
  try {
    fs.renameSync(scratch, kept);
  } catch {
    return reply(engine, scratch, { own });
  }
  return reply(engine, kept, { own });
}

/** The most text one local clause may carry (the kernel cuts at the same length). */
const PCM_TEXT_CAP = 500;
/** The two local engines a clause may ask for: the light Hindi voice, or Supertonic (the default). */
const PCM_ENGINES = new Set(["hindi-light", "supertonic"]);
/** A fallback reason the worker may report: a short kebab-case token, never free text. */
const PCM_FALLBACK = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** An utterance id the renderer tags its clauses with: short, ASCII, safe to log and to send as one JSON field. */
const PCM_UTTERANCE = /^[A-Za-z0-9_-]{1,64}$/;
/** How many cancelled utterance ids are remembered (the newest win). */
const PCM_CANCELLED_KEEP = 512;
const pcmCancelled = new Set();

const cleanUtterance = (value) =>
  typeof value === "string" && PCM_UTTERANCE.test(value) ? value : "";

/** A clause of a cancelled utterance: no audio, and the reason says so. */
function pcmCancelledAnswer(utt, seq) {
  return {
    ok: false,
    engine: "local",
    cloud: false,
    reason: "cancelled",
    cancelled: true,
    utt,
    ...(Number.isInteger(seq) ? { seq } : {}),
  };
}

/**
 * Cancel one utterance (barge-in or stop). The id is remembered here, so a clause that is still in flight or
 * arrives later is dropped, and the running worker is told so it stops between language spans. The worker is never
 * killed and never started for this.
 */
async function cancelPcm(payload, { notify = speakerNotify } = {}) {
  const utt = cleanUtterance(payload?.utt);
  if (!utt) return { ok: false, reason: "bad-request" };
  pcmCancelled.delete(utt);
  pcmCancelled.add(utt);
  while (pcmCancelled.size > PCM_CANCELLED_KEEP)
    pcmCancelled.delete(pcmCancelled.values().next().value);
  return { ok: true, utt, sent: notify({ op: "cancel", utt }) === true };
}

const PCM_PAUSE_MAX_MS = 1200;
const PCM_PAUSED_REPLY_MAX_MS = 5000;
const WORD_TIMES_MAX = 400;
const WORD_MAX_CHARS = 64;

/** Silence the worker says it added: a finite whole number of milliseconds, 0 to 5000, else 0. */
function cleanPausedMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(PCM_PAUSED_REPLY_MAX_MS, Math.round(value));
}

/** Word timings from the worker: at most 400 items, each a short string with finite, forward-moving times. */
function cleanWordTimes(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  let last = 0;
  for (let i = 0; i < value.length && i < WORD_TIMES_MAX * 2 && out.length < WORD_TIMES_MAX; i++) {
    const item = value[i];
    if (!item || typeof item !== "object") continue;
    const { word, startMs, endMs } = item;
    if (typeof word !== "string" || !word || word.length > WORD_MAX_CHARS) continue;
    if (typeof startMs !== "number" || typeof endMs !== "number") continue;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (startMs < last || endMs < startMs || endMs > 3_600_000) continue;
    out.push({ word, startMs: Math.round(startMs), endMs: Math.round(endMs) });
    last = endMs;
  }
  return out;
}

let warmedOnce = false;
let warmTries = 0;
/** A warm-up that failed is asked again on the next call, this many times in all per app run. */
const WARM_TRIES_MAX = 3;

/**
 * The worker's `warm-up` op: once it worked it is not asked again this run; a failure is retried on the next call,
 * at most three tries. A failure is only a reason string.
 */
async function warmUp(style, { request = speakerRequest, resolvePy = python } = {}) {
  if (warmedOnce) return { ok: true, warmed: false, engine: "local", cloud: false };
  if (warmTries >= WARM_TRIES_MAX) {
    return { ok: false, engine: "local", cloud: false, reason: "warm-up gave up for this run" };
  }
  try {
    const py = await resolvePy();
    if (!py)
      return { ok: false, engine: "local", cloud: false, reason: "Python 3.12+ was not found." };
    warmTries += 1;
    const answered = await request(py, { op: "warm-up", style }, 60000);
    if (answered?.ok === true) {
      warmedOnce = true;
      return { ok: true, warmed: true, engine: "local", cloud: false };
    }
    return {
      ok: false,
      engine: "local",
      cloud: false,
      reason: replyReason(answered, "warm-up failed").slice(0, 120),
    };
  } catch {
    return { ok: false, engine: "local", cloud: false, reason: "warm-up failed" };
  }
}

/** Test hook: lets a test run the once-per-run warm-up again. */
function resetWarmUp() {
  warmedOnce = false;
  warmTries = 0;
}

/**
 * One clause as raw 16-bit mono PCM from the persistent Supertonic worker. Local only: no cloud voice, no SAPI
 * fallback, no disk write and no cache, so sensitive text never leaves this PC. The samples are returned as a
 * Buffer, which the renderer receives as a Uint8Array through the structured clone (no base64 round trip).
 * On any failure the answer is { ok: false, reason } and the caller keeps the existing speak path.
 */
async function speakPcm(
  { text, rate = 1, lang = "", style = "", seq, engine, utt, trusted, first, pauseMs, warm } = {},
  { request = speakerRequest, resolvePy = python } = {},
) {
  if (warm === true) return warmUp(normaliseLocalStyle(style), { request, resolvePy });
  const spoken = String(text || "")
    .trim()
    .slice(0, PCM_TEXT_CAP);
  if (!spoken) return { ok: false, engine: "local", cloud: false, reason: "Nothing to speak." };
  const voiceStyle = normaliseLocalStyle(style);
  const askedEngine = typeof engine === "string" && PCM_ENGINES.has(engine) ? engine : "";
  const utterance = cleanUtterance(utt);
  if (utterance && pcmCancelled.has(utterance)) return pcmCancelledAnswer(utterance, seq);
  const py = await resolvePy();
  if (!py)
    return { ok: false, engine: "local", cloud: false, reason: "Python 3.12+ was not found." };
  const answered = await request(
    py,
    {
      op: "speak-pcm",
      text: spoken,
      speed: Number(rate) || 1,
      lang: String(lang || ""),
      style: voiceStyle,
      ...(trusted === true ? { trusted: true } : {}),
      ...(first === true ? { first: true } : {}),
      ...(Number.isFinite(pauseMs) && pauseMs > 0
        ? { pauseMs: Math.min(PCM_PAUSE_MAX_MS, Math.round(pauseMs)) }
        : {}),
      ...(askedEngine ? { engine: askedEngine } : {}),
      ...(Number.isInteger(seq) ? { seq } : {}),
      ...(utterance ? { utt: utterance } : {}),
    },
    60000,
  );
  // Cancelled while it ran (here, or the worker saw the cancel first): the samples are dropped, never played.
  if (utterance && (pcmCancelled.has(utterance) || answered?.reason === "cancelled")) {
    return pcmCancelledAnswer(utterance, seq);
  }
  if (!answered?.ok || typeof answered.pcm16 !== "string" || !answered.pcm16) {
    return {
      ok: false,
      engine: "local",
      cloud: false,
      reason: replyReason(answered, "local neural voice is not installed"),
    };
  }
  const pcm = Buffer.from(answered.pcm16, "base64");
  if (pcm.length < 2) {
    return {
      ok: false,
      engine: "local",
      cloud: false,
      reason: "the local voice returned no audio",
    };
  }
  const fallback =
    typeof answered.fallback === "string" && PCM_FALLBACK.test(answered.fallback)
      ? answered.fallback
      : "";
  const wordTimes = cleanWordTimes(answered.wordTimes);
  const engineName =
    answered.engine === "hindi-light"
      ? "hindi-light"
      : answered.engine === "friday-voice"
        ? "friday-voice"
        : "supertonic-3";
  const answeredVoice = normaliseLocalStyle(answered.voiceId);
  const recipe = Number(answered.recipeVersion);
  if (Number.isFinite(recipe) && recipe >= 0) knownRecipe = Math.floor(recipe);
  return {
    ok: true,
    engine: engineName,
    own: engineName === "friday-voice" && answered.own === true && !fallback,
    cloud: false,
    voice: voiceStyle || LOCAL_STYLE_DEFAULT,
    ...(answeredVoice ? { voiceId: answeredVoice } : {}),
    ...(Number.isFinite(recipe) && recipe >= 0 ? { recipeVersion: Math.floor(recipe) } : {}),
    sampleRate: cleanSampleRate(answered.sampleRate),
    pcm,
    ms: Number(answered.ms) || 0,
    pausedMs: cleanPausedMs(answered.pausedMs),
    ...(wordTimes.length ? { wordTimes } : {}),
    ...(fallback ? { fallback } : {}),
    ...(Number.isInteger(seq) ? { seq } : {}),
    ...(utterance ? { utt: utterance } : {}),
  };
}

/** One call per 160 ms microphone chunk at most; a faster caller is answered without touching the worker. */
const ECHO_SHADOW_MIN_GAP_MS = 160;
/** Base64 characters one call may carry: 160 ms at 16 kHz is 6828, so this leaves room for a slightly larger chunk. */
const ECHO_SHADOW_MAX_B64 = 8192;
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

function monotonicMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

/** A plain data object with own fields only: no class instance, no array, no getter tricks. */
function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The decoded byte length of a well-formed base64 audio string, or 0 when it is not one. */
function audioBase64Bytes(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > ECHO_SHADOW_MAX_B64) return 0;
  if (value.length % 4 !== 0 || !BASE64_BODY.test(value)) return 0;
  const pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - pad;
}

/**
 * Echo-shadow measurement from the persistent worker: how much the echo canceller would remove from one microphone
 * chunk. Local only: no cloud, no SAPI fallback. The microphone and reference audio go to the worker over its pipe
 * and are never written to disk, cached or logged here, and the answer carries levels only, never audio. Nothing
 * runs unless the renderer asks. Each call is checked first (plain object, base64 strings of bounded length, equal
 * decoded length, boolean reset, integer seq), then rate limited (one call per 160 ms and one in flight), so a
 * flood never reaches the worker and never queues behind a speak.
 */
function createEchoShadow({
  request = speakerRequest,
  resolvePy = python,
  now = monotonicMs,
  minGapMs = ECHO_SHADOW_MIN_GAP_MS,
} = {}) {
  let lastAt = -Infinity;
  let busy = false;
  const refuse = (reason) => ({ ok: false, engine: "local", cloud: false, reason });
  return async function echoShadow(payload) {
    if (!isPlainRecord(payload)) return refuse("bad-request");
    const { mic, ref, reset, seq } = payload;
    const micBytes = audioBase64Bytes(mic);
    if (micBytes < 2 || micBytes % 2) return refuse("bad-audio");
    let refBytes = 0;
    if (ref !== undefined && ref !== null && ref !== "") {
      refBytes = audioBase64Bytes(ref);
      if (refBytes < 2 || refBytes % 2) return refuse("bad-audio");
      if (refBytes !== micBytes) return refuse("length-mismatch");
    }
    if (reset !== undefined && typeof reset !== "boolean") return refuse("bad-request");
    if (seq !== undefined && !Number.isSafeInteger(seq)) return refuse("bad-request");
    const at = now();
    if (busy || at - lastAt < minGapMs) return refuse("rate-limited");
    lastAt = at;
    busy = true;
    try {
      const py = await resolvePy();
      if (!py) return { ...refuse("Python 3.12+ was not found."), ready: false };
      // The worker is the same process that speaks: a missed deadline kills it, so the wait is generous.
      const answered = await request(
        py,
        {
          op: "echo-shadow",
          mic,
          ...(refBytes ? { ref } : {}),
          ...(reset === true ? { reset: true } : {}),
          ...(seq !== undefined ? { seq } : {}),
        },
        5000,
      );
      if (!answered || typeof answered !== "object") {
        return { ...refuse("the local voice worker did not answer"), ready: false };
      }
      if (!answered.ok) {
        return {
          ...refuse(String(answered.reason || "echo-shadow-failed")),
          ready: answered.ready === true,
          ...(seq !== undefined ? { seq } : {}),
        };
      }
      const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      return {
        ok: true,
        engine: "local",
        cloud: false,
        ready: answered.ready === true,
        playing: answered.playing === true,
        cancelled: answered.cancelled === true,
        micDb: num(answered.micDb),
        residualDb: num(answered.residualDb),
        reductionDb:
          typeof answered.reductionDb === "number" && Number.isFinite(answered.reductionDb)
            ? answered.reductionDb
            : null,
        delayMs: num(answered.delayMs),
        confidence: num(answered.confidence),
        gate: false,
        ...(seq !== undefined ? { seq } : {}),
      };
    } finally {
      busy = false;
    }
  };
}

const echoShadow = createEchoShadow();

/**
 * Pitch multiplier (1 = the voice's own pitch) to the Hz offset the online service takes. The old mapping sent
 * (pitch - 1) * 12 Hz, so the whole slider moved the voice by about 6 Hz, which cannot be heard; 150 Hz per 1.0
 * moves a female voice about a semitone per 0.06, and the offset is clamped to +-40 Hz so no setting sounds broken.
 */
function pitchOffsetHz(pitch) {
  const value = Number(pitch);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-40, Math.min(40, Math.round((value - 1) * 150)));
}

async function speakCloud({ text, voice, rate = 1, volume = 1, pitch = 1 } = {}) {
  const spoken = String(text || "").trim();
  const voiceId = String(voice || "");
  const state = await status();
  if (!state.available) return { ok: false, reason: state.reason, engine: "edge-tts", cloud: true };

  const key = crypto
    .createHash("sha1")
    .update(`${voiceId}|${rate}|${volume}|${pitch}|${spoken}`)
    .digest("hex");
  const file = path.join(cacheDir(), `${key}.mp3`);

  if (!fs.existsSync(file)) {
    const py = await python();
    if (!py)
      return { ok: false, reason: "Python 3.12+ was not found.", engine: "edge-tts", cloud: true };
    const offsetHz = pitchOffsetHz(pitch);
    const args = [
      ...py[1],
      "-m",
      "edge_tts",
      "--voice",
      voiceId,
      "--text",
      spoken,
      `--rate=${pct(rate)}`,
      `--volume=${pct(volume)}`,
      `--pitch=${offsetHz >= 0 ? "+" : ""}${offsetHz}Hz`,
      "--write-media",
      file,
    ];
    const result = await run(py[0], args, 90000);
    if (!result.ok || !fs.existsSync(file) || fs.statSync(file).size === 0) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* nothing written */
      }
      return {
        ok: false,
        engine: "edge-tts",
        cloud: true,
        reason: (result.stderr || "edge-tts produced no audio").slice(-400),
      };
    }
  }
  return {
    ok: true,
    engine: "edge-tts",
    cloud: true,
    voice: voiceId,
    mime: "audio/mpeg",
    audioBase64: fs.readFileSync(file).toString("base64"),
    path: file,
  };
}

async function speakSystem(text, options = {}) {
  const sapi = require("./sapi-voice.cjs");
  if (!sapi.sapiAvailable()) return { ok: false, engine: "sapi", reason: "not-windows" };
  const { execFile } = require("child_process");
  const dir = path.join(os.tmpdir(), "friday-sapi");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomBytes(8).toString("hex")}.wav`);
  const command = sapi.sapiCommand(text, { wav: file, rate: options.rate, volume: options.volume });
  const exe = command[0];
  const args = command.slice(1);
  const result = await new Promise((resolve) => {
    execFile(
      exe,
      args,
      { timeout: 20000, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        resolve({
          ok: !error,
          error: error ? String(error.message || error) : "",
          stdout: String(stdout || ""),
        });
      },
    );
  });
  const ready = result.ok && fs.existsSync(file) && fs.statSync(file).size > 44;
  if (!ready) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* nothing written */
    }
    return {
      ok: false,
      engine: "sapi",
      reason: (result.error || "sapi wrote no audio").slice(0, 240),
    };
  }
  const audioBase64 = fs.readFileSync(file).toString("base64");
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* the clip is already in memory */
  }
  const line = (result.stdout.match(/VOICE\s+(\S.*)/) || [])[1]?.trim() || "";
  const other = line.startsWith("other ");
  const indian = Boolean(line) && line !== "none-indian" && !other;
  return {
    ok: true,
    engine: "sapi",
    cloud: false,
    mime: "audio/wav",
    audioBase64,
    voice: indian ? line : other ? line.slice(6).trim() : "",
    note: indian ? "" : sapi.NO_INDIAN_VOICE,
    path: "",
  };
}

async function speak({ text, voice, rate = 1, volume = 1, pitch = 1, lang = "", style = "" } = {}) {
  const spoken = String(text || "").trim();
  if (!spoken) throw new Error("Nothing to speak.");
  const voiceId = String(voice || "");
  const wantsCloud = /Neural$/i.test(voiceId);
  const sensitive = classify(spoken).level === "sensitive";
  if (wantsCloud && !sensitive) {
    const cloud = await speakCloud({ text: spoken, voice: voiceId, rate, volume, pitch });
    if (cloud.ok) return cloud;
  }
  const local = await speakLocal({ text: spoken, rate, lang, style });
  if (local.ok) return local;
  const system = await speakSystem(spoken, { rate, volume });
  if (system.ok) return system;
  return {
    ok: false,
    engine: wantsCloud && !sensitive ? "edge-tts" : "local",
    cloud: Boolean(wantsCloud && !sensitive),
    reason: sensitive
      ? "cloud speech is blocked for sensitive text"
      : local.reason || "local neural voice is not installed",
  };
}

module.exports = {
  status,
  normaliseFridayVoiceStatus,
  fridayVoiceStatus,
  normaliseLocalStyle,
  LOCAL_STYLES,
  install,
  voices,
  speak,
  speakLocal,
  speakPcm,
  resetWarmUp,
  cancelPcm,
  PCM_CANCELLED_KEEP,
  echoShadow,
  createEchoShadow,
  ECHO_SHADOW_MIN_GAP_MS,
  ECHO_SHADOW_MAX_B64,
  shutdown,
  restartSpeaker,
  speakerHealth,
  speakDeadlineMs,
  TTS_IDLE_UNLOAD_MS,
  speakerRequest,
  PREFERRED,
  pitchOffsetHz,
};
