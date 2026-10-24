/**
 * The Hugging Face runner: Transformers' own OpenAI-compatible server
 * (`transformers serve`) for Safetensors and PyTorch models.
 *
 * Why it is not in the kernel's Python environment: it needs PyTorch, which is
 * large and which the voice stack must never depend on. It lives in its own
 * virtual environment under <FRIDAY folder>\runtime\Hugging_Face_runner, which
 * the Install Manager creates and updates, and which uninstalling FRIDAY's app
 * leaves with the rest of the owner's data.
 *
 * Models reach the server through Hugging Face's own cache layout, kept inside
 * the FRIDAY folder (HF_HOME). A downloaded repo or an imported Safetensors
 * folder is linked into that cache under its repo id, so `transformers serve`
 * finds it by name with no network. The server runs offline: a model that is
 * not here is reported as missing, never silently fetched.
 *
 * Source for the server and its options (host, port, model-timeout, device,
 * dtype, quantization): huggingface/transformers, src/transformers/cli/serve.py
 * and docs/source/en/serve-cli/serving.md.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TOOL_ID = "Hugging Face runner";
const PORT = 8083;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
/** Seconds an idle model stays in memory before the server unloads it. */
const MODEL_TIMEOUT_S = 600;
/** The CUDA wheel index used on a PC with an NVIDIA GPU. Newer indexes exist; this one is pinned. */
const CUDA_INDEX = "https://download.pytorch.org/whl/cu128";
const WIN = process.platform === "win32";

const safeDir = () => TOOL_ID.replace(/[^\w.-]+/g, "_");
const runnerDir = (root) => path.join(root, "runtime", safeDir());
const venvDir = (root) => path.join(runnerDir(root), ".venv");
const binDir = (root) => path.join(venvDir(root), WIN ? "Scripts" : "bin");
const venvPython = (root) => path.join(binDir(root), WIN ? "python.exe" : "python");
const serveBin = (root) => path.join(binDir(root), WIN ? "transformers.exe" : "transformers");
const markerFile = (root) => path.join(runnerDir(root), ".friday-install.json");
/** HF_HOME for everything this runner downloads or serves. */
const cacheHome = (root) => path.join(root, "models", "huggingface");
const hubDir = (root) => path.join(cacheHome(root), "hub");

function readMarker(root) {
  try {
    return JSON.parse(fs.readFileSync(markerFile(root), "utf8"));
  } catch {
    return null;
  }
}

/** The state of the runner on disk, from the folder and the marker its installer wrote. */
function detect(root) {
  if (!root) return { installed: false, status: "Missing" };
  const exe = serveBin(root);
  if (!fs.existsSync(exe) || !fs.existsSync(venvPython(root))) {
    return { installed: false, status: "Missing" };
  }
  const marker = readMarker(root);
  return {
    installed: true,
    version: marker?.transformers || marker?.version || "installed",
    path: exe,
    status: "Ready",
    detail: marker?.torch ? `PyTorch ${marker.torch}${marker.cuda ? " (CUDA)" : ""}` : undefined,
  };
}

