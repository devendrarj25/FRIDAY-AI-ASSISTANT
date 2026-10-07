/**
 * FRIDAY · wake-word engine bridge (bundled linear scorer + openWakeWord).
 *
 * status() copies resources/wake/friday.onnx into <FRIDAY_ROOT>/models/wake
 * when missing, then asks kernel/wake_word.py whether that model (or a custom
 * openWakeWord file) is ready. detect() scores one captured utterance BEFORE
 * it is transcribed, through a persistent `--serve` worker so the detector is
 * not reconstructed per clip.
 *
 * friday.onnx is installed for the default wake word "friday" only. A custom
 * word such as "jarvis" is ready only when jarvis.onnx (or an exact-stem
 * match) exists — never by silently scoring friday.onnx.
 *
 * This is not a live microphone tap. Clips still come from the shared
 * VoiceGate. When the configured model is missing, this reports that verbatim
 * and the caller keeps using the documented transcript fallback in
 * src/lib/friday/wake-word.ts.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const paths = require("./friday-paths.cjs");
const { resolvePython } = require("./python.cjs");

const SCRIPT = path.join(__dirname, "..", "kernel", "wake_word.py");

function scriptPath() {
  if (fs.existsSync(SCRIPT)) return SCRIPT;
  const packaged = path.join(process.resourcesPath || "", "kernel", "wake_word.py");
  return fs.existsSync(packaged) ? packaged : SCRIPT;
}

function run(exe, args, timeout = 30000) {
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

async function python() {
  const found = await resolvePython();
  return found ? [found.exe, found.prefix || []] : null;
}

let cached = null;
let worker = null;
let workerSeq = 0;
let workerGeneration = 0;

function bundledWakeDir() {
  const dirs = [
    path.join(__dirname, "..", "resources", "wake"),
    path.join(process.resourcesPath || "", "resources", "wake"),
    path.join(process.resourcesPath || "", "wake"),
  ];
  return dirs.find((dir) => fs.existsSync(path.join(dir, "friday.onnx")));
}

/** Copy the shipped friday.onnx into <FRIDAY_ROOT>/models/wake when missing. */
function installBundledModel() {
  const root = paths.root() || process.env.FRIDAY_ROOT;
  if (!root) return null;
  const destDir = path.join(root, "models", "wake");
  const dest = path.join(destDir, "friday.onnx");
  if (fs.existsSync(dest)) return dest;
  const fromDir = bundledWakeDir();
  if (!fromDir) return null;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(path.join(fromDir, "friday.onnx"), dest);
    const json = path.join(fromDir, "friday-wake.json");
    if (fs.existsSync(json)) fs.copyFileSync(json, path.join(destDir, "friday-wake.json"));
    return dest;
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
    intentional: false,
    buf: "",
    pending: new Map(),
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
        const wait = session.pending.get(id);
        session.pending.delete(id);
        wait.resolve(msg);
      }
    }
  });
  const fail = () => {
    if (!session.alive) return;
    session.alive = false;
    rejectPending(session, new Error("wake worker exited"));
    if (worker && worker.generation === generation) worker = null;
    if (!session.intentional) cached = null;
  };
  child.on("error", fail);
  child.on("close", fail);
  return session;
}

function workerRequest(session, payload, timeoutMs) {
  const id = ++workerSeq;
  return new Promise((resolve, reject) => {
    if (!session?.alive || !session.child?.stdin || session.child.stdin.destroyed) {
      reject(new Error("wake worker is not running"));
      return;
    }
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error("wake worker timed out"));
    }, timeoutMs);
    session.pending.set(id, {
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

async function ensureWorker() {
  if (worker?.alive) return worker;
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
    },
  });
  const session = attachWorker(child, generation);
  worker = session;
  return session;
}

function mapStatus(parsed, key, fallbackReason) {
  if (parsed?.ok) {
    return {
      engine: parsed.ready ? parsed.engine || "openwakeword" : "transcript",
      installed: true,
      ready: Boolean(parsed.ready),
      model: parsed.model || null,
      modelDir: parsed.modelDir || null,
      models: parsed.models || [],
      wakeWord: key,
      loadCount: parsed.loadCount,
      reason: parsed.error || null,
    };
  }
  return {
    engine: "transcript",
    installed: false,
    ready: false,
    wakeWord: key,
    reason: parsed?.error || fallbackReason,
  };
}

