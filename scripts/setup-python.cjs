/**
 * FRIDAY — Python kernel dependency installer (cross-platform wrapper).
 *
 * `npm run setup:python` runs this. It finds a supported Python runtime,
 * creates/reuses the live venv (selected FRIDAY folder runtime/.venv when a
 * folder is selected, otherwise <project>/.venv), installs
 * kernel/requirements.txt there — including the voice floors the app already
 * uses — then kernel/requirements-capabilities.txt (memory, devices, OCR,
 * Windows control extras the kernel already imports when present).
 *
 * Usage: node scripts/setup-python.cjs
 */
const { spawnSync } = require("node:child_process");
// Colour that means something (ok green, FAIL red, a note yellow) on a real console; plain text everywhere else.
if (require.main === module) require("./live-console.cjs").installColorConsole();
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const paths = require("../electron/friday-paths.cjs");
const restored = paths.restoreCheckoutCollisions(root);
if (restored.length) {
  for (const row of restored) {
    console.log(
      `[friday] restored source folder ${row.from}/ -> ${row.to}/ (checkout must not be a data alias)`,
    );
  }
}
const kernelDir = paths.resolveKernelSource(root) || path.join(root, "kernel");
const req = path.join(kernelDir, "requirements.txt");
const win = process.platform === "win32";
const versions = JSON.parse(
  fs.readFileSync(path.join(root, "config", "toolchain-versions.json"), "utf8"),
);
const parts = (v) =>
  String(v || "")
    .split(".")
    .map((part) => Number(part) || 0);
const compare = (left, right) => {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
};
const supportedPython = (version) => compare(version, versions.pythonMinimum) >= 0;

const log = (m) => console.log(`[friday] ${m}`);
/**
 * On a Windows PC that builds FRIDAY, everything this script is meant to install
 * must arrive: a missing capability package or an uncached speech model stops
 * the setup. Hosted CI, an offline build and FRIDAY_PREFETCH_STRICT=0 only report.
 */
const mustComplete =
  process.platform === "win32" &&
  !process.env.CI &&
  !process.env.GITHUB_ACTIONS &&
  process.env.FRIDAY_OFFLINE !== "1" &&
  String(process.env.FRIDAY_PREFETCH_STRICT ?? "1").trim() !== "0";
const incomplete = [];
// Newest official release of every package setup installs, asked at most once a day (scripts/update-policy.cjs).
// A package that is not requested keeps the version it has (only-if-needed); a newest release that cannot be
// installed falls through to the methods below, so the installed, supported one stays and nothing fails.
const updatePolicy = require("./update-policy.cjs");
const upgradeDue = updatePolicy.due("python-packages");
let upgradeTried = false;
{
  // A FRIDAY_PYTHON left over from an older install must not win over the Python this setup creates.
  const stale = require("./explicit-python.cjs").dropStalePython(process.env);
  if (stale) {
    console.log(
      `[friday] NOTE FRIDAY_PYTHON points at ${stale}, which does not exist; ignoring it and using the Python this setup prepares. Remove that variable (Windows: Settings, System, About, Advanced system settings, Environment Variables) so it stops appearing.`,
    );
  }
}
// pip prints a "Requirement already satisfied" line per package and redraws a progress bar per wheel,
// which floods (and, redrawn, flickers) a console; quiet pip prints the errors and one summary line.
// PIP_NO_INPUT keeps it from ever waiting on a prompt. A caller's own PIP_* choice wins.
const quietPip = { PIP_QUIET: "1", PIP_PROGRESS_BAR: "off", PIP_NO_INPUT: "1" };
const rawRun = (exe, args, opts = {}) =>
  spawnSync(exe, args, {
    stdio: "inherit",
    shell: false,
    cwd: root,
    ...opts,
    env: { ...quietPip, ...process.env, ...(opts.env || {}) },
  });
// pip draws no bar when its output is piped and it is run quiet, so a package install that takes minutes (the
// 1 GB CUDA libraries, the capability packages) looked like a hung window. A "still working" line with the time,
// the size so far and the speed prints beside it (scripts/with-activity.cjs); the pip command itself is unchanged.
const isPipInstall = (args) => args.includes("pip") && args.includes("install");
const run = (exe, args, opts = {}) =>
  isPipInstall(args)
    ? require("./with-activity.cjs").withActivityCommand(
        "pip",
        require("./with-activity.cjs").pipWatchDirs(exe),
        exe,
        args,
        { cwd: opts.cwd || root, env: { ...quietPip, ...process.env, ...(opts.env || {}) } },
        { combine: "max" },
      )
    : rawRun(exe, args, opts);
