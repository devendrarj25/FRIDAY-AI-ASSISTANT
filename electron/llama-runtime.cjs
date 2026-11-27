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
  // The engine is chosen from the ordered folders (own build, official build; see `chooseEngine`); a PC with
  // neither marker layout falls back to the old lookup.
  const choice = deps.bin !== undefined ? null : chooseEngine(root, deps);
  const bin = deps.bin !== undefined ? deps.bin : choice?.bin || findServer(root);
  if (!bin)
    return { ok: false, reason: "the FRIDAY Runtime LLM is not installed (Install Manager)" };
  const port = deps.port ?? (await freeLoopbackPort());
  const key = deps.key ?? newLaunchKey();
  const backend =
    deps.backend !== undefined
      ? deps.backend
      : choice?.entry
        ? choice.entry.backend
        : readBackend(root)?.backend;
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
    model: plan.model,
    engine: choice?.engine ?? null,
    entry: choice?.entry ?? null,
    standby: choice?.standby ?? null,
    standbyPlan: choice?.standby ? standbyFor(plan.model, deps) : null,
    outdated: Boolean(choice?.outdated),
  };
}

/* ------------------------------------------------- dual engine (own + official) */

const OWN_NAME = exeName("friday-runtime-llm");
const OWN_DIR_NAME = "friday-runtime-llm";
const GB = 1024 ** 3;

const ownEngineDir = (root) => path.join(root, "runtime", "engines", OWN_DIR_NAME);
/** Where the owner puts a local own build (`<work>/out/friday-runtime-llm`) so the Install Manager can adopt it. */
const ownLocalDir = (root) => path.join(root, "runtime", "own-build", OWN_DIR_NAME);
const select = () => require("./llm-engine-select.cjs");

const binIn = (dir, names) => {
  for (const wanted of names) {
    const hit = walk(dir, 2, (name) => name.toLowerCase() === wanted.toLowerCase());
    if (hit) return hit;
  }
  return null;
};

/**
 * Every engine folder with a binary, official and own, each in `orderedFolders` order. `origin` is "own" only for a
 * marker that says `friday-own` (a missing origin is official; old markers are never rewritten), `trusted` and `at`
 * come from the ordering, `tag` and `backend` from the marker (the folder name when there is none).
 */
function engineEntries(root, fsApi = fs, ownRecord) {
  if (!root) return [];
  const out = [];
  // The folder decides the origin, never the marker: a marker in the official folder cannot claim friday-own.
  for (const e of orderedFolders(engineDir(root), fsApi)) {
    const bin = binIn(e.dir, SERVER_NAMES);
    if (bin) out.push({ ...e, bin, origin: "official" });
  }
  const record = ownRecord === undefined ? readOwnRecord(fsApi) : ownRecord;
  for (const e of orderedFolders(ownEngineDir(root), fsApi)) {
    const bin = binIn(e.dir, [OWN_NAME]);
    if (!bin) continue;
    const marker = e.marker ? { ...e.marker, origin: "friday-own" } : null;
    out.push({ ...e, marker, bin, origin: "own" });
  }
  return out.map((e) => ({
    ...e,
    trusted: e.trusted && filesVerified(e, record, fsApi),
    tag: String(e.marker?.tag || e.name.split("-")[0] || ""),
    backend: e.marker?.backend || null,
  }));
}

const HEX64 = /^[a-f0-9]{64}$/;
const hashCache = new Map();