/** Is the native detector usable right now, and with which model? */
async function status(wakeWord = "friday", force = false) {
  installBundledModel();
  const key = String(wakeWord || "friday").toLowerCase();
  if (cached && !force && cached.key === key && Date.now() - cached.at < 60000) return cached.value;
  const py = await python();
  let value;
  if (!py) {
    value = {
      engine: "transcript",
      installed: false,
      ready: false,
      wakeWord: key,
      reason: "Python 3.12+ was not found — install it from Install Manager.",
    };
  } else {
    try {
      const session = await ensureWorker();
      const parsed = await workerRequest(session, { op: "probe", wakeWord: key }, 30000);
      value = mapStatus(parsed, key, "wake probe failed");
    } catch (error) {
      const probe = await run(
        py[0],
        [...py[1], scriptPath(), "--probe", "--wake-word", key],
        30000,
      );
      const parsed = parse(probe.stdout);
      value = mapStatus(
        parsed,
        key,
        parsed?.error ||
          String(error?.message || probe.stderr || "openwakeword is not installed yet.").slice(
            -300,
          ),
      );
    }
  }
  cached = { at: Date.now(), key, value };
  return value;
}

/** Install openWakeWord through the same pip path as every other dependency. */
async function install() {
  const py = await python();
  if (!py) return { ok: false, error: "No supported Python interpreter found." };
  const result = await run(
    py[0],
    [...py[1], "-m", "pip", "install", "--upgrade", "openwakeword"],
    600000,
  );
  cached = null;
  const now = await status("friday", true);
  return now.installed
    ? { ok: true, ready: now.ready, reason: now.reason }
    : { ok: false, error: (result.stderr || "pip install openwakeword failed").slice(-600) };
}

function tmpFile(mime) {
  const ext = /ogg/.test(mime || "") ? "ogg" : /wav/.test(mime || "") ? "wav" : "webm";
  const dir = path.join(paths.root() ? paths.ensureDir("cache") : os.tmpdir(), "wake-in");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* reported by the write below */
  }
  return path.join(dir, `${crypto.randomBytes(8).toString("hex")}.${ext}`);
}

/**
 * Score one captured utterance. `detected` is only ever true when the real
 * model said so — an unavailable engine returns `ok:false` with the reason.
 */
async function detect({ audioBase64, mime, wakeWord = "friday", threshold = 0.5 } = {}) {
  const state = await status(wakeWord);
  if (!state.ready) return { ok: false, engine: "transcript", reason: state.reason };
  if (!audioBase64) return { ok: false, engine: "transcript", reason: "no audio supplied" };
  const file = tmpFile(mime);
  try {
    fs.writeFileSync(file, Buffer.from(audioBase64, "base64"));
    let parsed;
    try {
      const session = await ensureWorker();
      parsed = await workerRequest(
        session,
        {
          op: "detect",
          audio: file,
          wakeWord: String(wakeWord || "friday"),
          threshold,
        },
        30000,
      );
    } catch {
      worker = null;
      const py = await python();
      if (!py) return { ok: false, engine: "transcript", reason: "no Python interpreter" };
      const session = await ensureWorker();
      parsed = await workerRequest(
        session,
        {
          op: "detect",
          audio: file,
          wakeWord: String(wakeWord || "friday"),
          threshold,
        },
        30000,
      );
    }
    if (!parsed?.ok)
      return {
        ok: false,
        engine: "transcript",
        reason: parsed?.error || "wake detection failed",
      };
    return {
      ok: true,
      engine: parsed.engine || "openwakeword",
      detected: Boolean(parsed.detected),
      score: parsed.score,
      threshold: parsed.threshold,
      model: parsed.model,
      loadCount: parsed.loadCount,
    };
  } catch (error) {
    return { ok: false, engine: "transcript", reason: String(error?.message || error) };
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  }
}

function shutdown() {
  const session = worker;
  worker = null;
  cached = null;
  if (!session?.child) return;
  session.intentional = true;
  try {
    if (session.alive && session.child.stdin && !session.child.stdin.destroyed) {
      session.child.stdin.write(`${JSON.stringify({ id: ++workerSeq, op: "shutdown" })}\n`);
    }
  } catch {
    /* closing anyway */
  }
  rejectPending(session, new Error("wake worker shutting down"));
  const child = session.child;
  setTimeout(() => killTree(child), 400);
}

module.exports = {
  status,
  install,
  detect,
  shutdown,
  installBundledModel,
  bundledWakeDir,
};
