/**
 * llama.cpp as a local engine FRIDAY installs and runs herself.
 *
 * Setup downloads the pinned Windows release zip named in `config/local-runners.json` (SHA-256 checked by the
 * downloader), and this file unpacks it into `<FRIDAY_ROOT>/runtime/engines/llama.cpp/<tag>/`. Nothing here touches
 * the system PATH or needs administrator rights. `findServer` gives the `llama-server` binary to start, and
 * `preferred` picks the chat model FRIDAY downloaded when more than one GGUF sits in the models folder.
 *
 * The Install Manager picks the BUILD by the measured facts (`backendChain`): the CUDA 12 zip with its cudart zip on
 * an NVIDIA card the driver and the compute capability support and with room in video memory, else the Vulkan zip on
 * any real Vulkan device, else the CPU zip (AVX2 or AVX-512 by the processor's flags, the plain build without AVX2).
 * `planAssets` matches the release's asset names (patterns, case-insensitive) and reads each digest from the release
 * API. After an install a 3 second health check runs the binary; a build that does not start is removed and the next
 * step down (CUDA, Vulkan, CPU) is tried, with the reason recorded (`electron/engine-install.cjs`).
 *
 * The zip is unpacked by Python's zipfile after every entry is checked to stay inside the target folder, so a
 * zip with a `..` or absolute path cannot write elsewhere.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const SERVER_NAMES = process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"];
/** The chat model setup downloads for her; its file name carries this id. */
const DEFAULT_CHAT_ID = "qwen3-4b";

const engineDir = (root) => path.join(root, "runtime", "engines", "llama.cpp");

function walk(dir, depth, hit) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && hit(entry.name)) return full;
  }
  if (depth <= 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = walk(path.join(dir, entry.name), depth - 1, hit);
    if (found) return found;
  }
  return null;
}

const ENGINE_MARKER = ".friday-engine.json";

/** The marker an installer wrote in an engine folder, or null when it is missing, unreadable or not an object. */
function readFolderMarker(dir, fsApi = fs) {
  try {
    const marker = JSON.parse(fsApi.readFileSync(path.join(dir, ENGINE_MARKER), "utf8"));
    return marker && typeof marker === "object" && !Array.isArray(marker) ? marker : null;
  } catch {
    return null;
  }
}

/**
 * The engine folders under `base`, active first. Order: a folder whose marker is readable and not marked unhealthy,
 * then the rest; within a group the marker's `installedAt` (newest first, a missing or non-numeric one counts as the
 * oldest), and only then the folder name (numeric, newest first). The name alone is not the order: a CPU fallback
 * installed after a broken CUDA build of the same tag must be the one in use.
 */
function orderedFolders(base, fsApi = fs) {
  let entries = [];
  try {
    entries = fsApi
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !/\.(staging|prev)$/.test(e.name));
  } catch {
    return [];
  }
  return entries
    .map((e) => {
      const dir = path.join(base, e.name);
      const marker = readFolderMarker(dir, fsApi);
      const at = Number(marker?.installedAt);
      return {
        name: e.name,
        dir,
        marker,
        trusted: Boolean(marker) && marker.healthy !== false && marker.active !== false,
        at: Number.isFinite(at) && typeof marker?.installedAt === "number" ? at : 0,
      };
    })
    .sort(
      (a, b) =>
        Number(b.trusted) - Number(a.trusted) ||
        b.at - a.at ||
        b.name.localeCompare(a.name, undefined, { numeric: true }),
    );
}

/** The llama-server FRIDAY installed (the folder installed last wins, see orderedFolders), or null. */
function findServer(root) {
  if (!root) return null;
  for (const { dir } of orderedFolders(engineDir(root))) {
    const found = walk(dir, 2, (name) => SERVER_NAMES.includes(name.toLowerCase()));
    if (found) return found;
  }
  return null;
}

const installed = (root) => Boolean(findServer(root));

/** With several GGUF files and no choice made, the chat model setup downloaded is used; otherwise null. */
function preferred(paths) {
  const mine = (paths || []).filter((p) =>
    path.basename(p).toLowerCase().replace(/_/g, "-").includes(DEFAULT_CHAT_ID),
  );
  return mine.length === 1 ? mine[0] : null;
}