/** The environment the server runs in: caches inside the FRIDAY folder, offline. */
function serveEnv(root, base = process.env) {
  return {
    ...base,
    HF_HOME: cacheHome(root),
    HF_HUB_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    TRANSFORMERS_OFFLINE: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

/** Arguments for `transformers serve`, bound to this PC only. */
function serveArgs({ port = PORT, timeoutS = MODEL_TIMEOUT_S } = {}) {
  return [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--model-timeout",
    String(timeoutS),
  ];
}

/**
 * The Python run by the Install Manager: create the virtual environment, put
 * PyTorch in it (the CUDA build when asked and available, else the default
 * wheel), then Transformers with its serving extra, and write the marker.
 * argv: <runner folder> <cuda 1|0>
 */
const INSTALL_SCRIPT = [
  "import json, os, subprocess, sys, venv",
  "d, cuda = sys.argv[1], sys.argv[2] == '1'",
  "env = os.path.join(d, '.venv')",
  "os.makedirs(d, exist_ok=True)",
  "venv.EnvBuilder(with_pip=True).create(env)",
  "py = os.path.join(env, 'Scripts' if os.name == 'nt' else 'bin', 'python.exe' if os.name == 'nt' else 'python')",
  "pip = lambda *a: subprocess.check_call([py, '-m', 'pip', *a])",
  "pip('install', '--upgrade', 'pip')",
  "got_cuda = False",
  "if cuda:",
  `    try:\n        pip('install', '--upgrade', 'torch', '--index-url', '${CUDA_INDEX}')\n        got_cuda = True\n    except subprocess.CalledProcessError:\n        print('CUDA build of PyTorch was not available; using the default build', flush=True)`,
  "if not got_cuda:",
  "    pip('install', '--upgrade', 'torch')",
  "pip('install', '--upgrade', 'transformers[serving]', 'huggingface_hub')",
  "ver = lambda n: subprocess.check_output([py, '-c', f'import importlib.metadata as m; print(m.version(\"{n}\"))'], text=True).strip()",
  "json.dump({'id': 'Hugging Face runner', 'transformers': ver('transformers'), 'torch': ver('torch'), 'cuda': got_cuda}, open(os.path.join(d, '.friday-install.json'), 'w'))",
  "print('Hugging Face runner ready', flush=True)",
].join("\n");

function installArgs(root, cuda) {
  return ["-c", INSTALL_SCRIPT, runnerDir(root), cuda ? "1" : "0"];
}

// ---------------------------------------------------------------- HF cache
/** The repo id as a hub-cache folder name: owner/name -> models--owner--name. */
function cacheFolderFor(repoId) {
  return `models--${String(repoId).replace(/\//g, "--")}`;
}

function linkOrCopy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.rmSync(to, { force: true });
    fs.linkSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
  }
}

function filesUnder(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Make a downloaded or imported model folder visible to `transformers serve`
 * under `repoId`, in Hugging Face's cache layout (refs/main + snapshots/<rev>).
 * Files are hard-linked, so it costs no extra disk. Returns the id the server
 * will list it under.
 */
function registerSnapshot(root, repoId, sourceDir) {
  if (!root) return { ok: false, error: "no FRIDAY folder is selected" };
  const id = String(repoId || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(id)) {
    return { ok: false, error: `"${id}" is not an owner/name model id` };
  }
  if (!fs.existsSync(path.join(sourceDir, "config.json"))) {
    return { ok: false, error: "the folder has no config.json, so it is not a Transformers model" };
  }
  const files = filesUnder(sourceDir).filter(
    (rel) => !rel.startsWith(".cache") && !rel.endsWith(".part"),
  );
  const revision = crypto.createHash("sha1").update(files.sort().join("\n")).digest("hex");
  const model = path.join(hubDir(root), cacheFolderFor(id));
  const snapshot = path.join(model, "snapshots", revision);
  try {
    for (const rel of files) linkOrCopy(path.join(sourceDir, rel), path.join(snapshot, rel));
    fs.mkdirSync(path.join(model, "refs"), { recursive: true });
    fs.writeFileSync(path.join(model, "refs", "main"), revision);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  return { ok: true, id, revision, files: files.length };
}

/** Repo ids registered in the cache, newest layout only. */
function listRegistered(root) {
  try {
    return fs
      .readdirSync(hubDir(root))
      .filter((name) => name.startsWith("models--"))
      .map((name) => name.slice("models--".length).replace(/--/g, "/"));
  } catch {
    return [];
  }
}

/** Remove a registered model's cache entry (its source folder is not touched). */
function unregister(root, repoId) {
  try {
    fs.rmSync(path.join(hubDir(root), cacheFolderFor(repoId)), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** A stable `owner/name` for an imported folder that has no repo id of its own. */
const importedRepoId = (slug) => `friday/${String(slug).replace(/[^\w.-]+/g, "-")}`;

module.exports = {
  TOOL_ID,
  PORT,
  ENDPOINT,
  MODEL_TIMEOUT_S,
  CUDA_INDEX,
  runnerDir,
  venvPython,
  serveBin,
  cacheHome,
  hubDir,
  detect,
  serveEnv,
  serveArgs,
  installArgs,
  INSTALL_SCRIPT,
  cacheFolderFor,
  registerSnapshot,
  listRegistered,
  unregister,
  importedRepoId,
};
