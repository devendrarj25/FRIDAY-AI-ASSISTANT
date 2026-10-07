/**
 * FRIDAY — shared Python runtime policy.
 *
 * ONE place decides what "a supported Python" means, how an existing one is
 * discovered/reused, and how a missing one is installed from official sources.
 * Setup, Doctor, the Electron app and the installer all use this module, so a
 * single change applies to the EXE and the browser build at the same time.
 *
 * Policy: minimum version is a FLOOR (config/toolchain-versions.json).
 * Any newer stable CPython is detected, reused and never downgraded.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const win = process.platform === "win32";
const versions = JSON.parse(
  fs.readFileSync(path.join(root, "config", "toolchain-versions.json"), "utf8"),
);
const MINIMUM = versions.pythonMinimum;

const parts = (v) =>
  String(v || "")
    .split(".")
    .map((p) => Number(p) || 0);
function compare(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}
/** Floor check: >= minimum passes, newer stable releases always pass. */
const isSupported = (version, minimum = MINIMUM) => !!version && compare(version, minimum) >= 0;

/**
 * The environment FRIDAY actually runs on.
 *
 * In a source checkout that is <project>/.venv. In an installed Windows build
 * the app files live in resources/, while the real interpreter is the one the
 * installer repaired at <install>/runtime/.venv — and a selected FRIDAY folder
 * may carry its own runtime/.venv with it. Every script (registry, doctor,
 * readiness) must probe the SAME interpreter the Electron app launches, so the
 * search order below mirrors electron/python.cjs candidates().
 *
 * Voice runtime floors (faster-whisper, edge-tts) are declared in
 * kernel/requirements.txt and installed by setup-python into this same venv.
 * They are not FastAPI startup imports — the kernel still boots without them.
 */
const pythonIn = (dir) => path.join(dir, ".venv", win ? "Scripts/python.exe" : "bin/python");
const exists = (file) => {
  try {
    return !!file && fs.existsSync(file);
  } catch {
    return false;
  }
};

/** Same two packages first-run / Install Manager already install for hear/speak. */
const VOICE_PACKAGES = ["faster-whisper", "edge-tts"];

/**
 * Kernel modules already import these when present. They are not FastAPI
 * startup requirements. setup-python installs them into the live venv from
 * kernel/requirements-capabilities.txt.
 */
const CAPABILITY_PACKAGES = [
  "numpy",
  "chromadb",
  "bleak",
  "zeroconf",
  "onnxruntime",
  "pymupdf",
  "Pillow",
  "pytesseract",
  "mss",
  "PyAutoGUI",
  "pywin32",
];

/** Selected FRIDAY folder `runtime` directory, or null when none is chosen. */
function selectedRuntimeParent() {
  try {
    const fridayRoot = require("./friday-root.cjs");
    const selected = fridayRoot.findWorkspaceRoot();
    if (selected) return fridayRoot.layout(selected).runtime;
  } catch {
    /* a missing pointer keeps the checkout .venv */
  }
  if (process.env.FRIDAY_WORKSPACE_ROOT) {
    return path.join(path.resolve(process.env.FRIDAY_WORKSPACE_ROOT), "runtime");
  }
  return null;
}

/**
 * Where setup-python must create or reuse the venv. A selected FRIDAY folder
 * wins so pip lands in the interpreter the running app will launch.
 */
function targetVenvParent() {
  return selectedRuntimeParent() || root;
}

function targetVenvPython() {
  return pythonIn(targetVenvParent());
}

function resolveVenvPython() {
  const installDir =
    process.env.FRIDAY_INSTALL_DIR ||
    (process.resourcesPath ? path.dirname(path.dirname(process.resourcesPath)) : null);
  const targeted = targetVenvPython();
  const candidates = [
    targeted,
    process.env.FRIDAY_WORKSPACE_ROOT
      ? pythonIn(path.join(process.env.FRIDAY_WORKSPACE_ROOT, "runtime"))
      : null,
    installDir ? pythonIn(path.join(installDir, "runtime")) : null,
    pythonIn(path.join(root, "..", "runtime")),
    pythonIn(root),
  ].filter(Boolean);
  return candidates.find(exists) || targeted;
}

/**
 * Create the target venv when missing, using an already-discovered CPython.
 * Returns the venv interpreter path, or null if `python -m venv` failed.
 */