const SAFE_EXTRACT = `
import os, sys, zipfile
zip_path, dest = sys.argv[1], os.path.realpath(sys.argv[2])
os.makedirs(dest, exist_ok=True)
with zipfile.ZipFile(zip_path) as z:
    for info in z.infolist():
        target = os.path.realpath(os.path.join(dest, info.filename))
        if target != dest and not target.startswith(dest + os.sep):
            sys.stderr.write("unsafe path in zip: " + info.filename + "\\n")
            sys.exit(3)
    z.extractall(dest)
print("ok")
`;

/** Unpack a zip into `dest` through Python's zipfile. `run` is injected by tests. */
function extractZip(zip, dest, { python = process.env.FRIDAY_PYTHON || "python", run } = {}) {
  const exec =
    run ||
    ((cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 120_000, windowsHide: true }, (err, stdout, stderr) =>
          resolve({
            ok: !err,
            output: String(stdout || "").trim(),
            error: err ? String(stderr || err.message) : null,
          }),
        );
      }));
  return exec(python, ["-I", "-c", SAFE_EXTRACT, zip, dest]);
}

/**
 * Put a downloaded release zip in place. Returns { ok, server } or { ok: false, error }.
 * An already installed server for the same tag is kept as it is.
 */
async function installFromZip(root, zip, tag, deps = {}) {
  if (!root || !zip || !fs.existsSync(zip))
    return { ok: false, error: "the llama.cpp zip is not on disk" };
  const dest = path.join(
    engineDir(root),
    String(tag || "release").replace(/[^A-Za-z0-9._-]/g, "_"),
  );
  const before = findServer(root);
  if (before && before.startsWith(dest)) return { ok: true, server: before, kept: true };
  const out = await extractZip(zip, dest, deps);
  if (!out.ok) return { ok: false, error: out.error || "the zip could not be unpacked" };
  const server = findServer(root);
  return server
    ? { ok: true, server }
    : { ok: false, error: "the zip was unpacked but holds no llama-server" };
}

/* --------------------------------------------------------- build by facts */

/** An NVIDIA card needs this much free video memory to be worth a CUDA build (weights plus cache plus the desktop). */
const MIN_CUDA_VRAM_GB = 4;
/** CUDA 12 builds need compute capability 7.5 (Turing) or newer. */
const MIN_COMPUTE_CAP = 7.5;
const BACKENDS = Object.freeze(["cuda", "vulkan", "cpu"]);

