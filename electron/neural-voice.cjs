/**
 * FRIDAY · neural voice
 *
 * Offline speech is Supertonic 3 (voice F2) when that model is on disk,
 * through kernel/voice_runtime.py. Until then the Windows SAPI voice speaks.
 * The speaker process stays up so the model is not loaded again for every line.
 *
 * edge-tts is the cloud path: Microsoft neural voices, including
 * hi-IN-SwaraNeural and en-IN-NeerjaNeural. It runs only when the caller
 * passes one of those Neural voice ids and the text is not sensitive.
 * Sensitive text stays on the local model or the system voice.
 *
 * Rules kept from the rest of FRIDAY:
 *   · the interpreter comes from the shared resolver (electron/python.cjs)
 *   · every byte written stays inside the selected FRIDAY root (cache/tts)
 *   · nothing is faked: a missing local model is not called ready, and a
 *     failed synth falls back to the existing SAPI voices.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const paths = require("./friday-paths.cjs");
const { resolvePython } = require("./python.cjs");
const { classify } = require("./privacy-firewall.cjs");

const RUNTIME_SCRIPT = path.join(__dirname, "..", "kernel", "voice_runtime.py");

/** Voices FRIDAY offers by default — Indian female, Hindi + Indian English. */
const PREFERRED = [
  { id: "hi-IN-SwaraNeural", label: "Swara · Hindi (India) · neural", lang: "hi-IN" },
  { id: "en-IN-NeerjaNeural", label: "Neerja · English (India) · neural", lang: "en-IN" },
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

/** Is edge-tts importable right now? Cached briefly — this spawns a process. */
async function status(force = false) {
  if (cachedStatus && !force && Date.now() - cachedStatus.at < 60000) return cachedStatus.value;
  const py = await python();
  let value;
  if (!py) {
    value = {
      available: false,
      reason: "Python 3.12+ was not found — install it from Install Manager.",
      engine: "edge-tts",
      networkRequired: true,
      offline: false,
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
        }
      : {
          available: false,
          reason: "edge-tts is not installed yet.",
          python: py[0],
          engine: "edge-tts",
          networkRequired: true,
          offline: false,
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
  try {
    const text = probe.stdout.trim();
    return JSON.parse(text.slice(text.lastIndexOf("{")));
  } catch {
    return { tts: { ready: false, reason: "local voice runtime returned no status" } };
  }
}

let speaker = null;
let speakerSeq = 0;

function speakerRequest(py, payload, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const ensure = () => {
      if (speaker?.alive && speaker.child?.stdin && !speaker.child.stdin.destroyed) return speaker;
      const child = spawn(py[0], [...py[1], runtimeScript(), "--serve"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
          FRIDAY_ROOT: paths.root() || process.env.FRIDAY_ROOT || "",
        },
      });
      const session = {
        child,
        alive: true,
        intentional: false,
        buf: "",
        pending: new Map(),
      };
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
            const wait = session.pending.get(id);
            session.pending.delete(id);
            wait(msg);
          }
        }
      });
      const fail = () => {
        if (!session.alive) return;
        session.alive = false;
        for (const wait of session.pending.values()) wait(null);
        session.pending.clear();
        if (speaker === session) speaker = null;
      };
      child.on("error", fail);
      child.on("close", fail);
      speaker = session;
      return session;
    };
    const session = ensure();
    const id = ++speakerSeq;
    const timer = setTimeout(() => {
      session.pending.delete(id);
      resolve(null);
    }, timeoutMs);
    session.pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    try {
      session.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    } catch {
      clearTimeout(timer);
      session.pending.delete(id);
      resolve(null);
    }
  });
}

async function speakLocal({ text, rate = 1, lang = "" } = {}) {
  const spoken = String(text || "").trim();
  if (!spoken) return { ok: false, engine: "local", cloud: false, reason: "Nothing to speak." };
  const key = crypto.createHash("sha1").update(`local|${rate}|${lang}|${spoken}`).digest("hex");
  const file = path.join(cacheDir(), `${key}.wav`);
  if (fs.existsSync(file) && fs.statSync(file).size > 44) {
    return {
      ok: true,
      engine: "supertonic-3",
      cloud: false,
      mime: "audio/wav",
      audioBase64: fs.readFileSync(file).toString("base64"),
      path: file,
    };
  }
  const py = await python();
  if (!py)
    return { ok: false, engine: "local", cloud: false, reason: "Python 3.12+ was not found." };
  const answered = await speakerRequest(py, {
    op: "speak",
    text: spoken,
    speed: Number(rate) || 1,
    lang: String(lang || ""),
    out: file,
  });
  if (!answered?.ok || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* nothing written */
    }
    return {
      ok: false,
      engine: "local",
      cloud: false,
      reason: answered?.reason || "local neural voice is not installed",
    };
  }
  return {
    ok: true,
    engine: "supertonic-3",
    cloud: false,
    mime: "audio/wav",
    audioBase64: fs.readFileSync(file).toString("base64"),
    path: file,
  };
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
    const semitones = Math.round((Number(pitch) - 1) * 12);
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
      `--pitch=${semitones >= 0 ? "+" : ""}${semitones}Hz`,
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
    mime: "audio/mpeg",
    audioBase64: fs.readFileSync(file).toString("base64"),
    path: file,
  };
}

async function speakSystem(text) {
  const sapi = require("./sapi-voice.cjs");
  if (!sapi.sapiAvailable()) return { ok: false, engine: "sapi", reason: "not-windows" };
  const { execFile } = require("child_process");
  const command = sapi.sapiCommand(text);
  const exe = command[0];
  const args = command.slice(1);
  const result = await new Promise((resolve) => {
    execFile(exe, args, { timeout: 20000, windowsHide: true }, (error) => {
      resolve({ ok: !error, error: error ? String(error.message || error) : "" });
    });
  });
  if (!result.ok) return { ok: false, engine: "sapi", reason: result.error.slice(0, 240) };
  return { ok: true, engine: "sapi", cloud: false, mime: "", audioBase64: "", path: "" };
}

async function speak({ text, voice, rate = 1, volume = 1, pitch = 1, lang = "" } = {}) {
  const spoken = String(text || "").trim();
  if (!spoken) throw new Error("Nothing to speak.");
  const voiceId = String(voice || "");
  const wantsCloud = /Neural$/i.test(voiceId);
  const sensitive = classify(spoken).level === "sensitive";
  if (wantsCloud && !sensitive) {
    const cloud = await speakCloud({ text: spoken, voice: voiceId, rate, volume, pitch });
    if (cloud.ok) return cloud;
  }
  const local = await speakLocal({ text: spoken, rate, lang });
  if (local.ok) return local;
  const system = await speakSystem(spoken);
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

module.exports = { status, install, voices, speak, speakLocal, PREFERRED };