function ensureVenv(systemPython) {
  const dest = targetVenvPython();
  if (exists(dest)) return dest;
  const venvDir = path.join(targetVenvParent(), ".venv");
  try {
    fs.mkdirSync(path.dirname(venvDir), { recursive: true });
  } catch {
    /* create proceeds; venv itself reports the real error */
  }
  const result = spawnSync(systemPython, ["-m", "venv", venvDir], {
    stdio: "inherit",
    cwd: root,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0 || !exists(dest)) return null;
  return dest;
}

const venvPython = resolveVenvPython();
const venvDir = path.dirname(path.dirname(venvPython));

const capture = (exe, args, opts = {}) =>
  spawnSync(exe, args, {
    encoding: "utf8",
    cwd: root,
    shell: false,
    windowsHide: true,
    timeout: 60000,
    ...opts,
  });

/** A real interpreter prints its own path; the Windows Store stub does not. */
function probe(exe, prefix = []) {
  if (path.isAbsolute(exe) && !fs.existsSync(exe)) return null;
  const r = capture(exe, [
    ...prefix,
    "-c",
    "import sys;print(sys.executable);print('.'.join(map(str,sys.version_info[:3])))",
  ]);
  if (r.status !== 0 || !r.stdout) return null;
  const [executable, version] = r.stdout.trim().split(/\r?\n/);
  if (!executable || !fs.existsSync(executable)) return null;
  if (!isSupported(version)) return null;
  return { exe, prefix, executable, version };
}

/**
 * Windows installations that are not on PATH: registry-registered CPython
 * (HKCU/HKLM PythonCore) plus the official per-user and machine-wide folders.
 * Detection only — nothing here installs or downloads anything.
 */
function windowsInstalledPythons() {
  const found = [];
  for (const hive of ["HKCU", "HKLM"]) {
    for (const key of [
      `${hive}\\Software\\Python\\PythonCore`,
      `${hive}\\Software\\Wow6432Node\\Python\\PythonCore`,
    ]) {
      const list = capture("reg", ["query", key], { timeout: 15000 });
      if (list.status !== 0 || !list.stdout) continue;
      for (const line of list.stdout.split(/\r?\n/)) {
        const version = line.trim().split("\\").pop();
        if (!/^\d+\.\d+/.test(version || "")) continue;
        const read = capture("reg", ["query", `${key}\\${version}\\InstallPath`, "/ve"], {
          timeout: 15000,
        });
        const match = read.stdout && read.stdout.match(/REG_SZ\s+(.+)/);
        if (match) found.push(path.join(match[1].trim(), "python.exe"));
      }
    }
  }
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Python") : null,
    process.env.ProgramFiles || null,
    process.env["ProgramFiles(x86)"] || null,
    "C:\\",
  ].filter(Boolean);
  for (const root_ of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root_);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!/^Python3\d+$/i.test(entry)) continue;
      found.push(path.join(root_, entry, "python.exe"));
    }
  }
  // Newest first so a supported newer interpreter is preferred and reused.
  return [...new Set(found)].sort().reverse();
}

/** Candidate interpreters, best first. The project venv always wins. */
function candidates() {
  const list = [];
  if (process.env.FRIDAY_PYTHON) list.push([process.env.FRIDAY_PYTHON, []]);
  list.push([venvPython, []]);
  if (win) {
    // `py -3` reports the newest installed CPython; explicit minors follow.
    list.push(["py", ["-3"]]);
    for (const minor of [16, 15, 14, 13, 12]) list.push(["py", [`-3.${minor}`]]);
    list.push(["python", []], ["python3", []]);
    for (const exe of windowsInstalledPythons()) list.push([exe, []]);
  } else {
    list.push(["python3", []], ["python", []]);
  }
  return list;
}

