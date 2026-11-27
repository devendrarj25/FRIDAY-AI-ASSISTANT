/**
 * FRIDAY Runtime engine: an optional own build of the onnxruntime engine, made from its official source.
 *
 * This is NOT part of the Windows CMD chain. `npm run setup`, `npm run doctor` and `npm run build:win` never call it,
 * and nothing in the app needs it: FRIDAY runs on the pinned official wheel unless a verified own wheel is installed.
 * The owner runs it by hand, on Windows (Visual Studio 2022 with the C++ workload, CMake 3.28 or newer, 64-bit Python)
 * or on Linux (a C++ compiler, CMake, Python). The upstream source is cloned at a pinned release tag and never edited.
 *
 * It builds the full CPU provider as a Python wheel with the official `tools/ci_build/build.py` (Release,
 * `--build_wheel`, `--skip_tests`, `--parallel`). It is deliberately not a minimal build: a minimal build drops the
 * runtime graph optimiser and would need every model converted to ORT format.
 *
 * `config/friday-runtime.json` is written only after the build finished AND a smoke test ran a graph through the
 * installed wheel and got the right numbers. A failed build or smoke test leaves the record as it was.
 *
 * Variants (`--variant cpu|dml|cuda`, default cpu): `dml` adds `--use_dml` (the official DirectML wheel lags the CPU
 * line, so an own build is the real value). `cuda` is opt-in only and needs the CUDA toolkit and cuDNN installed:
 * `--cuda-home`, `--cudnn-home` and `--cuda-arch` (compute capability, for example 8.6) are all required. The own
 * wheels keep the import name `onnxruntime`, so each variant installs into its own venv folder
 * (`runtime/venv-friday-ort-<variant>`), never beside the official wheel. dml and cuda are built by the owner on his PC.
 *
 * Usage:
 *   node scripts/build-friday-runtime.cjs --work <empty-or-new-folder> [--tag v1.32.0] [--timebox-min 90] [--dry-run]
 *     [--variant dml] [--variant cuda --cuda-home <p> --cudnn-home <p> --cuda-arch 8.6]
 *
 * Exit code 0 = built, smoke test passed, record written (or --dry-run printed the plan).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const RECORD_FILE = path.join(root, "config", "friday-runtime.json");
const FIXTURE = path.join(root, "kernel", "tests", "fixtures", "tiny_relu.onnx");

const NAME = "friday-runtime";
const ENGINE = "onnxruntime";
const UPSTREAM = "https://github.com/microsoft/onnxruntime.git";
/** The release this build is pinned to. A different tag is accepted only as a plain `vX.Y.Z` release tag. */
const PINNED_TAG = "v1.32.0";
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DEFAULT_TIMEBOX_MIN = 90;

/** A release tag only: never a branch, `main`, `latest`, a commit id or a pre-release. */
function isPinnedTag(tag) {
  return typeof tag === "string" && RELEASE_TAG.test(tag);
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

const VARIANTS = ["cpu", "dml", "cuda"];
const CUDA_ARCH = /^(\d{2,3}|\d{1,2}\.\d)$/;

/** Opt-in notes and the venv folder (under `runtime/`) each variant keeps. */
function variantInfo(variant) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant: ${String(variant)}`);
  return {
    optIn: variant !== "cpu",
    note: variant === "cpu" ? "default full CPU provider" : "opt-in, owner builds on his PC",
    venv: variant === "cpu" ? null : `runtime/venv-friday-ort-${variant}`,
  };
}

/** `8.6` and `86` both mean compute capability 8.6; the CMake value is the digits without the dot. */
function cudaArch(value) {
  const text = String(value || "").trim();
  if (!CUDA_ARCH.test(text)) throw new Error(`bad --cuda-arch: ${text || "(empty)"}`);
  return text.replace(".", "");
}

/** The official build.py arguments. Pure: the same inputs always give the same list. */
function buildArgs({
  buildDir,
  platform = process.platform,
  asRoot = false,
  parallel = true,
  variant = "cpu",
  cudaHome = "",
  cudnnHome = "",
  cudaArchitecture = "",
} = {}) {
  if (!buildDir) throw new Error("buildDir is required");
  variantInfo(variant);
  if (variant === "cuda" && !(cudaHome && cudnnHome && cudaArchitecture))
    throw new Error("the cuda variant needs --cuda-home, --cudnn-home and --cuda-arch");
  const args = [
    path.join("tools", "ci_build", "build.py"),
    "--build_dir",
    buildDir,
    "--config",
    "Release",
  ];
  args.push("--build_wheel", "--skip_tests");
  if (parallel) args.push("--parallel");
  args.push("--compile_no_warning_as_error", "--skip_submodule_sync");
  if (variant === "dml") args.push("--use_dml");
  if (variant === "cuda")
    args.push(
      "--use_cuda",
      "--cuda_home",
      cudaHome,
      "--cudnn_home",
      cudnnHome,
      "--cmake_extra_defines",
      `CMAKE_CUDA_ARCHITECTURES=${cudaArch(cudaArchitecture)}`,
    );
  if (platform === "win32") args.push("--cmake_generator", "Visual Studio 17 2022");
  else if (asRoot) args.push("--allow_running_as_root");
  return args;
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/** Find the wheel the build produced: `<buildDir>/**\/dist/*.whl`. */
function findWheel(buildDir) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".whl") && path.basename(dir) === "dist") found.push(full);
    }
  };
  walk(buildDir, 0);
  return found.sort()[0] || null;
}

