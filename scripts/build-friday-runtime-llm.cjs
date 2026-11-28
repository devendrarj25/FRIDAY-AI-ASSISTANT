/**
 * FRIDAY Runtime LLM engine: an optional own build of the llama.cpp server, made from its official source.
 *
 * This is NOT part of the Windows CMD chain. `npm run setup`, `npm run doctor` and `npm run build:win` never call it,
 * and nothing in the app needs it: FRIDAY runs on the pinned official engine unless a verified own build is installed.
 * The owner runs it by hand on Windows (Visual Studio 2022 with the C++ workload, CMake 3.28 or newer, Git, PowerShell).
 * The upstream source is cloned at the same release tag the official engine is pinned to and never edited.
 *
 * Two variants. `friday-native` is tuned to the build PC (`GGML_NATIVE=ON`, one static executable). `friday-portable`
 * loads the CPU backend as a plug-in and ships every CPU variant, so one zip runs on any x64 PC (a release asset).
 * The server is copied to `friday-runtime-llm.exe` with its DLLs, and every file is hashed.
 *
 * `config/friday-runtime-llm.json` is written only after the build finished AND a smoke test started the engine on
 * loopback, saw `/health` answer ok and got a 16-token greedy completion from the fixture model the owner passes with
 * `--fixture`. A failed build or smoke test leaves the record as it was. A record with no hash never installs.
 *
 * Usage:
 *   node scripts/build-friday-runtime-llm.cjs --work <empty-or-new-folder> --fixture <tiny.gguf>
 *        [--tag b12619] [--variant friday-native|friday-portable] [--toolchain vs2022|ninja]
 *        [--timebox-min 120] [--dry-run]
 *
 * Exit code 0 = built, smoke test passed, record written (or --dry-run printed the plan).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const RECORD_FILE = path.join(root, "config", "friday-runtime-llm.json");

const NAME = "friday-runtime-llm";
const ENGINE = "llama.cpp";
const UPSTREAM = "https://github.com/ggml-org/llama.cpp.git";
const TARGET = "llama-server";
const OWN_EXE = `${NAME}.exe`;
/** The release this build is pinned to: the same tag as the official engine in config/local-runners.json. */
const PINNED_TAG = "b12619";
const RELEASE_TAG = /^b\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DEFAULT_TIMEBOX_MIN = 120;
const SMOKE_TOKENS = 16;
const SMOKE_WAIT_MS = 120000;

/** CPU backend switches per variant. Everything else is shared. */
const VARIANTS = {
  "friday-native": [
    "-DGGML_NATIVE=ON",
    "-DGGML_BACKEND_DL=OFF",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DGGML_OPENMP=ON",
  ],
  "friday-portable": [
    "-DGGML_NATIVE=OFF",
    "-DGGML_BACKEND_DL=ON",
    "-DGGML_CPU_ALL_VARIANTS=ON",
    "-DBUILD_SHARED_LIBS=ON",
    "-DGGML_OPENMP=ON",
  ],
};
const SHARED_FLAGS = [
  "-DLLAMA_BUILD_TESTS=OFF",
  "-DLLAMA_BUILD_EXAMPLES=OFF",
  "-DLLAMA_BUILD_TOOLS=ON",
  "-DLLAMA_BUILD_SERVER=ON",
  "-DLLAMA_OPENSSL=OFF",
];
const TOOLCHAINS = {
  vs2022: { generator: "Visual Studio 17 2022", extra: ["-A", "x64"], multiConfig: true },
  ninja: { generator: "Ninja", extra: [], multiConfig: false },
};
const DEFAULT_TOOLCHAIN = "vs2022";

/** A release tag only: never a branch, `master`, `latest`, a commit id or a pre-release. */
function isPinnedTag(tag) {
  return typeof tag === "string" && RELEASE_TAG.test(tag);
}

/** The zip a build of this tag and variant is published as. */
function assetName(tag, variant) {
  if (!isPinnedTag(tag)) throw new Error(`refusing an unpinned tag: ${String(tag)}`);
  if (!Object.hasOwn(VARIANTS, variant)) throw new Error(`unknown variant: ${String(variant)}`);
  return `${NAME}-${tag}-${variant}-win-x64.zip`;
}

