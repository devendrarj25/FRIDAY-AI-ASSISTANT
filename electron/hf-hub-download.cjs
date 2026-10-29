/**
 * Hugging Face's official client as the first way to fetch a repo's weights.
 *
 * A plain `resolve/main/<file>` request for a Xet-backed file is answered by Hugging Face's
 * LFS bridge, a compatibility path for older clients that rebuilds the file on the server. The
 * official `huggingface_hub` client with `hf_xet` (both already installed in FRIDAY's Python
 * environment, because faster-whisper depends on them) reads the chunks in parallel and is the
 * path Hugging Face documents for speed (`HF_XET_HIGH_PERFORMANCE=1` lets it use every core and
 * a high-bandwidth line). The downloader in model-download.cjs stays as the fallback: this one is
 * tried first, is cut off when no byte arrives for a minute, and every weight it fetches is
 * checked against the SHA-256 Hugging Face lists, so a bad or half result is never kept.
 *
 * Progress is read from the folder (finished files plus the client's `.incomplete` parts) rather
 * than from the client's own bars, so it needs nothing from the client but the files.
 */
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STALL_MS = 60_000;
const POLL_MS = 500;
const CACHE_DIR = path.join(".cache", "huggingface");

const SCRIPT = [
  "import json, sys",
  "from huggingface_hub import snapshot_download",
  "repo, dest, files = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])",
  "snapshot_download(repo_id=repo, local_dir=dest, allow_patterns=files)",
].join("\n");

/** Which engine to use: auto (this one first), hub (this one only) or own (the built-in one). */
function engineMode(env = process.env) {
  const mode = String(env.FRIDAY_HF_ENGINE || "auto")
    .trim()
    .toLowerCase();
  return ["auto", "hub", "own"].includes(mode) ? mode : "auto";
}