/** The record a successful build leaves. `previous` keeps the other platforms of the same tag and commit. */
function buildRecord({
  tag,
  commit,
  platform,
  wheelFile,
  wheelSha256,
  builtAt,
  previous = null,
  variant = "cpu",
}) {
  const info = variantInfo(variant);
  if (!isPinnedTag(tag)) throw new Error(`refusing an unpinned tag: ${String(tag)}`);
  if (!COMMIT.test(commit || "")) throw new Error("the commit must be a full 40-character id");
  if (!SHA256.test(wheelSha256 || ""))
    throw new Error("the wheel sha256 must be 64 hex characters");
  if (!wheelFile || !platform || !builtAt)
    throw new Error("wheelFile, platform and builtAt are required");
  const same = previous && previous.tag === tag && previous.commit === commit;
  const keep = same ? previous.wheels || {} : {};
  const entry = { file: path.basename(wheelFile), sha256: wheelSha256 };
  if (variant === "cpu") {
    const out = {
      name: NAME,
      engine: ENGINE,
      tag,
      commit,
      wheels: { ...keep, [platform]: entry },
      builtAt,
    };
    if (same && previous.variants) out.variants = previous.variants;
    return out;
  }
  const kept = same && previous.variants ? previous.variants : {};
  const had = (kept[variant] && kept[variant].wheels) || {};
  return {
    name: NAME,
    engine: ENGINE,
    tag,
    commit,
    wheels: keep,
    variants: {
      ...kept,
      [variant]: { ...info, wheels: { ...had, [platform]: entry } },
    },
    builtAt,
  };
}