/** CMake configure and build arguments. Pure: the same inputs always give the same lists. */
function buildArgs({
  variant = "friday-native",
  tag = PINNED_TAG,
  toolchain = DEFAULT_TOOLCHAIN,
  srcDir = ".",
  buildDir = "build",
} = {}) {
  if (!isPinnedTag(tag)) throw new Error(`refusing an unpinned tag: ${String(tag)}`);
  if (!Object.hasOwn(VARIANTS, variant)) throw new Error(`unknown variant: ${String(variant)}`);
  if (!Object.hasOwn(TOOLCHAINS, toolchain))
    throw new Error(`unknown toolchain: ${String(toolchain)}`);
  const chain = TOOLCHAINS[toolchain];
  const configure = ["-S", srcDir, "-B", buildDir, "-G", chain.generator, ...chain.extra];
  if (!chain.multiConfig) configure.push("-DCMAKE_BUILD_TYPE=Release");
  configure.push(...VARIANTS[variant], ...SHARED_FLAGS);
  const build = ["--build", buildDir, "--config", "Release", "--target", TARGET, "--parallel"];
  return { configure, build };
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/** Where the server and its DLLs land: `<buildDir>/bin/Release` (Visual Studio) or `<buildDir>/bin` (Ninja). */
function findBinDir(buildDir) {
  for (const dir of [path.join(buildDir, "bin", "Release"), path.join(buildDir, "bin")]) {
    if (fs.existsSync(path.join(dir, `${TARGET}.exe`))) return dir;
  }
  return null;
}

/** Which files of the build folder ship, and under which name. The server is renamed, the DLLs keep their names. */
function planCopies(entries) {
  const names = [...entries].sort();
  if (!names.includes(`${TARGET}.exe`)) throw new Error(`the build has no ${TARGET}.exe`);
  const plan = [{ from: `${TARGET}.exe`, to: OWN_EXE }];
  for (const name of names) {
    if (name.toLowerCase().endsWith(".dll")) plan.push({ from: name, to: name });
  }
  return plan;
}

/** The record a successful build leaves. `files` is sorted by name so two builds list the same way. */
function buildRecord({ tag, commit, variant, toolchain, files, assetSha256, builtAt }) {
  const asset = assetName(tag, variant);
  if (!COMMIT.test(commit || "")) throw new Error("the commit must be a full 40-character id");
  if (!Object.hasOwn(TOOLCHAINS, toolchain))
    throw new Error(`unknown toolchain: ${String(toolchain)}`);
  if (!SHA256.test(assetSha256 || ""))
    throw new Error("the asset sha256 must be 64 hex characters");
  if (!Array.isArray(files) || !files.some((f) => f && f.name === OWN_EXE))
    throw new Error(`files must list ${OWN_EXE}`);
  for (const f of files)
    if (!f || !f.name || !SHA256.test(f.sha256 || ""))
      throw new Error("every file needs a name and a 64 hex character sha256");
  if (!builtAt) throw new Error("builtAt is required");
  return {
    name: NAME,
    engine: ENGINE,
    tag,
    commit,
    variant,
    toolchain,
    files: files
      .map((f) => ({ name: path.basename(f.name), sha256: f.sha256 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    assetName: asset,
    sha256: assetSha256,
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

/** The own build is Windows only; every other machine can print the plan with --dry-run. */
function assertBuildable(platform = process.platform) {
  if (platform !== "win32")
    throw new Error("the build runs on Windows only; use --dry-run to print the plan here");
}

/** Decide the smoke test from the two answers. Pure: no process, no network. */
function smokeVerdict(health, completion, expectedTokens = SMOKE_TOKENS) {
  if (!health || health.status !== 200 || !health.body || health.body.status !== "ok")
    return { ok: false, reason: "/health did not answer ok" };
  if (!completion || completion.status !== 200 || !completion.body)
    return { ok: false, reason: "the completion request failed" };
  const { content, tokens_predicted: tokens } = completion.body;
  if (tokens !== expectedTokens)
    return { ok: false, reason: `expected ${expectedTokens} tokens, got ${String(tokens)}` };
  if (typeof content !== "string" || content.length === 0)
    return { ok: false, reason: "the completion text was empty" };
  return { ok: true, reason: "" };
}

/** The server command line for the smoke test: loopback only, one small context, one slot. */
function smokeServerArgs(fixture, port) {
  return [
    "--model",
    fixture,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "-c",
    "512",
    "-np",
    "1",
    "-t",
    "2",
  ];
}

/** The greedy completion body: the same text and the same 16 tokens every time. */
function smokeCompletionBody(tokens = SMOKE_TOKENS) {
  return {
    prompt: "The capital of France is",
    n_predict: tokens,
    temperature: 0,
    top_k: 1,
    seed: 1,
    ignore_eos: true,
    cache_prompt: false,
  };
}

function request(port, method, urlPath, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        timeout: timeoutMs,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0, body: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start the own engine on loopback, wait for /health, run the greedy completion, and always stop the process. */
async function runSmoke(exe, fixture, { waitMs = SMOKE_WAIT_MS, leadArgs = [] } = {}) {
  const port = await freePort();
  const child = spawn(exe, [...leadArgs, ...smokeServerArgs(fixture, port)], {
    cwd: path.dirname(exe),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  const keep = (chunk) => {
    tail = (tail + chunk.toString("utf8")).slice(-2000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", () => {
    exited = true;
  });
  try {
    const deadline = Date.now() + waitMs;
    let health = { status: 0, body: null };
    while (Date.now() < deadline && !exited) {
      health = await request(port, "GET", "/health", undefined, 2000);
      if (health.status === 200) break;
      await sleep(1000);
    }
    if (health.status !== 200) return { ok: false, reason: "/health did not answer ok", tail };
    const completion = await request(port, "POST", "/completion", smokeCompletionBody(), waitMs);
    return { ...smokeVerdict(health, completion), tail };
  } finally {
    if (!exited) child.kill();
  }
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  return {
    status: result.status,
    timedOut: result.error && result.error.code === "ETIMEDOUT",
    signal: result.signal,
  };
}

function parseArgs(argv) {
  const out = {
    tag: PINNED_TAG,
    variant: "friday-native",
    toolchain: DEFAULT_TOOLCHAIN,
    work: "",
    fixture: "",
    timeboxMin: DEFAULT_TIMEBOX_MIN,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") out.tag = argv[++i] || "";
    else if (arg === "--variant") out.variant = argv[++i] || "";
    else if (arg === "--toolchain") out.toolchain = argv[++i] || "";
    else if (arg === "--work") out.work = argv[++i] || "";
    else if (arg === "--fixture") out.fixture = argv[++i] || "";
    else if (arg === "--timebox-min") out.timeboxMin = Number(argv[++i]);
    else if (arg === "--dry-run") out.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const quote = (s) => (/\s/.test(s) ? JSON.stringify(s) : s);

async function main(argv) {
  const opts = parseArgs(argv);
  if (!isPinnedTag(opts.tag)) throw new Error(`refusing an unpinned tag: ${opts.tag || "(empty)"}`);
  if (!opts.work)
    throw new Error("--work <folder> is required (a scratch folder outside the repository)");
  if (!(opts.timeboxMin > 0)) throw new Error("--timebox-min must be a positive number");
  const work = path.resolve(opts.work);
  if (work === root || work.startsWith(root + path.sep))
    throw new Error("--work must be outside the repository");
  const src = path.join(work, "llama.cpp");
  const buildDir = path.join(work, "build");
  const outDir = path.join(work, "out", NAME);
  const distDir = path.join(work, "dist");
  const args = buildArgs({
    variant: opts.variant,
    tag: opts.tag,
    toolchain: opts.toolchain,
    srcDir: src,
    buildDir,
  });
  const asset = assetName(opts.tag, opts.variant);
  const plan = [
    `git clone --depth 1 --branch ${opts.tag} ${UPSTREAM} ${quote(src)}`,
    `cmake ${args.configure.map(quote).join(" ")}`,
    `cmake ${args.build.map(quote).join(" ")}   (time-box ${opts.timeboxMin} min for clone and build)`,
    `copy ${TARGET}.exe as ${OWN_EXE} with its DLLs into ${quote(outDir)}; hash every file`,
    `start ${OWN_EXE} on 127.0.0.1 with --fixture, wait for /health, run a ${SMOKE_TOKENS}-token greedy completion`,
    `zip ${asset} into ${quote(distDir)}`,
    `write ${path.relative(root, RECORD_FILE)} only if the smoke test passes`,
  ];
  console.log(
    `FRIDAY Runtime LLM engine: ${ENGINE} ${opts.tag}, ${opts.variant}, ${opts.toolchain}`,
  );
  for (const line of plan) console.log(`  ${line}`);
  if (opts.dryRun) return 0;

  assertBuildable();
  if (!opts.fixture || !fs.existsSync(opts.fixture))
    throw new Error("--fixture <tiny.gguf> is required and must exist (the smoke test model)");
  const fixture = path.resolve(opts.fixture);

  fs.mkdirSync(work, { recursive: true });
  const started = Date.now();
  const budgetMs = () =>
    Math.max(1000, Math.round(opts.timeboxMin * 60 * 1000) - (Date.now() - started));
  const stopped = (step) => new Error(`${step} stopped at the ${opts.timeboxMin} minute time-box`);

  const clone = run("git", ["clone", "--depth", "1", "--branch", opts.tag, UPSTREAM, src], {
    timeout: budgetMs(),
  });
  if (clone.timedOut) throw stopped("clone");
  if (clone.status !== 0) throw new Error("clone failed: the source could not be fetched");
  const head = spawnSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" });
  const commit = (head.stdout || "").trim();
  if (!COMMIT.test(commit)) throw new Error("could not read the commit of the cloned tag");

  const configure = run("cmake", args.configure, { timeout: budgetMs() });
  if (configure.timedOut) throw stopped("configure");
  if (configure.status !== 0) throw new Error(`configure failed (exit ${configure.status})`);
  const build = run("cmake", args.build, { timeout: budgetMs() });
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  if (build.timedOut) throw stopped("build");
  if (build.status !== 0)
    throw new Error(`build failed after ${minutes} min (exit ${build.status})`);

  const binDir = findBinDir(buildDir);
  if (!binDir) throw new Error(`the build ended without ${TARGET}.exe`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const { from, to } of planCopies(fs.readdirSync(binDir))) {
    fs.copyFileSync(path.join(binDir, from), path.join(outDir, to));
    files.push({ name: to, sha256: sha256File(path.join(outDir, to)) });
  }

  const smoke = await runSmoke(path.join(outDir, OWN_EXE), fixture);
  if (!smoke.ok) {
    if (smoke.tail) console.error(smoke.tail);
    throw new Error(`smoke test failed: ${smoke.reason}`);
  }

  fs.mkdirSync(distDir, { recursive: true });
  const zip = path.join(distDir, asset);
  fs.rmSync(zip, { force: true });
  const pack = run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $args[0]).FullName -DestinationPath $args[1] -CompressionLevel Optimal",
    outDir,
    zip,
  ]);
  if (pack.status !== 0 || !fs.existsSync(zip)) throw new Error("could not zip the engine");

  const record = buildRecord({
    tag: opts.tag,
    commit,
    variant: opts.variant,
    toolchain: opts.toolchain,
    files,
    assetSha256: sha256File(zip),
    builtAt: new Date().toISOString(),
  });
  writeRecord(RECORD_FILE, record, true);
  console.log(
    `FRIDAY Runtime LLM engine built in ${minutes} min: ${asset} sha256 ${record.sha256}`,
  );
  console.log(
    `Upload ${zip} as the release asset; record written: ${path.relative(root, RECORD_FILE)}`,
  );
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`FRIDAY Runtime LLM engine: ${error.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  NAME,
  ENGINE,
  UPSTREAM,
  TARGET,
  OWN_EXE,
  PINNED_TAG,
  VARIANTS,
  TOOLCHAINS,
  isPinnedTag,
  assetName,
  buildArgs,
  planCopies,
  buildRecord,
  writeRecord,
  readRecord,
  assertBuildable,
  smokeVerdict,
  runSmoke,
  smokeServerArgs,
  smokeCompletionBody,
  parseArgs,
};