const finite = (v) => {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const cudaLevel = (text) => {
  const m = /^(\d+)(?:\.(\d+))?/.exec(String(text ?? "").trim());
  return m ? Number(`${m[1]}.${m[2] ?? "0"}`) : null;
};

/** The CPU build variant the processor's flags allow: avx512, avx2, plain (no AVX2) or cpu (flags not measured). */
function cpuVariant(facts) {
  const cpu = facts && typeof facts.cpu === "object" && facts.cpu ? facts.cpu : {};
  if (cpu.avx512 === true && cpu.avx2 !== false) return "avx512";
  if (cpu.avx2 === true) return "avx2";
  if (cpu.avx2 === false) return "plain";
  return "cpu";
}

/**
 * The builds worth trying on this PC, best first, and why each skipped one was skipped. Pure; never branches on a
 * card's name. `options.computeCap` is the CUDA compute capability a probe read (nvidia-smi `compute_cap`); unknown
 * does not rule CUDA out, because the health check after the install is the final word.
 */
function backendChain(facts, options = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const gpus = Array.isArray(f.gpus) ? f.gpus.filter((g) => g && typeof g === "object") : [];
  const nvidia = gpus.find((g) => g.vendor === "nvidia") || null;
  const chain = [];
  const skipped = [];

  if (!nvidia) skipped.push({ backend: "cuda", reason: "no NVIDIA graphics card was found" });
  else {
    const level = cudaLevel(f.cuda?.driverCuda);
    const cap = finite(options.computeCap ?? nvidia.computeCap ?? f.computeCap);
    const total = finite(nvidia.vramGb);
    const free = finite(f.gpuFreeGb ?? (f.gpuVendor === "nvidia" ? f.vramFreeGb : null)) ?? total;
    if (level !== null ? level < 12 : f.cudaReady !== true)
      skipped.push({ backend: "cuda", reason: "the NVIDIA driver does not support CUDA 12" });
    else if (cap !== null && cap < MIN_COMPUTE_CAP)
      skipped.push({
        backend: "cuda",
        reason: `compute capability ${cap} is below ${MIN_COMPUTE_CAP}`,
      });
    else if (free === null && nvidia.vramCapped !== true)
      skipped.push({ backend: "cuda", reason: "the card's video memory could not be measured" });
    else if (free !== null && free < MIN_CUDA_VRAM_GB)
      skipped.push({
        backend: "cuda",
        reason: `only ${free} GB of video memory is free; ${MIN_CUDA_VRAM_GB} GB is needed`,
      });
    else chain.push({ backend: "cuda", variant: "cuda", driverCuda: level });
  }

  if (f.vulkan === true && gpus.length > 0) chain.push({ backend: "vulkan", variant: "vulkan" });
  else
    skipped.push({
      backend: "vulkan",
      reason:
        f.vulkan === true ? "no real graphics device for Vulkan" : "no Vulkan driver was found",
    });

  chain.push({ backend: "cpu", variant: cpuVariant(f) });
  return { chain, skipped };
}

/** The step below one that failed: cuda, then vulkan, then cpu (only entries the chain lists). */
function nextStep(chain, failedBackend) {
  const at = chain.findIndex((entry) => entry.backend === failedBackend);
  return at >= 0 ? chain[at + 1] || null : null;
}

const asset = (a) => ({ name: a.name, url: a.url, bytes: a.bytes || 0, sha256: a.sha256 || "" });
const ARCH = "x64";
const CPU_PATTERNS = {
  avx512: [
    new RegExp(`-bin-win-avx512-${ARCH}\\.zip$`, "i"),
    new RegExp(`-bin-win-cpu-${ARCH}\\.zip$`, "i"),
  ],
  avx2: [
    new RegExp(`-bin-win-avx2-${ARCH}\\.zip$`, "i"),
    new RegExp(`-bin-win-cpu-${ARCH}\\.zip$`, "i"),
  ],
  plain: [
    new RegExp(`-bin-win-(?:noavx|avx)-${ARCH}\\.zip$`, "i"),
    new RegExp(`-bin-win-cpu-${ARCH}\\.zip$`, "i"),
  ],
  cpu: [new RegExp(`-bin-win-cpu-${ARCH}\\.zip$`, "i")],
};
const CUDA_MAIN = /^llama-b\d+-bin-win-cuda-(\d+\.\d+)-x64\.zip$/i;
const cudartFor = (minor) =>
  new RegExp(`^cudart-llama-bin-win-cuda-${minor.replace(".", "\\.")}-x64\\.zip$`, "i");

/**
 * The zips of one chain step out of a release's asset list. CUDA: the newest 12.x build the driver supports and the
 * cudart zip of the same minor (both are needed). Every zip must carry a digest: one without is not installable.
 * Returns `{ ok, zips, variant }` or `{ ok: false, reason }`.
 */
function planAssets(entry, assets) {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => a && a.name && a.url);
  let zips = [];
  let variant = entry.variant;
  if (entry.backend === "cuda") {
    const driver = entry.driverCuda ?? 12;
    const builds = list
      .map((a) => ({ a, m: CUDA_MAIN.exec(a.name) }))
      .filter((x) => x.m && Number(x.m[1]) >= 12 && Number(x.m[1]) <= driver)
      .sort((x, y) => Number(y.m[1]) - Number(x.m[1]));
    for (const { a, m } of builds) {
      const rt = list.find((x) => cudartFor(m[1]).test(x.name));
      if (rt) {
        zips = [asset(a), asset(rt)];
        variant = `cuda-${m[1]}`;
        break;
      }
    }
    if (!zips.length)
      return {
        ok: false,
        reason: `no CUDA 12 build up to CUDA ${driver} with its cudart zip in this release`,
      };
  } else if (entry.backend === "vulkan") {
    const hit = list.find((a) =>
      new RegExp(`^llama-.*-bin-win-vulkan-${ARCH}\\.zip$`, "i").test(a.name),
    );
    if (!hit) return { ok: false, reason: "this release has no Vulkan build for Windows" };
    zips = [asset(hit)];
  } else {
    const patterns = CPU_PATTERNS[entry.variant] || CPU_PATTERNS.cpu;
    let hit = null;
    for (const p of patterns) {
      hit = list.find((a) => /^llama-/i.test(a.name) && p.test(a.name));
      if (hit) break;
    }
    if (!hit) return { ok: false, reason: "this release has no CPU build for Windows" };
    zips = [asset(hit)];
    variant = /-bin-win-(avx512|avx2|noavx|avx)-/i.exec(hit.name)?.[1]?.toLowerCase() || "cpu";
  }
  const missing = zips.find((z) => !/^[a-f0-9]{64}$/.test(z.sha256));
  if (missing) return { ok: false, reason: `the release published no SHA-256 for ${missing.name}` };
  return { ok: true, zips, variant };
}

