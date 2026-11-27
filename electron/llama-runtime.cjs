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
 * FRIDAY Core is started from `config/friday-core.json` (`coreLaunch`): its own free loopback port, a per-launch API key
 * that lives in memory and reaches the server through its environment (never the command line, never a file), and
 * the flags in `coreArgs`. The server binary may be named `friday-runtime-llm` or the upstream `llama-server`.
 *
 * The zip is unpacked by Python's zipfile after every entry is checked to stay inside the target folder, so a
 * zip with a `..` or absolute path cannot write elsewhere.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const exeName = (name) => (process.platform === "win32" ? `${name}.exe` : name);
/** The runtime binary, in order of preference: FRIDAY's own name first, the upstream name next to it. */
const SERVER_NAMES = ["friday-runtime-llm", "llama-server"].map(exeName);
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

/**
 * The runtime FRIDAY installed (the folder installed last wins, see orderedFolders), or null. In one folder the
 * `friday-runtime-llm` name wins over the upstream `llama-server` name; either is accepted.
 */
function findServer(root) {
  if (!root) return null;
  for (const { dir } of orderedFolders(engineDir(root))) {
    for (const wanted of SERVER_NAMES) {
      const found = walk(dir, 2, (name) => name.toLowerCase() === wanted);
      if (found) return found;
    }
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

/* ------------------------------------------------------ FRIDAY Core launch */

/** Never the stock llama.cpp port: a user's own llama-server and FRIDAY Core must not meet on one socket. */
const STOCK_PORT = 8080;
const LOOPBACK = "127.0.0.1";
/** Core serves one conversation at a time (see coreArgs), so the one slot gets the whole served context. */
const CORE_SLOTS = 1;
/** Decode is memory-bound: threads past this number add contention, not speed. */
const MAX_LLM_THREADS = 8;
/** The ears (speech recognition and the voice stack) keep this many cores while Core runs a turn. */
const EARS_CORES = 2;
const CORE_ROLES = ["default", "lite"];

/**
 * Threads for the language model, leaving cores for the ears. A 4-core PC gives 3 (one core stays for speech
 * recognition and the app), 6 cores give 4, 8 give 6, and the number is capped because decode stops scaling.
 * An unknown core count is treated as 4.
 */
function threadBudget(cpus) {
  const n = Number.isInteger(cpus) && cpus > 0 ? cpus : 4;
  const free = n <= 4 ? n - 1 : n - EARS_CORES;
  return Math.max(1, Math.min(MAX_LLM_THREADS, free));
}

/** A key for one launch, kept in memory by the caller. It is never written to a file or to the command line. */
function newLaunchKey(random = require("node:crypto").randomBytes) {
  return `fk-${random(32).toString("hex")}`;
}

/** A free loopback port chosen by the OS, never the stock 8080. `net` is injected by tests. */
async function freeLoopbackPort({ net = require("node:net"), tries = 8 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, LOOPBACK, () => {
        const { port: p } = server.address();
        server.close(() => resolve(p));
      });
    });
    if (port !== STOCK_PORT) return port;
  }
  throw new Error("no free loopback port was found");
}

/** True for a build that can use the graphics card (the CUDA and Vulkan zips); the CPU zip cannot. */
const isGpuBackend = (backend) => backend === "cuda" || backend === "vulkan";

/**
 * The command line of FRIDAY Core. The API key is NOT here: the pinned build reads `LLAMA_API_KEY` from its
 * environment, so the key stays off the command line (other processes of the user can read an argv) and off disk.
 *
 *   -np 1            one slot, so `-c` is all one conversation's context. Voice and chat turns queue through it;
 *                    two slots would halve each one's window and compete for the same cores.
 *   -t               the thread budget above, so the ears keep their cores.
 *   --cache-reuse    reuse the cached prompt prefix (the fixed system and tools text) after a small change.
 *   -ngl auto        only on a GPU build; a CPU build gets no GPU flag at all.
 *   no slot saving   no `--slot-save-path`: a saved slot holds prompt text, which can be owner data.
 *   --no-webui       the server's bundled page is not wanted.
 */
function coreArgs({ model, mmproj = "", port, ctx = 8192, threads, gpu = false }) {
  if (!model) throw new Error("FRIDAY Core needs a model file");
  if (!Number.isInteger(port) || port <= 0 || port === STOCK_PORT)
    throw new Error("FRIDAY Core needs its own free loopback port");
  const args = ["-m", model];
  if (mmproj) args.push("--mmproj", mmproj);
  args.push(
    "--host",
    LOOPBACK,
    "--port",
    String(port),
    "-c",
    String(ctx),
    "-np",
    String(CORE_SLOTS),
    "-t",
    String(threads ?? threadBudget()),
    "--jinja",
    "-fa",
    "auto",
    "--cache-reuse",
    "256",
    "--no-webui",
  );
  if (gpu) args.push("-ngl", "auto");
  return args;
}

