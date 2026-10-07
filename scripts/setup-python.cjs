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
const run = (exe, args, opts = {}) =>
  spawnSync(exe, args, { stdio: "inherit", shell: false, cwd: root, ...opts });
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

// ---- Requirement installation: multiple official PyPI mechanisms.
// Wheels first so a normal FRIDAY installation never needs Rust/Cargo.
// Already-installed newer compatible packages are reused, never downgraded.
log(`installing kernel requirements from ${req}`);
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

function installWithMethods(extra, options = {}) {
  const methods = options.preferBinaryFirst
    ? pipMethods(extra).filter((method) => !method.args.includes("--only-binary=:all:"))
    : pipMethods(extra);
  for (const method of methods) {
    log(`method: ${method.label}`);
    const result = run(python, method.args);
    if (result.status === 0) return true;
    console.error(`[friday] method failed: ${method.label} (pip exit code ${result.status})`);
  }
  return false;
}

function parsePins(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = line.match(/^([A-Za-z0-9._-]+)(\[[^\]]+\])?(>=|==)([^\s;]+)/);
      return match ? { name: match[1], spec: line } : { name: line.split(/[[>=<]/)[0], spec: line };
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
  console.error("[friday] core kernel packages are still not importable.");
  process.exit(1);
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

function voiceImportable() {
  return (
    capture(python, ["-c", "import faster_whisper, edge_tts; print('voice packages ok')"])
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
    console.error("[friday] voice packages (faster-whisper, edge-tts) are still not importable.");
    process.exit(1);
  }
  log(
    "note: faster-whisper / edge-tts not importable — kernel still boots; Install Manager can add them.",
  );
} else {
  log("voice packages ok (faster-whisper, edge-tts)");
  if (win) {
    const fridayRoot = require("./friday-root.cjs");
    const picked = fridayRoot.workspaceRootOrDev();
    const stt = path.join(kernelDir, "stt.py");
    log(
      `probing faster-whisper model into ${path.join(picked.root, "cache", "stt")} (offline miss does not fail the build)`,
    );
    const probe = run(python, [stt, "--load-probe"], {
      env: {
        ...process.env,
        FRIDAY_ROOT: picked.root,
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      },
      timeout: 600000,
    });
    if (probe.status !== 0) {
      log("note: whisper model probe did not complete — first-run / Install Manager will retry");
    }
  }
}

const capReq = path.join(kernelDir, "requirements-capabilities.txt");
if (fs.existsSync(capReq)) {
  log(`installing capability extras from ${capReq}`);
  if (!installWithMethods(["-r", capReq], { preferBinaryFirst: true })) {
    log(
      "note: some capability extras were not installed — kernel still boots; Install Manager can add them.",
    );
  }
  const capPins = parsePins(capReq).filter(
    (pin) => win || !/sys_platform\s*==\s*"win32"/.test(pin.spec),
  );
  for (const pin of capPins) {
    if (pin.name === "chromadb") continue;
    const mod =
      pin.name === "Pillow"
        ? "PIL"
        : pin.name === "PyAutoGUI"
          ? "pyautogui"
          : pin.name === "pywin32"
            ? "win32gui"
            : pin.name === "pymupdf"
              ? "pymupdf"
              : pin.name.toLowerCase().replace(/-/g, "_");
    const importOk =
      capture(python, ["-c", `import ${mod}`]).status === 0 ||
      (pin.name === "pymupdf" && capture(python, ["-c", "import fitz"]).status === 0);
    if (importOk) {
      log(`${pin.name} ok`);
    } else {
      log(`note: ${pin.name} not importable — kernel still boots; Install Manager can add it.`);
    }
  }
}

if (capture(python, ["-c", "import chromadb"]).status !== 0) {
  log("note: chromadb not importable - FRIDAY falls back to SQLite memory.");
} else {
  log("chromadb ok (semantic memory enabled)");
}

log("Python kernel dependencies installed.");
log(`FRIDAY will use: ${python}`);