/**
 * The 3 second health check: the binary must start and answer. A missing DLL, an unsupported instruction or a driver
 * that refuses the build ends the process with a loader status (0xC...) or no output. `exec` is injected by tests.
 */
function healthCheck(bin, args = ["--version"], { timeoutMs = 3000, exec } = {}) {
  const run =
    exec ||
    ((file, argv, opts) =>
      new Promise((resolve) => {
        execFile(file, argv, { ...opts, windowsHide: true }, (err, stdout, stderr) =>
          resolve({
            code: err ? (typeof err.code === "number" ? err.code : -1) : 0,
            killed: Boolean(err && err.killed),
            output: `${stdout || ""}${stderr || ""}`.trim(),
            error: err ? String(err.message || err) : null,
          }),
        );
      }));
  return Promise.resolve(run(bin, args, { timeout: timeoutMs })).then((r) => {
    if (r.killed) return { ok: false, reason: `did not answer within ${timeoutMs / 1000} s` };
    const loader = Number(r.code) >= 0xc0000000 || Number(r.code) < 0;
    if (Number(r.code) === 0 || (r.output && !loader)) return { ok: true, output: r.output };
    return {
      ok: false,
      reason: loader
        ? `it could not start (exit status 0x${(Number(r.code) >>> 0).toString(16)})`
        : r.error || `exit status ${r.code}`,
    };
  });
}

/** What the active llama-server's folder says about its build (written by the installer), or null. */
function readBackend(root) {
  const server = findServer(root);
  if (!server) return null;
  let dir = path.dirname(server);
  const base = engineDir(root);
  for (let i = 0; i < 4 && dir.startsWith(base) && dir !== base; i += 1) {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(dir, ".friday-engine.json"), "utf8"));
      if (marker && typeof marker === "object") return { ...marker, server };
    } catch {
      /* look one folder up */
    }
    dir = path.dirname(dir);
  }
  const tag = path.relative(base, server).split(path.sep)[0] || "";
  return {
    id: "llama.cpp",
    tag,
    backend: null,
    version: tag.replace(/^b/i, "").replace(/-.*$/, ""),
    server,
  };
}

/** The llama.cpp release repo and the pinned release (the CPU zip the setup path already verifies). */
const LLAMA_REPO = "ggml-org/llama.cpp";

module.exports = {
  engineDir,
  ENGINE_MARKER,
  readFolderMarker,
  orderedFolders,
  findServer,
  installed,
  preferred,
  extractZip,
  installFromZip,
  DEFAULT_CHAT_ID,
  LLAMA_REPO,
  BACKENDS,
  MIN_CUDA_VRAM_GB,
  MIN_COMPUTE_CAP,
  cpuVariant,
  backendChain,
  nextStep,
  planAssets,
  healthCheck,
  readBackend,
  walk,
};