const capture = (exe, args, opts = {}) =>
  spawnSync(exe, args, {
    encoding: "utf8",
    cwd: root,
    shell: false,
    timeout: 120000,
    ...opts,
  });

if (!fs.existsSync(req)) {
  console.error(`[friday] kernel/requirements.txt not found in ${root}`);
  console.error(
    "[friday] looked at kernel/, resources/kernel/, App/resources/kernel/, and backend/ when it is the Python tree.",
  );
  console.error(
    "[friday] npm run build:win must run from the Git clone. Do not use only the installed FRIDAY data folder.",
  );
  process.exit(1);
}

const runtime = require("./python-runtime.cjs");

/** Discovery + official installation live in the shared runtime policy module. */
function findPython() {
  const found = runtime.ensurePython({ install: true });
  return found ? found.executable : null;
}

let python = findPython();
if (!python) {
  console.error(`[friday] supported Python >=${versions.pythonMinimum} was not found.`);
  console.error(
    "[friday] Install the latest stable Python from https://www.python.org/downloads/windows/",
  );
  console.error("[friday]   tick 'Add python.exe to PATH', then open a NEW terminal.");
  console.error("[friday] Or run: npm run setup");
  console.error("[friday] If 'python' opens the Microsoft Store, disable the alias in");
  console.error("[friday]   Settings > Apps > Advanced app settings > App execution aliases.");
  process.exit(1);
}
log(`using Python: ${python}`);
const pyVersion = capture(python, ["-c", "import sys; print(sys.version.split()[0])"]);
if (pyVersion.status === 0) {
  log(
    `resolved Python ${String(pyVersion.stdout || "").trim()} (floor >=${versions.pythonMinimum}; a newer series is reused once its kernel wheels are published)`,
  );
}

const venvPython = runtime.targetVenvPython();
const venv = path.dirname(path.dirname(venvPython));
if (!fs.existsSync(venvPython)) {
  log(`creating isolated virtual environment ${venv} ...`);
  if (!runtime.ensureVenv(python)) {
    console.error("[friday] virtual environment creation failed.");
    process.exit(1);
  }
}
python = venvPython;
log(`isolated runtime: ${venv}`);

// ---- pip bootstrap: official methods, tried in order, verified after each.
function pipReady() {
  return capture(python, ["-m", "pip", "--version"]).status === 0;
}
function downloadGetPip(url) {
  const target = path.join(root, "temporary", "downloads");
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, "get-pip.py");
  const download = run(python, [
    "-c",
    "import sys,urllib.request;urllib.request.urlretrieve(sys.argv[1],sys.argv[2])",
    url,
    file,
  ]);
  if (download.status !== 0) return download;
  return run(python, [file]);
}

if (!pipReady()) {
  const bootstrap = [
    {
      label: "ensurepip (bundled with CPython)",
      exec: () => run(python, ["-m", "ensurepip", "--upgrade"]),
    },
    {
      label: "pinned get-pip.py (pypa/get-pip commit, pip 26.2.2)",
      exec: () =>
        downloadGetPip(
          "https://raw.githubusercontent.com/pypa/get-pip/fa4e90301bf000c36309f3ad79c3ac720b55d6df/public/get-pip.py",
        ),
    },
    {
      label: "official get-pip.py from bootstrap.pypa.io",
      exec: () => downloadGetPip("https://bootstrap.pypa.io/get-pip.py"),
    },
    {
      label: "official get-pip.py from GitHub pypa/get-pip",
      exec: () =>
        downloadGetPip("https://raw.githubusercontent.com/pypa/get-pip/main/public/get-pip.py"),
    },
  ];
  let bootstrapped = false;
  for (const method of bootstrap) {
    log(`pip missing - trying ${method.label} ...`);
    const result = method.exec();
    if (result.status === 0 && pipReady()) {
      bootstrapped = true;
      break;
    }
    console.error(`[friday] method failed: ${method.label} (exit code ${result.status})`);
  }
  if (!bootstrapped) {
    console.error("[friday] every official pip bootstrap method failed.");
    console.error(
      "[friday] Reinstall Python from https://www.python.org/downloads/windows/ with pip enabled.",
    );
    process.exit(1);
  }
}