/** The Python that holds huggingface_hub: an explicit one, else this checkout's virtual environment. */
function findPython({ env = process.env, exists = fs.existsSync, root = null } = {}) {
  const win = process.platform === "win32";
  const venv = (base) =>
    path.join(base, ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
  const list = [
    env.FRIDAY_PYTHON,
    venv(path.join(__dirname, "..")),
    root ? venv(path.join(root, "runtime")) : null,
  ].filter(Boolean);
  return list.find((file) => exists(file)) || null;
}

function runQuiet(python, args, { env, timeout = 20_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(python, args, {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ code: -1, out: "" });
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ code: -1, out });
    }, timeout);
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (out += chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, out });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** True when the client and its Xet transport import in that Python. */
async function available(python, options = {}) {
  if (!python) return false;
  const res = await runQuiet(python, ["-c", "import huggingface_hub, hf_xet"], {
    env: options.env || process.env,
    spawnImpl: options.spawnImpl,
  });
  return res.code === 0;
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Every `.incomplete` part the client keeps for one file, whatever its hash suffix. */
function partsOf(dest, name) {
  const dir = path.join(dest, CACHE_DIR, "download", path.dirname(name));
  const base = path.basename(name);
  try {
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith(".incomplete"))
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

/**
 * Bytes on disk for the wanted files. A part counts for at most 99 percent of its file, so a client
 * that reserves the whole length up front can never show a finished download that is not.
 */
function bytesOnDisk(dest, files) {
  let done = 0;
  let touched = 0;
  for (const file of files) {
    const final = sizeOf(path.join(dest, file.name));
    if (final > 0 && (!file.size || final >= file.size)) {
      done += final;
      continue;
    }
    for (const part of partsOf(dest, file.name)) {
      const size = sizeOf(part);
      done += file.size ? Math.min(size, Math.floor(file.size * 0.99)) : size;
      try {
        touched = Math.max(touched, fs.statSync(part).mtimeMs);
      } catch {
        /* the client moved it */
      }
    }
  }
  return { done, touched };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** What the client left must be what Hugging Face lists, or none of it is kept. */
async function verify(dest, files) {
  for (const file of files) {
    const target = path.join(dest, file.name);
    const size = sizeOf(target);
    if (!size) return `${file.name} is missing`;
    if (file.size && size !== file.size) return `${file.name} has the wrong size`;
    if (file.sha256) {
      const got = await sha256File(target);
      if (got !== String(file.sha256).toLowerCase()) return `${file.name} fails its SHA-256`;
    }
  }
  return "";
}

/**
 * Fetch `files` of `repo` into `dest` with the official client.
 * Resolves { ok: true, bytes } or { ok: false, error }; never throws. A failure removes only what
 * this call left (the client's cache folder and any file that failed its check).
 */
async function download({
  repo,
  dest,
  files,
  python,
  env = process.env,
  onProgress = null,
  signal = null,
  stallMs = STALL_MS,
  pollMs = POLL_MS,
  spawnImpl = spawn,
}) {
  if (!python) return { ok: false, error: "no Python with huggingface_hub was found" };
  const wanted = files.map((file) => ({ ...file }));
  const total = wanted.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  fs.mkdirSync(dest, { recursive: true });
  const childEnv = {
    ...env,
    HF_XET_HIGH_PERFORMANCE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_PROGRESS_BARS: "1",
    HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
    PYTHONIOENCODING: "utf-8",
  };
  const args = ["-c", SCRIPT, repo, dest, JSON.stringify(wanted.map((file) => file.name))];
  const started = Date.now();
  let failure = "";
  const code = await new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(python, args, {
        env: childEnv,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      failure = String(err?.message || err);
      resolve(-1);
      return;
    }
    let log = "";
    child.stdout?.on("data", (chunk) => (log = (log + chunk).slice(-2000)));
    child.stderr?.on("data", (chunk) => (log = (log + chunk).slice(-2000)));
    let best = 0;
    let lastMove = Date.now();
    const samples = [];
    const stop = (why) => {
      failure = why;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    const timer = setInterval(() => {
      if (signal?.aborted) return stop(String(signal.reason || "cancelled"));
      const { done, touched } = bytesOnDisk(dest, wanted);
      const moved = done > best || touched > lastMove;
      if (moved) lastMove = Date.now();
      best = Math.max(best, done);
      const now = Date.now();
      samples.push([now, best]);
      while (samples.length > 2 && now - samples[0][0] > 4000) samples.shift();
      const [t0, b0] = samples[0];
      const rate = now > t0 ? ((best - b0) * 1000) / (now - t0) : 0;
      onProgress?.({
        status: "downloading with the Hugging Face client",
        bytesDone: best,
        bytesTotal: total,
        gbDone: Number((best / 1024 ** 3).toFixed(2)),
        gbTotal: Number((total / 1024 ** 3).toFixed(2)),
        connections: 0,
        host: "huggingface.co",
        progress: total > 0 ? Math.min(100, (best / total) * 100) : null,
        percent: total > 0 ? Math.min(100, Math.round((best / total) * 100)) : null,
        speedMbps: Number((rate / 1024 ** 2).toFixed(1)),
        etaSeconds: total > best && rate > 0 ? Math.round((total - best) / rate) : 0,
      });
      if (now - lastMove > stallMs) stop(`no byte for ${Math.round(stallMs / 1000)}s`);
    }, pollMs);
    child.on("error", (err) => {
      clearInterval(timer);
      failure = failure || String(err?.message || err);
      resolve(-1);
    });
    child.on("close", (exit) => {
      clearInterval(timer);
      if (exit !== 0 && !failure)
        failure = log.trim().split(/\r?\n/).slice(-1)[0] || `exit ${exit}`;
      resolve(exit);
    });
  });
  const cleanup = () => {
    fs.rmSync(path.join(dest, CACHE_DIR), { recursive: true, force: true });
    try {
      fs.rmdirSync(path.join(dest, ".cache")); // only when nothing else is in it
    } catch {
      /* not empty or already gone */
    }
  };
  if (code !== 0) return { ok: false, error: failure || `the client exited with ${code}` };
  const problem = await verify(dest, wanted);
  if (problem) {
    for (const file of wanted) fs.rmSync(path.join(dest, file.name), { force: true });
    cleanup();
    return { ok: false, error: problem };
  }
  cleanup();
  const bytes = wanted.reduce((sum, file) => sum + sizeOf(path.join(dest, file.name)), 0);
  return { ok: true, bytes, seconds: (Date.now() - started) / 1000 };
}

module.exports = { engineMode, findPython, available, download, bytesOnDisk, verify, SCRIPT };