/** First installed interpreter that satisfies the floor, or null. */
function discoverPython() {
  for (const [exe, prefix] of candidates()) {
    const found = probe(exe, prefix);
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------------------------ install
function log(message) {
  console.log(`[friday] ${message}`);
}

/** Newest stable CPython >= floor published on python.org (official index). */
function latestOfficialVersion() {
  const r = capture(process.execPath, [
    "-e",
    `const https=require('node:https');https.get('https://www.python.org/ftp/python/',{headers:{'user-agent':'friday-setup'}},(res)=>{let b='';res.on('data',(c)=>b+=c);res.on('end',()=>process.stdout.write(b));}).on('error',()=>process.exit(1));`,
  ]);
  if (r.status !== 0 || !r.stdout) return null;
  const found = [...r.stdout.matchAll(/href="(\d+\.\d+\.\d+)\//g)].map((m) => m[1]);
  const stable = found.filter((v) => isSupported(v));
  if (!stable.length) return null;
  return stable.sort(compare).pop();
}

/** Official winget package id for a version, e.g. 3.12.10 -> Python.Python.3.12 */
const wingetId = (version) => `Python.Python.${parts(version).slice(0, 2).join(".")}`;

function downloadOfficialFile(url, file) {
  const attempts = [
    {
      label: "node https",
      run: () =>
        spawnSync(
          process.execPath,
          [
            "-e",
            `const https=require('node:https'),fs=require('node:fs');const get=(u)=>https.get(u,{headers:{'user-agent':'friday-setup'}},(res)=>{if([301,302,307,308].includes(res.statusCode))return get(res.headers.location);if(res.statusCode!==200)process.exit(1);res.pipe(fs.createWriteStream(process.argv[1])).on('finish',()=>process.exit(0));}).on('error',()=>process.exit(1));get(${JSON.stringify(url)});`,
            file,
          ],
          { stdio: "inherit", cwd: root },
        ),
    },
  ];
  if (win) {
    attempts.push({
      label: "curl.exe",
      run: () =>
        spawnSync(
          "curl.exe",
          [
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--retry",
            "3",
            "--retry-delay",
            "2",
            "--output",
            file,
            url,
          ],
          { stdio: "inherit", cwd: root, windowsHide: true },
        ),
    });
    attempts.push({
      label: "PowerShell Invoke-WebRequest",
      run: () =>
        spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Invoke-WebRequest -Uri ${JSON.stringify(url)} -OutFile ${JSON.stringify(file)} -UseBasicParsing`,
          ],
          { stdio: "inherit", cwd: root, windowsHide: true },
        ),
    });
  }
  for (const method of attempts) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* missing file is the starting state */
    }
    const result = method.run();
    if (result.status === 0 && exists(file) && fs.statSync(file).size > 0) return result;
    console.error(
      `[friday] download method failed: ${method.label} (exit ${result.status == null ? "spawn error" : result.status})`,
    );
  }
  return { status: 1 };
}

function wingetPython(id) {
  return {
    label: `winget ${id} (official Windows package source)`,
    run: () =>
      spawnSync(
        "winget",
        [
          "install",
          "--id",
          id,
          "--exact",
          "--source",
          "winget",
          "--silent",
          "--accept-package-agreements",
          "--accept-source-agreements",
          "--disable-interactivity",
        ],
        { stdio: "inherit", shell: false, cwd: root },
      ),
  };
}

/**
 * Install a compatible stable CPython from official sources only.
 * Method 1: the official python.org Windows installer, run silently (retried,
 *           newest compatible release first, then a known-good fallback).
 * Method 2: winget (Microsoft's package source, python.org publisher) for
 *           the 3.13 and 3.12 series.
 * Detection always runs first, so an already installed supported Python is
 * reused and nothing is downloaded.
 */
function installPython() {
  if (!win) {
    console.error(
      `[friday] install Python >=${MINIMUM} with your system package manager (https://www.python.org/downloads/).`,
    );
    return null;
  }
  const target = latestOfficialVersion();
  const officialVersions = [...new Set([target, MINIMUM].filter(Boolean))];

  const officialInstaller = (version) => ({
    label: `official python.org installer ${version}`,
    run: () => {
      const dir = path.join(root, "temporary", "downloads");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `python-${version}-amd64.exe`);
      const url = `https://www.python.org/ftp/python/${version}/python-${version}-amd64.exe`;
      const download = downloadOfficialFile(url, file);
      if (download.status !== 0) return download;
      return spawnSync(
        file,
        [
          "/quiet",
          "InstallAllUsers=0",
          "PrependPath=1",
          "Include_pip=1",
          "Include_launcher=1",
          "Include_test=0",
        ],
        { stdio: "inherit", shell: false, cwd: root },
      );
    },
  });

  const methods = [
    // Two attempts each: a transient download failure must not end the install.
    ...officialVersions.flatMap((version) => [
      officialInstaller(version),
      officialInstaller(version),
    ]),
    wingetPython(wingetId(target || MINIMUM)),
    wingetPython("Python.Python.3.13"),
    wingetPython("Python.Python.3.12"),
  ];

  for (const method of methods) {
    log(`installing Python — ${method.label}`);
    const result = method.run();
    // winget returns success-ish HRESULTs when the package is already current;
    // the python.org installer returns 3010 when it wants a reboot.
    const ok = result && [0, 3010, 1638, -1978335189, -1978335135].includes(result.status);
    // Re-scan after every attempt: a partial install may still register a
    // usable interpreter that the previous sweep could not see.
    const found = discoverPython();
    if (found) return found;
    console.error(
      `[friday] method failed: ${method.label} (exit ${result ? result.status : "spawn error"}${ok ? ", but no interpreter found" : ""})`,
    );
  }
  return null;
}

/** Discover a supported Python, installing one from official sources if needed. */
function ensurePython({ install = true } = {}) {
  const found = discoverPython();
  if (found) return found;
  if (!install) return null;
  return installPython();
}

module.exports = {
  MINIMUM,
  root,
  win,
  venvDir,
  venvPython,
  VOICE_PACKAGES,
  CAPABILITY_PACKAGES,
  compare,
  isSupported,
  probe,
  windowsInstalledPythons,
  discoverPython,
  latestOfficialVersion,
  installPython,
  ensurePython,
  selectedRuntimeParent,
  targetVenvParent,
  targetVenvPython,
  resolveVenvPython,
  ensureVenv,
};