/** Write the record. It refuses unless the smoke test passed, so a half-built engine is never recorded. */
function writeRecord(file, record, smokePassed) {
  if (smokePassed !== true)
    throw new Error("refusing to write the record: the smoke test did not pass");
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

function readRecord(file = RECORD_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Python that runs the fixture graph through the installed wheel and checks relu(x) element by element. */
const SMOKE_PY = [
  "import sys, numpy as np, onnxruntime as ort",
  "s = ort.InferenceSession(sys.argv[1], providers=['CPUExecutionProvider'])",
  "i = s.get_inputs()[0]",
  "shape = [d if isinstance(d, int) and d > 0 else 4 for d in i.shape]",
  "x = np.linspace(-2.0, 2.0, int(np.prod(shape)), dtype=np.float32).reshape(shape)",
  "y = s.run(None, {i.name: x})[0]",
  "ok = np.allclose(y, np.maximum(x, 0.0))",
  "print('FRIDAY_RUNTIME_SMOKE', ort.__version__, 'ok' if ok else 'wrong')",
  "sys.exit(0 if ok else 1)",
].join("\n");

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  return {
    status: result.status,
    timedOut: result.error && result.error.code === "ETIMEDOUT",
    signal: result.signal,
  };
}

function parseArgs(argv) {
  const out = { tag: PINNED_TAG, work: "", timeboxMin: DEFAULT_TIMEBOX_MIN, dryRun: false };
  // The variant keys appear only when their flag is given, so a plain command line parses as before.
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") out.tag = argv[++i] || "";
    else if (arg === "--work") out.work = argv[++i] || "";
    else if (arg === "--timebox-min") out.timeboxMin = Number(argv[++i]);
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--variant") out.variant = argv[++i] || "";
    else if (arg === "--cuda-home") out.cudaHome = argv[++i] || "";
    else if (arg === "--cudnn-home") out.cudnnHome = argv[++i] || "";
    else if (arg === "--cuda-arch") out.cudaArch = argv[++i] || "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!isPinnedTag(opts.tag)) throw new Error(`refusing an unpinned tag: ${opts.tag || "(empty)"}`);
  if (!opts.work)
    throw new Error("--work <folder> is required (a scratch folder outside the repository)");
  if (!(opts.timeboxMin > 0)) throw new Error("--timebox-min must be a positive number");
  const work = path.resolve(opts.work);
  if (work === root || work.startsWith(root + path.sep))
    throw new Error("--work must be outside the repository");
  const src = path.join(work, "onnxruntime");
  const buildDir = path.join(work, "build");
  const variant = opts.variant === undefined ? "cpu" : opts.variant;
  const info = variantInfo(variant);
  const venv = path.join(work, variant === "cpu" ? "venv" : `venv-friday-ort-${variant}`);
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const args = buildArgs({
    buildDir,
    asRoot,
    variant,
    cudaHome: opts.cudaHome || "",
    cudnnHome: opts.cudnnHome || "",
    cudaArchitecture: opts.cudaArch || "",
  });
  const python = process.platform === "win32" ? "python" : "python3";
  const plan = [
    `git clone --depth 1 --branch ${opts.tag} --recurse-submodules ${UPSTREAM} ${src}`,
    `${python} ${args.join(" ")}   (run inside the clone, time-box ${opts.timeboxMin} min)`,
    `${python} -m venv ${venv}; pip install the wheel; run ${path.relative(root, FIXTURE)} through it`,
    `write ${path.relative(root, RECORD_FILE)} only if the smoke test passes`,
  ];
  if (info.venv)
    plan.push(`variant ${variant}: ${info.note}; install the own wheel only into ${info.venv}`);
  console.log(`FRIDAY Runtime engine: ${ENGINE} ${opts.tag}, ${variant} variant, Python wheel`);
  for (const line of plan) console.log(`  ${line}`);
  if (opts.dryRun) return 0;

  fs.mkdirSync(work, { recursive: true });
  const clone = run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    opts.tag,
    "--recurse-submodules",
    UPSTREAM,
    src,
  ]);
  if (clone.status !== 0) throw new Error("clone failed: the source could not be fetched");
  const head = spawnSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" });
  const commit = (head.stdout || "").trim();
  if (!COMMIT.test(commit)) throw new Error("could not read the commit of the cloned tag");

  const started = Date.now();
  const build = run(python, args, { cwd: src, timeout: Math.round(opts.timeboxMin * 60 * 1000) });
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  if (build.timedOut)
    throw new Error(`build stopped at the ${opts.timeboxMin} minute time-box (${minutes} min)`);
  if (build.status !== 0)
    throw new Error(`build failed after ${minutes} min (exit ${build.status})`);
  const wheel = findWheel(buildDir);
  if (!wheel) throw new Error("the build ended without a wheel");
  const wheelSha256 = sha256File(wheel);

  const venvPython = path.join(venv, process.platform === "win32" ? "Scripts" : "bin", "python");
  if (run(python, ["-m", "venv", venv]).status !== 0)
    throw new Error("could not create the smoke-test venv");
  if (run(venvPython, ["-m", "pip", "install", "--quiet", "numpy", wheel]).status !== 0) {
    throw new Error("the wheel did not install");
  }
  const smoke = run(venvPython, ["-I", "-c", SMOKE_PY, FIXTURE]);
  if (smoke.status !== 0)
    throw new Error("smoke test failed: the own wheel did not run the fixture graph correctly");

  const record = buildRecord({
    tag: opts.tag,
    commit,
    platform: platformKey(),
    wheelFile: wheel,
    wheelSha256,
    builtAt: new Date().toISOString(),
    previous: readRecord(),
    variant,
  });
  writeRecord(RECORD_FILE, record, true);
  console.log(
    `FRIDAY Runtime engine built in ${minutes} min: ${path.basename(wheel)} sha256 ${wheelSha256}`,
  );
  console.log(`Record written: ${path.relative(root, RECORD_FILE)}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`FRIDAY Runtime engine: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  NAME,
  ENGINE,
  UPSTREAM,
  PINNED_TAG,
  SMOKE_PY,
  isPinnedTag,
  platformKey,
  buildArgs,
  findWheel,
  VARIANTS,
  variantInfo,
  buildRecord,
  writeRecord,
  readRecord,
  parseArgs,
};