log("pip is available in the isolated environment.");
if (upgradeDue) {
  // pip itself, through `python -m pip` (the way Windows allows it). A failure keeps the pip that works.
  log("checking pip for a newer release ...");
  const bumped = run(python, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--upgrade",
    "pip",
  ]);
  if (bumped.status !== 0) log("pip was not updated; the installed pip stays");
}

// ---- Requirement installation: multiple official PyPI mechanisms.
// Wheels first so a normal FRIDAY installation never needs Rust/Cargo.
// Already-installed newer compatible packages are reused, never downgraded.
log(`installing kernel requirements from ${req}`);
/**
 * The ONNX Runtime wheels the venv holds right now (`pip list`). A GPU or DirectML build the Install Manager put there
 * is kept: the plain `onnxruntime` requirement of the capability list would install the CPU wheel over its files.
 */
function installedOnnxRuntimes() {
  const listed = capture(python, [
    "-m",
    "pip",
    "list",
    "--format=json",
    "--disable-pip-version-check",
  ]);
  try {
    return runtime.onnxRuntimesIn(JSON.parse(String(listed.stdout || "[]")));
  } catch {
    return runtime.onnxRuntimesIn([]);
  }
}
const onnxBefore = installedOnnxRuntimes();
if (onnxBefore.gpu.length) {
  log(
    `ONNX Runtime ${onnxBefore.gpu.map((row) => `${row.name} ${row.version}`).join(", ")} is installed; the plain CPU wheel is not installed over it`,
  );
}
const base = [
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "--upgrade-strategy",
  "only-if-needed",
];
const pipMethods = (extra) => [
  {
    label: "PyPI wheels only (no source builds, no Rust toolchain)",
    args: [...base, "--only-binary=:all:", ...extra],
  },
  { label: "PyPI wheels preferred", args: [...base, "--prefer-binary", ...extra] },
  {
    label: "PyPI with a fresh download cache",
    args: [...base, "--prefer-binary", "--no-cache-dir", ...extra],
  },
  {
    label: "explicit official PyPI index",
    args: [...base, "--prefer-binary", "--index-url", "https://pypi.org/simple", ...extra],
  },
  {
    label: "PyPI with extra retries and a longer timeout",
    args: [
      ...base,
      "--prefer-binary",
      "--retries",
      "10",
      "--timeout",
      "120",
      "--index-url",
      "https://pypi.org/simple",
      ...extra,
    ],
  },
];

// A newest-release install that breaks the kernel must not be the state the owner is left in: the
// package list is saved once before the first upgrade, and restored when the kernel no longer loads.
const upgradeSnapshot = path.join(root, "temporary", "downloads", "pip-before-upgrade.txt");
let snapshotTaken = false;
function takeUpgradeSnapshot() {
  if (snapshotTaken) return;
  snapshotTaken = true;
  const frozen = capture(python, ["-m", "pip", "freeze", "--disable-pip-version-check"]);
  if (frozen.status !== 0 || !String(frozen.stdout || "").trim()) return;
  fs.mkdirSync(path.dirname(upgradeSnapshot), { recursive: true });
  fs.writeFileSync(upgradeSnapshot, String(frozen.stdout));
}
const kernelLoads = () =>
  capture(python, [
    "-c",
    "import fastapi, uvicorn, httpx, pydantic, yaml, numpy; print('kernel loads')",
  ]).status === 0;
/** Put the packages back as they were before the newest-release install, when that install broke the kernel. */
function rollbackUpgrade() {
  if (!upgradeTried || !fs.existsSync(upgradeSnapshot)) return false;
  console.error(
    "[friday] the newest package releases broke the kernel imports - restoring the packages saved before the upgrade",
  );
  const back = run(python, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-deps",
    "-r",
    upgradeSnapshot,
  ]);
  upgradeTried = false; // not recorded as checked: the next run asks again
  return back.status === 0 && kernelLoads();
}