/** The own build's record (`config/friday-runtime-llm.json`); null when it cannot be read. */
function readOwnRecord(fsApi = fs) {
  try {
    const record = JSON.parse(
      fsApi.readFileSync(path.join(__dirname, "..", "config", "friday-runtime-llm.json"), "utf8"),
    );
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

function sha256File(file, fsApi) {
  let key = null;
  try {
    const st = fsApi.statSync?.(file);
    if (st) key = `${file}|${st.size}|${st.mtimeMs}`;
  } catch {
    /* no stat: hash every time */
  }
  const hit = key ? hashCache.get(key) : undefined;
  if (hit) return hit;
  const hex = require("node:crypto")
    .createHash("sha256")
    .update(fsApi.readFileSync(file))
    .digest("hex");
  if (key) {
    if (hashCache.size > 256) hashCache.clear();
    hashCache.set(key, hex);
  }
  return hex;
}

/**
 * Re-hash the files the marker lists before the engine may be spawned. An own build is checked against the SHA-256
 * in the own record when the record lists the file, otherwise against the marker; an official engine against the
 * marker. A listed file that is missing or differs makes the folder untrusted. Archive names (the official marker
 * records the zip it came from) are not files of the folder and are skipped; a marker with no hashes has nothing to check.
 */
function filesVerified(entry, record, fsApi = fs) {
  const expected = new Map();
  const add = (list, override) => {
    for (const f of Array.isArray(list) ? list : []) {
      const name = String(f?.name || "");
      if (!name || /\.(zip|7z|tar|gz)$/i.test(name) || !HEX64.test(f.sha256 || "")) continue;
      if (override || !expected.has(name.toLowerCase())) expected.set(name.toLowerCase(), f.sha256);
    }
  };
  add(entry.marker?.files, false);
  if (entry.origin === "own") add(record?.files, true);
  for (const [name, sha] of expected) {
    const file = walk(entry.dir, 2, (n) => n.toLowerCase() === name);
    if (!file) return false;
    try {
      if (sha256File(file, fsApi) !== sha) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The PC facts a bench depends on (see `select().fingerprint`); `deps.gpu` is the measured card name, if any. */
function machineFacts(deps = {}) {
  const os = deps.os || require("node:os");
  const cpus = os.cpus() || [];
  return {
    ramGb: os.totalmem() / GB,
    cores: cpus.length,
    cpuModel: cpus[0]?.model ?? null,
    gpu: deps.gpu ?? null,
  };
}

/**
 * Which engine runs: the pure rule of `llm-engine-select.pickEngine` over the ordered folders (a demoted folder is
 * `trusted:false` and never chosen). `deps`: `prefer` (auto|own|official), `bench` (a stored bench; else the file is
 * read and checked against `machineFacts`), `isHealthy`, `exclude` (folders to skip), `facts`, `fs`.
 * Returns `{ engine, bin, entry, standby, standbyBin, outdated, reason, ownTag, officialTag, prefer }`.
 */
function chooseEngine(root, deps = {}) {
  const sel = select();
  const exclude = new Set(deps.exclude || []);
  const usable = engineEntries(root, deps.fs, deps.ownRecord).filter(
    (e) => !exclude.has(e.dir) && (typeof deps.isHealthy !== "function" || deps.isHealthy(e)),
  );
  const live = usable.filter((e) => e.trusted);
  const ownTag = live.find((e) => e.origin === "own")?.tag || null;
  const officialTag = live.find((e) => e.origin === "official")?.tag || null;
  const prefer = ["auto", "own", "official"].includes(deps.prefer) ? deps.prefer : "auto";
  const bench =
    deps.bench !== undefined
      ? deps.bench
      : sel.readBench(root, {
          fingerprint: sel.fingerprint({
            ...(deps.facts || machineFacts(deps)),
            ownTag,
            officialTag,
          }),
          fs: deps.fs,
        });
  const pick = sel.pickEngine({
    markers: usable,
    bench,
    prefer,
    tagsEqual: !(ownTag && officialTag) || ownTag === officialTag,
  });
  return {
    engine: pick.engine,
    bin: pick.entry?.bin || null,
    entry: pick.entry,
    standby: pick.standby,
    standbyBin: pick.standby?.bin || null,
    outdated: pick.outdated || Boolean(ownTag && officialTag && ownTag !== officialTag),
    reason: pick.reason,
    ownTag,
    officialTag,
    prefer,
  };
}

const modelBytesOf = (file, deps = {}) => {
  try {
    const stat = (deps.stat || deps.statSync || fs.statSync)(file);
    return Number(stat?.size) || 0;
  } catch {
    return 0;
  }
};

/** The idle engine's plan (see `standbyPlan`): cold unless the PC has the memory, always `-c 2048 -np 1`. */
function standbyFor(model, deps = {}) {
  const os = deps.os || require("node:os");
  return select().standbyPlan({
    totalRamGb: os.totalmem() / GB,
    freeRamGb: os.freemem() / GB,
    modelBytes: model ? modelBytesOf(model, deps) : 0,
  });
}

/** Free RAM a bench needs on top of the model when Core stays loaded. */
const BENCH_HEADROOM_GB = 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultProbe = async (url, init) => {
  const res = await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(2000) });
  return { ok: res.ok, status: res.status };
};
const stopOf = (deps) => (child) => {
  try {
    (deps.stop || require("./app-lifecycle.cjs").stopChild)(child, "SIGTERM");
  } catch {
    /* already gone */
  }
};

/** Spawn an engine as a child the one lifecycle owner tracks (quit and crash stop it). */
function spawnEngine(bin, args, env, deps = {}) {
  const spawn = deps.spawn || require("node:child_process").spawn;
  const child = spawn(bin, args, {
    stdio: "ignore",
    windowsHide: true,
    cwd: (deps.os || require("node:os")).tmpdir(),
    env,
  });
  (deps.track || require("./app-lifecycle.cjs").trackOwned)("runner", child, bin);
  return child;
}

/** Wait until `/health` answers ok, the child exits, `signal` aborts, or the time is up. Returns `{ ok, reason }`. */
async function waitHealthy(child, port, deps = {}) {
  const probe = deps.probe || defaultProbe;
  const nap = deps.sleep || sleep;
  let exited = null;
  child.once?.("exit", (code) => {
    exited = code ?? -1;
  });
  child.once?.("error", (err) => {
    exited = String(err?.message || err);
  });
  const until = (deps.now || Date.now)() + (deps.timeoutMs || 120000);
  for (;;) {
    if (deps.signal?.aborted) return { ok: false, reason: "stopped" };
    if (exited !== null)
      return { ok: false, reason: `the runtime stopped while loading (${exited})` };
    if (
      await Promise.resolve(probe(`http://${LOOPBACK}:${port}/health`)).then(
        (r) => r?.ok,
        () => false,
      )
    )
      return { ok: true };
    if ((deps.now || Date.now)() > until) return { ok: false, reason: "never became healthy" };
    await nap(deps.stepMs || 500);
  }
}

/**
 * Start the chosen engine for FRIDAY Core and wait for `/health`. An engine that does not come up is recorded
 * (`engine-install.noteHealth`; the second failure in a row demotes its folder), skipped, and the other engine is tried, so the
 * official build takes over a broken own build. Returns `{ ok, engine, child, ...launch }` or `{ ok:false, tried }`.
 */
async function startEngine(root, deps = {}) {
  // The marker writer is the installer's (`engine-install.noteHealth`); required late, the two files need each other.
  const note = deps.noteHealth || require("./engine-install.cjs").noteHealth;
  const tried = [];
  const skip = [];
  for (let round = 0; round < 2; round += 1) {
    // `deps.launch` is a ready launch (tests, a caller that planned it): it has no folder to record or to fail over from.
    const launch = deps.launch || (await coreLaunch(root, { ...deps, exclude: skip }));
    if (!launch.ok) return { ok: false, reason: launch.reason, tried };
    const entry = launch.entry;
    const child = spawnEngine(launch.bin, launch.args, launch.env, deps);
    const state = await waitHealthy(child, launch.port, deps);
    if (state.ok) {
      if (entry) note(entry, true, deps);
      return { ok: true, child, tried, ...launch };
    }
    stopOf(deps)(child);
    // A stop the owner asked for is not a failed health check: it never counts against the folder.
    if (entry && state.reason !== "stopped") {
      note(entry, false, deps);
      skip.push(entry.dir);
    }
    tried.push({ engine: launch.engine, bin: launch.bin, reason: state.reason });
    if (!entry || state.reason === "stopped") break;
  }
  return { ok: false, reason: "no engine came up", tried };
}

/**
 * Start the idle engine after the active one crashed (or at once when the PC can keep it hot). It takes a governor
 * lease first (`deps.governor.acquire`), runs text-only with `-c 2048 -np 1`, is tracked by the lifecycle owner, and
 * gives the lease back when it exits. `launch` is a `coreLaunch` result. Returns `{ ok, child, port, key, baseUrl }`.
 */
async function startStandby(root, launch, deps = {}) {
  const bin = launch?.standby?.bin;
  if (!launch?.ok || !bin || !launch.model)
    return { ok: false, reason: "there is no standby engine installed" };
  const plan = launch.standbyPlan || standbyFor(launch.model, deps);
  const need = Math.max(0.1, modelBytesOf(launch.model, deps) / GB);
  // No governor, no standby: without a lease nothing checks the memory, so this fails closed.
  if (!deps.governor?.acquire)
    return {
      ok: false,
      reason: "the resource governor is not available, so no standby is started",
    };
  const got = await deps.governor.acquire({
    owner: "llm-standby",
    kind: "llm",
    priority: "chat",
    label: "FRIDAY Runtime LLM standby",
    ttlMs: 6 * 60 * 60 * 1000,
    queue: false,
    options: [{ ramGb: need + 0.5 }],
  });
  if (got?.state !== "granted")
    return {
      ok: false,
      reason: `the resource governor did not grant memory (${got?.reason || got?.state})`,
    };
  const lease = got.lease;
  const port = deps.port ?? (await freeLoopbackPort());
  const key = deps.key ?? newLaunchKey();
  const args = coreArgs({
    model: launch.model,
    port,
    ctx: Number(plan.args[plan.args.indexOf("-c") + 1]) || 2048,
    threads: threadBudget(deps.cpus ?? require("node:os").cpus().length),
    gpu: isGpuBackend(launch.standby.backend),
  });
  let child;
  try {
    child = spawnEngine(bin, args, coreEnv(key, deps.env), deps);
  } catch (err) {
    lease?.release?.();
    return { ok: false, reason: `could not be started: ${String(err?.message || err)}` };
  }
  child.once?.("exit", () => lease?.release?.());
  const state = await waitHealthy(child, port, deps);
  if (!state.ok) {
    stopOf(deps)(child);
    lease?.release?.();
    return { ok: false, reason: state.reason };
  }
  lease?.loaded?.();
  return { ok: true, child, port, key, baseUrl: `http://${LOOPBACK}:${port}/v1`, mode: plan.mode };
}

/**
 * One engine's bench run: start it alone on a free port with a small context, wait for health, ask for 32 greedy
 * tokens, stop it. Returns `{ smokePassed, tps, tokens }` (nothing measured: `tps` null), or `{ stopped:true }`.
 */
async function benchOne(entry, plan, deps) {
  const port = deps.port ?? (await freeLoopbackPort());
  const key = newLaunchKey();
  const args = coreArgs({
    model: plan.model,
    port,
    ctx: 2048,
    threads: threadBudget(deps.cpus ?? require("node:os").cpus().length),
    gpu: isGpuBackend(entry.backend),
  });
  const child = spawnEngine(entry.bin, args, coreEnv(key, deps.env), deps);
  const done = new Promise((resolve) => child.once?.("exit", resolve));
  const stop = () => stopOf(deps)(child);
  deps.signal?.addEventListener?.("abort", stop, { once: true });
  try {
    const state = await waitHealthy(child, port, deps);
    if (deps.signal?.aborted) return { stopped: true };
    if (!state.ok) return { smokePassed: false, tps: null, tokens: [] };
    const ask = deps.request || defaultRequest;
    const out = await ask(`http://${LOOPBACK}:${port}/completion`, key, {
      prompt: deps.prompt || "Count from one to thirty-two in words:",
      n_predict: 32,
      temperature: 0,
      top_k: 1,
      seed: 0,
      cache_prompt: false,
      return_tokens: true,
    }).catch(() => null);
    if (deps.signal?.aborted) return { stopped: true };
    const tokens = Array.isArray(out?.tokens) ? out.tokens : [];
    const tps = Number(out?.timings?.predicted_per_second);
    return {
      smokePassed: tokens.length > 0,
      tps: Number.isFinite(tps) && tps > 0 ? tps : null,
      tokens,
    };
  } finally {
    deps.signal?.removeEventListener?.("abort", stop);
    stop();
    await Promise.race([done, sleep(deps.stopWaitMs ?? 3000)]);
  }
}

async function defaultRequest(url, key, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * The bench of the two engines, one after the other. It runs only when the owner started it (`ownerStarted`) or the
 * PC is idle under a governor lease (`idle()` and `governor`), and never while a voice turn runs (`voiceBusy()`).
 * The two builds must carry the same tag; otherwise nothing runs and the official engine stays (own build outdated).
 * `deps.signal` stops it at once: the running engine is stopped and the next one is never started. The result is
 * stored (`llm-engine-select.writeBench`) only when something was measured. Returns a plain object.
 */
async function runBench(root, deps = {}) {
  const sel = select();
  const refuse = (reason, extra = {}) => ({
    ok: false,
    ran: false,
    stored: false,
    reason,
    ...extra,
  });
  if (deps.voiceBusy?.()) return refuse("voice-turn");
  if (deps.signal?.aborted) return refuse("stopped", { stopped: true });
  const live = engineEntries(root, deps.fs, deps.ownRecord).filter((e) => e.trusted);
  const own = live.find((e) => e.origin === "own");
  const official = live.find((e) => e.origin === "official");
  if (!own || !official) return refuse("needs-both-engines");
  if (own.tag !== official.tag)
    return refuse("own-outdated", {
      outdated: true,
      winner: "official",
      ownTag: own.tag,
      officialTag: official.tag,
    });
  const plan = deps.plan || corePlan(root, deps);
  if (!plan.ok) return refuse("no-model", { error: plan.reason });
  let lease = null;
  // A loaded Core and a benched engine must not both sit in RAM: stop Core first, or refuse when both do not fit.
  const modelGb = Math.max(0.1, modelBytesOf(plan.model, deps) / GB);
  let coreStopped = false;
  if (deps.coreLoaded?.() === true) {
    const os = deps.os || require("node:os");
    if (os.freemem() / GB < modelGb + BENCH_HEADROOM_GB) {
      if (typeof deps.stopCore !== "function") return refuse("core-loaded");
      await deps.stopCore();
      coreStopped = true;
      if (deps.voiceBusy?.()) {
        await deps.resumeCore?.();
        return refuse("voice-turn");
      }
    }
  }
  if (!deps.ownerStarted || deps.governor?.acquire) {
    if (!deps.ownerStarted && deps.idle?.() !== true) return refuse("not-idle");
    if (!deps.governor?.acquire) return refuse("not-idle");
    const got = await deps.governor.acquire({
      owner: "llm-bench",
      kind: "llm",
      priority: "background",
      label: "FRIDAY Runtime LLM bench",
      ttlMs: 20 * 60 * 1000,
      queue: false,
      options: [{ ramGb: modelGb + 0.5 }],
    });
    if (got?.state !== "granted") {
      if (coreStopped) await deps.resumeCore?.();
      return refuse("governor-refused", { detail: got?.reason || got?.state });
    }
    lease = got.lease;
  }
  try {
    const one = deps.measure || ((entry) => benchOne(entry, plan, deps));
    const ownRun = await one(own);
    if (ownRun?.stopped || deps.signal?.aborted) return refuse("stopped", { stopped: true });
    const officialRun = await one(official);
    if (officialRun?.stopped || deps.signal?.aborted) return refuse("stopped", { stopped: true });
    const verdict = sel.decideWinner(ownRun, officialRun);
    const stored = verdict.measured
      ? sel.writeBench(
          root,
          {
            ...verdict,
            fingerprint: {
              ...(deps.facts || machineFacts(deps)),
              ownTag: own.tag,
              officialTag: official.tag,
            },
            spec: deps.spec || "off",
          },
          { fs: deps.fs, now: deps.clock },
        )
      : false;
    return {
      ok: verdict.measured,
      ran: true,
      stored,
      winner: verdict.winner,
      reason: verdict.reason,
      ownTps: verdict.ownTps,
      officialTps: verdict.officialTps,
      sameTokens: verdict.sameTokens,
      speedup: verdict.speedup,
      ownTag: own.tag,
      officialTag: official.tag,
    };
  } finally {
    lease?.release?.();
    if (coreStopped) await deps.resumeCore?.();
  }
}

const modelOf = (root, deps) => {
  const plan = deps.plan || corePlan(root, deps);
  return plan.ok ? plan.model : null;
};

const rowOf = (entry) =>
  entry
    ? {
        installed: true,
        tag: entry.tag,
        backend: entry.backend,
        healthy: entry.trusted,
        name: entry.name,
      }
    : { installed: false, tag: null, backend: null, healthy: false, name: null };

/**
 * What the Doctor and the Install Manager show, as plain data (no handles, no paths of a key): both engines, the
 * active one, the standby plan, the stored bench and the row strings of `llm-engine-select.rowNames`.
 * `deps.prefer` is the owner's `brain.engine.prefer`.
 */
function engineState(root, deps = {}) {
  const sel = select();
  const choice = chooseEngine(root, deps);
  const entries = engineEntries(root, deps.fs);
  const liveOf = (origin) =>
    entries.find((e) => e.origin === origin && e.trusted) ||
    entries.find((e) => e.origin === origin);
  const own = liveOf("own");
  const official = liveOf("official");
  const bench = sel.readBench(root, {
    fingerprint: sel.fingerprint({
      ...(deps.facts || machineFacts(deps)),
      ownTag: choice.ownTag,
      officialTag: choice.officialTag,
    }),
    fs: deps.fs,
  });
  const rows = sel.rowNames({
    ownTag: own?.tag,
    officialTag: official?.tag,
    officialBackend: official?.backend,
    active: choice.engine,
    ownTps: bench?.ownTps,
    officialTps: bench?.officialTps,
  });
  const doctor = [
    {
      id: "own",
      name: rows.own,
      ok: Boolean(own && own.trusted),
      detail: own
        ? own.trusted
          ? "ready"
          : "demoted after failed health checks"
        : "not installed",
    },
    {
      id: "official",
      name: rows.official,
      ok: Boolean(official && official.trusted),
      detail: official
        ? official.trusted
          ? "ready"
          : "demoted after failed health checks"
        : "not installed",
    },
  ];
  if (rows.status)
    doctor.push({ id: "status", name: rows.status, ok: true, detail: choice.reason });
  if (rows.outdated)
    doctor.push({
      id: "outdated",
      name: rows.outdated,
      ok: false,
      detail: `own ${own?.tag}, official ${official?.tag}`,
    });
  return {
    prefer: choice.prefer,
    active: choice.engine,
    reason: choice.reason,
    outdated: choice.outdated,
    own: rowOf(own),
    official: rowOf(official),
    standby: choice.standby ? { engine: choice.standby.origin, tag: choice.standby.tag } : null,
    standbyMode: choice.standby ? standbyFor(modelOf(root, deps), deps).mode : null,
    bench: bench
      ? {
          winner: bench.winner,
          ownTps: bench.ownTps,
          officialTps: bench.officialTps,
          sameTokens: bench.sameTokens,
          at: bench.at,
        }
      : null,
    thresholdsUnverified: sel.THRESHOLDS_UNVERIFIED,
    rows,
    doctor,
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
  OWN_NAME,
  OWN_DIR_NAME,
  ownEngineDir,
  ownLocalDir,
  engineEntries,
  machineFacts,
  chooseEngine,
  standbyFor,
  startEngine,
  startStandby,
  runBench,
  engineState,
};