/** A GGUF that is not a chat model by itself: a projector, or one of FRIDAY Core's own files (started by Core). */
function coreDiskNames(deps = {}) {
  try {
    const manifest = require("./friday-core.cjs").read(deps);
    return new Set(
      (manifest?.variants || []).flatMap((v) => (v.files || []).map((f) => String(f.disk))),
    );
  } catch {
    return new Set();
  }
}
const MMPROJ_NAME = /(^|[-_.])mmproj([-_.]|$)/i;

/**
 * The GGUF files the generic "start the one model you have" rule may count: projectors (`mmproj`) and the FRIDAY Core
 * files (model, projector, embedder; Core has its own start) sit next to a chat model without making it ambiguous.
 */
function chatCandidates(paths, deps = {}) {
  const core = coreDiskNames(deps);
  return (paths || []).filter((p) => {
    const base = path.basename(String(p));
    return !MMPROJ_NAME.test(base) && !core.has(base);
  });
}

/**
 * Which FRIDAY Core variant to start: `opts.variant`, else the default then the lite one, each only when its model
 * file is on disk at the pinned size. A projector that is missing starts the model text-only (`mmproj` is null).
 * The embedder is never a brain. `deps.stat` and `deps.manifest` are injected by tests.
 */
function corePlan(root, opts = {}) {
  const core = require("./friday-core.cjs");
  const manifest = core.read(opts);
  if (!manifest) return { ok: false, reason: "the FRIDAY Core manifest could not be read" };
  const brains = manifest.variants.filter((v) => v.role !== "embedder");
  const order = opts.variant
    ? brains.filter((v) => v.id === opts.variant)
    : CORE_ROLES.flatMap((role) => brains.filter((v) => v.role === role));
  for (const v of order) {
    const planned = core.planAssets(root, v.id, { ...opts, pack: null });
    if (!planned.ok) continue;
    const model = planned.assets.find((a) => a.kind === "model" && a.present);
    if (!model) continue;
    const proj = planned.assets.find((a) => a.kind === "mmproj" && a.present);
    return {
      ok: true,
      variant: v.id,
      fridayName: v.fridayName,
      model: model.dest,
      mmproj: proj ? proj.dest : null,
      caps: Array.isArray(v.caps) ? v.caps : [],
      ctx: Number(manifest.serve?.ctx) > 0 ? Number(manifest.serve.ctx) : 8192,
    };
  }
  return {
    ok: false,
    reason: "no FRIDAY Core model is installed yet (install it from the Install Manager)",
  };
}

/**
 * What the router may rely on for this launch: text always; image and audio only when the projector is loaded and
 * the manifest lists them; tools because the chat template runs with `--jinja`.
 */
function coreCapabilities(plan) {
  const caps = new Set(plan.caps || []);
  const seen = Boolean(plan.mmproj);
  return {
    chat: true,
    vision: seen && caps.has("image"),
    audio: seen && [...caps].some((c) => c.startsWith("audio")),
    tools: caps.has("tools"),
  };
}

/** The environment of the child: ours, minus any inherited llama.cpp settings, plus this launch's key. */
function coreEnv(key, base = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(base || {})) {
    if (/^LLAMA_(ARG_|API_KEY)/i.test(name)) continue;
    env[name] = value;
  }
  env.LLAMA_API_KEY = key;
  return env;
}

/**
 * Everything needed to start FRIDAY Core, from the manifest: `{ ok, bin, args, env, port, key, baseUrl, variant }`.
 * Nothing is spawned and nothing is written. The key exists only in the returned object.
 * `deps`: `port`, `key`, `cpus`, `backend`, `bin`, plus the `corePlan` injections (`stat`, `manifest`).
 */
async function coreLaunch(root, deps = {}) {
  const plan = corePlan(root, deps);
  if (!plan.ok) return plan;
  const bin = deps.bin !== undefined ? deps.bin : findServer(root);
  if (!bin)
    return { ok: false, reason: "the FRIDAY Runtime LLM is not installed (Install Manager)" };
  const port = deps.port ?? (await freeLoopbackPort());
  const key = deps.key ?? newLaunchKey();
  const backend = deps.backend !== undefined ? deps.backend : readBackend(root)?.backend;
  const args = coreArgs({
    model: plan.model,
    mmproj: plan.mmproj || "",
    port,
    ctx: plan.ctx,
    threads: threadBudget(deps.cpus ?? require("node:os").cpus().length),
    gpu: isGpuBackend(backend),
  });
  return {
    ok: true,
    bin,
    args,
    env: coreEnv(key, deps.env),
    port,
    key,
    baseUrl: `http://${LOOPBACK}:${port}/v1`,
    variant: plan.variant,
    fridayName: plan.fridayName,
    vision: Boolean(plan.mmproj),
    capabilities: coreCapabilities(plan),
    gpu: isGpuBackend(backend),
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
  STOCK_PORT,
  CORE_SLOTS,
  SERVER_NAMES,
  threadBudget,
  newLaunchKey,
  freeLoopbackPort,
  isGpuBackend,
  coreArgs,
  chatCandidates,
  corePlan,
  coreCapabilities,
  coreEnv,
  coreLaunch,
};