function installWithMethods(extra, options = {}) {
  const methods = options.preferBinaryFirst
    ? pipMethods(extra).filter((method) => !method.args.includes("--only-binary=:all:"))
    : pipMethods(extra);
  if (upgradeDue && !options.noUpgrade) {
    methods.unshift({
      label: "newest releases from PyPI (checked once a day)",
      args: [
        ...base.slice(0, 4),
        "--upgrade",
        ...base.slice(4),
        options.preferBinaryFirst ? "--prefer-binary" : "--only-binary=:all:",
        ...extra,
      ],
    });
    takeUpgradeSnapshot();
    upgradeTried = true;
  }
  for (const method of methods) {
    log(`method: ${method.label}`);
    const result = run(python, method.args);
    if (result.status === 0) return true;
    console.error(`[friday] method failed: ${method.label} (pip exit code ${result.status})`);
  }
  return false;
}

// A requirement line may end with `# import: <module>` when the module a package is imported as differs from its
// name, so a new package is added in the requirements file alone. The comment is never handed to pip.
function parsePins(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((raw) => {
      const hint = raw.match(/\s#\s*import:\s*([A-Za-z_][\w.]*)\s*$/);
      const line = raw.replace(/\s+#.*$/, "").trim();
      const match = line.match(/^([A-Za-z0-9._-]+)(\[[^\]]+\])?(>=|==)([^\s;]+)/);
      const pin = match
        ? { name: match[1], spec: line }
        : { name: line.split(/[[>=<]/)[0], spec: line };
      return hint ? { ...pin, importName: hint[1] } : pin;
    });
}

const voiceNames = new Set(runtime.VOICE_PACKAGES);

let installed = installWithMethods(["-r", req]);
if (!installed) {
  const pins = parsePins(req);
  const startup = pins.filter((pin) => !voiceNames.has(pin.name));
  const voicePins = pins.filter((pin) => voiceNames.has(pin.name));
  const startupFile = path.join(root, "temporary", "downloads", "kernel-startup-requirements.txt");
  fs.mkdirSync(path.dirname(startupFile), { recursive: true });
  fs.writeFileSync(startupFile, `${startup.map((pin) => pin.spec).join("\n")}\n`);
  log("full kernel/requirements.txt install did not finish — retrying startup packages only");
  installed = installWithMethods(["-r", startupFile]);
  if (installed && voicePins.length) {
    log("installing voice runtime packages (faster-whisper, edge-tts)");
    if (!installWithMethods(voicePins.map((pin) => pin.spec))) {
      if (win) {
        console.error("[friday] voice runtime packages failed to install.");
        process.exit(1);
      }
      log(
        "note: voice packages were not installed — kernel still boots; Install Manager can add them.",
      );
    }
  }
}
if (!installed) {
  console.error("[friday] every official PyPI installation method failed.");
  console.error("[friday] Behind a proxy / TLS inspection, set HTTPS_PROXY and retry, or run:");
  console.error(`[friday]   "${python}" -m pip install --prefer-binary -r "${req}"`);
  console.error(
    `[friday] FRIDAY requires Python >=${versions.pythonMinimum} (newer versions are supported).`,
  );
  console.error("[friday] Remove the isolated .venv and run npm run setup:python to recreate it.");
  process.exit(1);
}

log("verifying imports ...");
if (
  run(python, [
    "-c",
    "import fastapi, uvicorn, httpx, pydantic, yaml; print('core kernel packages ok')",
  ]).status !== 0
) {
  if (!(rollbackUpgrade() && kernelLoads())) {
    console.error("[friday] core kernel packages are still not importable.");
    process.exit(1);
  }
}
// The FRIDAY database needs a working sqlite3 module, verified by a real query.
if (
  run(python, [
    "-c",
    "import sqlite3;c=sqlite3.connect(':memory:');c.execute('create table t(a)');c.execute('insert into t values(1)');assert c.execute('select a from t').fetchone()[0]==1;c.close();print('sqlite3 ok', sqlite3.sqlite_version)",
  ]).status !== 0
) {
  console.error("[friday] this Python build cannot use SQLite - reinstall Python from python.org.");
  process.exit(1);
}

/**
 * Speech, turn-taking and the small chat model. This runs AFTER every Python package is installed, so a
 * model that cannot be fetched (a blocked host, a slow line) is reported at the end with the rest and
 * can never leave the capability packages uninstalled, which is how one failed model once stopped
 * Doctor and the build from repairing anything.
 */
function fetchModelsAndProbe() {
  if (win) {
    const fridayRoot = require("./friday-root.cjs");
    const picked = fridayRoot.workspaceRootOrDev();
    if (picked.fromCheckout) {
      log(
        `FRIDAY folder: ${picked.root} (the folder this setup runs in). Models, runtimes and tools are installed and detected there, and the installer offers it as the install folder. To use another folder, set FRIDAY_WORKSPACE_ROOT before setup.`,
      );
    }
    if (picked.development) {
      require("../electron/staged-assets.cjs").recordStaging(picked.root);
      log(
        `NOTE no FRIDAY folder is selected, so speech, voice and chat models are staged in ${picked.root}. The installed FRIDAY moves them into the folder you choose on first launch, so nothing is downloaded twice. To download straight into your real FRIDAY folder instead, set FRIDAY_WORKSPACE_ROOT=<that folder> before npm run setup and build:win (details: INSTALL.md section 8).`,
      );
    }
    const stt = path.join(kernelDir, "stt.py");
    // Speech, turn-taking and a small chat model land in the FRIDAY folder
    // through the app's own verified downloader. A model that does not arrive
    // fails the setup at the end (FRIDAY is not ready without its voice and chat
    // model), after every package above is already in place.
    const fetched = run(process.execPath, [path.join(__dirname, "prefetch-models.cjs")], {
      env: {
        ...process.env,
        FRIDAY_ROOT: picked.root,
        FRIDAY_PYTHON:
          require("./explicit-python.cjs").explicitPython(process.env.FRIDAY_PYTHON) || python,
      },
      timeout: 4 * 3600 * 1000,
    });
    if (fetched.status !== 0) {
      console.error("[friday] the speech, voice and chat models are not complete (see above).");
      console.error(
        "[friday] Fix the network, then run: npm run setup:python  (or npm run doctor)",
      );
      incomplete.push("the speech, voice and chat models are not complete");
    }
    const sttDir = ["small", "base"]
      .map((size) => path.join(picked.root, "cache", "stt", size))
      .find((dir) => fs.existsSync(path.join(dir, "model.bin")));
    log(
      `probing faster-whisper model in ${sttDir || path.join(picked.root, "cache", "stt")} (offline miss does not fail the build)`,
    );
    const probe = capture(python, [stt, "--load-probe"], {
      env: {
        ...process.env,
        FRIDAY_ROOT: picked.root,
        ...(sttDir ? { FRIDAY_STT_MODEL_PATH: sttDir } : {}),
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      },
      timeout: 600000,
    });
    const probeText = `${probe.stdout || ""}\n${probe.stderr || ""}`;
    const jsonLine =
      probeText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .pop() || "";
    let payload = null;
    try {
      payload = jsonLine ? JSON.parse(jsonLine) : null;
    } catch {
      payload = null;
    }
    try {
      const reportDir = path.join(root, "debug", "reports");
      fs.mkdirSync(reportDir, { recursive: true });
      fs.writeFileSync(
        path.join(reportDir, "whisper-load-probe.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            status: probe.status,
            payload,
            stdout: String(probe.stdout || "").slice(-4000),
            stderr: String(probe.stderr || "").slice(-4000),
          },
          null,
          2,
        ),
      );
    } catch {
      /* the debug report is diagnostic; a write failure must not fail the build */
    }
    if (payload && payload.ok) {
      log(`speech model cached (${payload.model || "whisper"})`);
    } else {
      log("speech model is not cached");
      incomplete.push("the faster-whisper speech model is not cached");
    }
    voiceSmokeTest(picked.root);
  }
}

/** The voice files are run for real, not only looked for (scripts/voice-smoke.cjs, which Doctor runs too). */
function voiceSmokeTest(fridayRoot) {
  const result = require("./voice-smoke.cjs").voiceSmoke({
    python,
    fridayRoot,
    kernelDir,
    run: capture,
    log,
  });
  incomplete.push(...result.problems);
}

function voiceImportable() {
  return (
    capture(python, ["-c", "import faster_whisper, av, edge_tts; print('voice packages ok')"])
      .status === 0
  );
}

if (!voiceImportable()) {
  const voicePins = parsePins(req).filter((pin) => voiceNames.has(pin.name));
  if (voicePins.length) {
    log("installing voice runtime packages (faster-whisper, edge-tts)");
    installWithMethods(voicePins.map((pin) => pin.spec));
  }
}
if (!voiceImportable()) {
  if (win) {
    console.error(
      "[friday] voice packages (faster-whisper, av, edge-tts) are still not importable.",
    );
    process.exit(1);
  }
  log(
    "note: faster-whisper / edge-tts not importable — kernel still boots; Install Manager can add them.",
  );
} else {
  log("voice packages ok (faster-whisper, av, edge-tts)");
}

const capReq = path.join(kernelDir, "requirements-capabilities.txt");
if (fs.existsSync(capReq)) {
  log(`installing capability extras from ${capReq}`);
  const capPins = parsePins(capReq).filter(
    (pin) => win || !/sys_platform\s*==\s*"win32"/.test(pin.spec),
  );
  // With a GPU or DirectML ONNX Runtime in the venv, the plain `onnxruntime` line is left out (a filtered copy of
  // the list is installed), so every other capability package still installs and the GPU build keeps its files.
  let capFile = capReq;
  const keep = runtime.keepGpuOnnxRuntime(
    fs.readFileSync(capReq, "utf8").split(/\r?\n/),
    onnxBefore,
  );
  if (keep.dropped.length) {
    capFile = path.join(root, "temporary", "downloads", "kernel-capabilities-requirements.txt");
    fs.mkdirSync(path.dirname(capFile), { recursive: true });
    fs.writeFileSync(capFile, `${keep.lines.join("\n")}\n`);
    log("onnxruntime is left out of the capability install (a GPU build of it is installed)");
  }
  const capInstall = keep.dropped.length
    ? capPins.filter((pin) => runtime.pipName(pin.name) !== "onnxruntime")
    : capPins;
  if (!installWithMethods(["-r", capFile], { preferBinaryFirst: true })) {
    // pip -r is all or nothing: one package without a wheel must not leave the other sixteen uninstalled.
    log("the capability list did not install as one set - installing each package on its own");
    for (const pin of capInstall) {
      if (!installWithMethods([pin.spec], { preferBinaryFirst: true, noUpgrade: true })) {
        log(`${pin.name} did not install`);
        incomplete.push(`${pin.name} did not install`);
      }
    }
  }
  for (const pin of capPins) {
    if (pin.name === "chromadb") continue;
    const mod =
      pin.importName ||
      (pin.name === "Pillow"
        ? "PIL"
        : pin.name === "PyAutoGUI"
          ? "pyautogui"
          : pin.name === "pywin32"
            ? "win32gui"
            : pin.name === "pymupdf"
              ? "pymupdf"
              : pin.name.toLowerCase().replace(/-/g, "_"));
    const importOk =
      capture(python, ["-c", `import ${mod}`]).status === 0 ||
      (pin.name === "pymupdf" && capture(python, ["-c", "import fitz"]).status === 0);
    if (importOk) {
      log(`${pin.name} ok`);
    } else {
      log(`${pin.name} is not importable`);
      incomplete.push(`${pin.name} is not importable`);
    }
  }
}

/**
 * A package of the lists above can depend on `onnxruntime` (faster-whisper, onnx-asr): pip does not know that the GPU
 * build already provides it and installs the CPU wheel on top. When that happened to a GPU or DirectML build, the plain
 * wheel is removed and the GPU build is put back from the same release, so the venv ends as the Install Manager left it.
 */
function restoreGpuOnnxRuntime() {
  if (!onnxBefore.gpu.length) return;
  const now = installedOnnxRuntimes();
  if (!now.plain) return;
  const gpu = onnxBefore.gpu[0];
  log(
    `the CPU onnxruntime wheel was installed beside ${gpu.name}; restoring ${gpu.name} ${gpu.version}`,
  );
  run(python, ["-m", "pip", "uninstall", "--yes", "--disable-pip-version-check", "onnxruntime"]);
  const spec = gpu.version ? `${gpu.name}==${gpu.version}` : gpu.name;
  if (!installWithMethods(["--force-reinstall", "--no-deps", spec], { noUpgrade: true })) {
    log(
      `NOTE ${gpu.name} could not be restored; run it again from the Install Manager (ONNX Runtime)`,
    );
  }
}
restoreGpuOnnxRuntime();

if (upgradeTried && !kernelLoads() && !rollbackUpgrade()) {
  incomplete.push(
    "the newest package releases broke the kernel and the earlier set could not be restored",
  );
}

if (capture(python, ["-c", "import chromadb"]).status !== 0) {
  log("note: chromadb not importable - FRIDAY falls back to SQLite memory.");
} else {
  log("chromadb ok (semantic memory enabled)");
  fetchChromaEmbeddingModel();
}

/**
 * Chroma embeds every memory with a 79 MB model (all-MiniLM-L6-v2) that it downloads the first time memory is
 * used. Left to that moment it made the first recall slow, and on a slow line it froze the kernel long enough for
 * the readiness restart to time out. It is fetched here once, with a "still working" line, where a failure only
 * costs a note: without it FRIDAY downloads it on first use, off the event loop, or uses the local index.
 */
/** The FRIDAY folder the app and this setup share: FRIDAY_ROOT, else the folder Windows setup picked; "" elsewhere. */
function chromaFridayRoot() {
  if (process.env.FRIDAY_ROOT) return process.env.FRIDAY_ROOT;
  if (!win) return "";
  try {
    return require("./friday-root.cjs").workspaceRootOrDev({ record: false }).root;
  } catch {
    return "";
  }
}

function fetchChromaEmbeddingModel() {
  if (process.env.FRIDAY_PREFETCH === "0" || process.env.FRIDAY_OFFLINE === "1") return;
  // The model lives in the FRIDAY folder (<FRIDAY_ROOT>/cache/chroma), the same files the installed app's kernel reads
  // (electron/main.cjs sets the same CHROMA_CACHE_DIR; kernel/memory.py points Chroma at it). Chroma 1.x ignores the
  // variable itself and always uses ~/.cache/chroma, so the probe sets the class path the same way. Without a FRIDAY
  // folder (a hosted run) the home cache stays.
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const fridayRoot = chromaFridayRoot();
  const cache =
    process.env.CHROMA_CACHE_DIR ||
    (fridayRoot ? path.join(fridayRoot, "cache", "chroma") : path.join(home, ".cache", "chroma"));
  const probe = [
    "import os, pathlib",
    "from chromadb.utils import embedding_functions as e",
    "cache = os.environ.get('CHROMA_CACHE_DIR', '')",
    "if cache and hasattr(e, 'ONNXMiniLM_L6_V2'):",
    "    m = e.ONNXMiniLM_L6_V2",
    "    m.DOWNLOAD_PATH = pathlib.Path(cache) / 'onnx_models' / m.MODEL_NAME",
    "f = getattr(e, 'DefaultEmbeddingFunction', None) or getattr(e, 'ONNXMiniLM_L6_V2')",
    "f()(['FRIDAY memory'])",
  ].join("\n");
  // Chroma keeps the model under <cache>/onnx_models/all-MiniLM-L6-v2/onnx. When it is there the step only loads it once
  // to prove it works, and says so (it used to say "fetching ... once" on every run).
  const present = fs.existsSync(
    path.join(cache, "onnx_models", "all-MiniLM-L6-v2", "onnx", "model.onnx"),
  );
  log(
    present
      ? "the semantic-memory embedding model (all-MiniLM-L6-v2) is already on disk; checking that it loads"
      : "fetching the semantic-memory embedding model (all-MiniLM-L6-v2, about 79 MB, once)",
  );
  const result = require("./with-activity.cjs").withActivityCommand(
    "semantic-memory model",
    [cache],
    python,
    ["-c", probe],
    { cwd: root, env: { ...process.env, CHROMA_CACHE_DIR: cache } },
  );
  log(
    result.status === 0
      ? "semantic-memory embedding model ready"
      : "NOTE the semantic-memory model was not downloaded; it is fetched on first use, or memory uses the local index (npm run doctor tries again)",
  );
}

/**
 * An NVIDIA card makes speech several times faster, but faster-whisper needs the CUDA 12 math libraries
 * (cuBLAS and cuDNN 9) next to it, and a Windows PC with only a newer CUDA toolkit has neither: speech
 * silently stayed on the CPU. pip ships both as ordinary wheels, so they are installed on an NVIDIA PC.
 * Best effort: without them speech works on the CPU as before.
 */
function pinnedCudaLibsLines() {
  if (!win || process.arch !== "x64") return null;
  try {
    const { PIP_BUNDLES, PINNED_WHEELS, planWheels } =
      require("./electron-module.cjs").load("engine-install.cjs");
    const bundle = PIP_BUNDLES["cuda-libs"];
    const resolved = Object.fromEntries(
      bundle.parts.map((part) => {
        const pin = PINNED_WHEELS[part.dist];
        return [
          part.dist,
          pin ? { ok: true, version: pin.version, assets: pin.assets } : { ok: false },
        ];
      }),
    );
    const plan = planWheels(bundle, resolved);
    return plan.ok ? plan.lines : null;
  } catch {
    return null;
  }
}

function installGpuSpeechLibraries() {
  if (!win || process.env.FRIDAY_GPU_SPEECH_LIBS === "0") return;
  const smi = capture("nvidia-smi", ["-L"]);
  if (smi.status !== 0 || !/GPU/i.test(String(smi.stdout || ""))) return;
  // This PC's plan decides (electron/setup-plan.cjs): the libraries are installed only when it says install (an NVIDIA
  // card whose driver reports CUDA 12, a compute capability the libraries support, room on the disk, a line that may
  // carry about 1.2 GB). Without a readable plan the card alone decides, as before.
  const plan = require("./prefetch-models.cjs").readPlanSync(process.env);
  const libs = plan?.required.find((row) => row.id === "cuda-libs");
  if (plan && libs?.action !== "install" && libs?.action !== "defer") {
    const why = (plan.skipped || []).find((row) => row.id === "cuda-libs")?.reason;
    log(
      libs?.action === "present"
        ? "GPU speech libraries ok (this PC's plan: already present)"
        : `GPU speech libraries not installed: ${why || "this PC's plan does not need them"}`,
    );
    return;
  }
  if (libs?.action === "defer") {
    log(
      "GPU speech libraries wait for a better moment (offline, metered line or battery); npm run doctor installs them later",
    );
    return;
  }
  const probe = [
    "-c",
    [
      "import importlib.util as u, pathlib",
      "def ok(m, d):",
      "    s = u.find_spec(m)",
      "    return bool(s and s.submodule_search_locations and any((pathlib.Path(p) / 'bin' / d).is_file() for p in s.submodule_search_locations))",
      "raise SystemExit(0 if ok('nvidia.cublas', 'cublas64_12.dll') and ok('nvidia.cudnn', 'cudnn64_9.dll') else 1)",
    ].join("\n"),
  ];
  if (capture(python, probe).status === 0) {
    log("GPU speech libraries ok (cuBLAS 12, cuDNN 9)");
    return;
  }
  log(
    "NVIDIA GPU found: installing the CUDA 12 libraries speech needs on the card (cuBLAS and cuDNN, about 1 GB, once)",
  );
  // The plan names exact wheels with SHA-256 (electron/engine-install.cjs PINNED_WHEELS, the same pins the Install
  // Manager installs): pip checks every file against them (--require-hashes, --no-deps because every part is pinned).
  // A hash that does not match fails the install and is never retried unpinned. Plain pip is used only when no pin
  // fits this PC (a platform the pins do not cover), and it says so.
  const pinned = pinnedCudaLibsLines();
  let ok;
  if (pinned) {
    const file = path.join(root, "temporary", "downloads", "cuda-libs-pinned.txt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${pinned.join("\n")}\n`);
    log(
      `installing the pinned CUDA 12 libraries (${pinned.map((l) => l.split(" ")[0]).join(", ")}) with SHA-256 checks`,
    );
    ok = installWithMethods(["--require-hashes", "--no-deps", "-r", file], {
      preferBinaryFirst: true,
      noUpgrade: true,
    });
  } else {
    log(
      "NOTE no pinned CUDA 12 wheel fits this PC; the libraries are installed from PyPI without a hash check",
    );
    ok = installWithMethods(["nvidia-cublas-cu12", "nvidia-cudnn-cu12>=9,<10"], {
      preferBinaryFirst: true,
      noUpgrade: true,
    });
  }
  log(
    ok
      ? "GPU speech libraries installed"
      : "NOTE the GPU speech libraries did not install; speech runs on the CPU (npm run doctor tries again)",
  );
}

installGpuSpeechLibraries();

if (win && voiceImportable()) {
  fetchModelsAndProbe();
}

if (incomplete.length) {
  const verdict = mustComplete ? "ACTION REQUIRED" : "NOTE";
  console.error(`[friday] ${verdict}  the Python setup is not complete:`);
  for (const line of incomplete) console.error(`[friday]   - ${line}`);
  if (mustComplete) {
    console.error("[friday] Fix the network or the package named above, then run: npm run doctor");
    process.exit(1);
  }
}

if (upgradeTried) updatePolicy.markChecked("python-packages");
log("Python kernel dependencies installed.");
log(`FRIDAY will use: ${python}`);
