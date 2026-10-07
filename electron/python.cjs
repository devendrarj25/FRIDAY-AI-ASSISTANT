/** Resolve the same usable Python interpreter for kernel, Doctor and installer.
 *
 * Version policy is shared with scripts/python-runtime.cjs via
 * config/toolchain-versions.json: the minimum is a FLOOR, so any newer stable
 * CPython that is already installed is detected and reused (never rejected).
 */
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const paths = require("./friday-paths.cjs");

const WIN = process.platform === "win32";
let cached = null;
let cachedKey = "";

// The policy file ships twice: inside the app bundle (files:) and next to the
// packaged resources (extraResources:). Both locations are searched. A missing
// file must NEVER take the whole main process down before the window exists —
// it degrades to the built-in floor and is reported by Doctor instead.
const DEFAULT_POLICY = { pythonMinimum: "3.12.10" };
const versionFileCandidates = [
  path.join(process.resourcesPath || "", "config", "toolchain-versions.json"),
  path.join(__dirname, "..", "config", "toolchain-versions.json"),
  path.join(process.resourcesPath || "", "app.asar", "config", "toolchain-versions.json"),
  path.join(path.dirname(process.execPath), "resources", "config", "toolchain-versions.json"),
];
const versionFile = versionFileCandidates.find((candidate) => {
  try {
    return candidate && fs.existsSync(candidate);
  } catch {
    return false;
  }
});
let versions = DEFAULT_POLICY;
if (versionFile) {
  try {
    versions = { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(versionFile, "utf8")) };
  } catch (error) {
    console.warn(`[friday] runtime version policy unreadable (${error.message}) — using default`);
  }
} else {
  console.warn(
    `[friday] runtime version policy not found (${versionFileCandidates.join(", ")}) — using default floor ${DEFAULT_POLICY.pythonMinimum}`,
  );
}

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
const isSupported = (version) => !!version && compare(version, MINIMUM) >= 0;

/**
 * Windows CPython installations that are not on PATH: registry-registered
 * interpreters plus the official per-user / machine-wide folders. Detection
 * only — an already installed supported Python is reused, never replaced.
 */
function windowsInstalledPythons() {
  if (!WIN) return [];
  const found = [];
  try {
    const { execFileSync } = require("child_process");
    const read = (args) =>
      execFileSync("reg", args, { encoding: "utf8", timeout: 8000, windowsHide: true });
    for (const hive of ["HKCU", "HKLM"]) {
      for (const key of [
        `${hive}\\Software\\Python\\PythonCore`,
        `${hive}\\Software\\Wow6432Node\\Python\\PythonCore`,
      ]) {
        let listing = "";
        try {
          listing = read(["query", key]);
        } catch {
          continue;
        }
        for (const line of listing.split(/\r?\n/)) {
          const version = line.trim().split("\\").pop();
          if (!/^\d+\.\d+/.test(version || "")) continue;
          try {
            const value = read(["query", `${key}\\${version}\\InstallPath`, "/ve"]);
            const match = value.match(/REG_SZ\s+(.+)/);
            if (match) found.push(path.join(match[1].trim(), "python.exe"));
          } catch {
            /* interpreter not registered with an install path */
          }
        }
      }
    }
  } catch {
    /* registry unavailable */
  }
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Python") : null,
    process.env.ProgramFiles || null,
    process.env["ProgramFiles(x86)"] || null,
    "C:\\",
  ].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (/^Python3\d+$/i.test(entry)) found.push(path.join(root, entry, "python.exe"));
    }
  }
  return [...new Set(found)].sort().reverse();
}

/**
 * Every caller must land on the SAME interpreter, whether it passes a project
 * root or not. stt.cjs / neural-voice.cjs used to call resolvePython() with no
 * argument while toolchain.cjs (the module that pip-installs faster-whisper
 * and edge-tts) passed the project root — so in a source checkout the packages
 * were installed into <project>/.venv and then looked for in the system
 * Python. The app checkout's .venv is therefore ALWAYS a candidate, and the
 * order mirrors scripts/python-runtime.cjs so scripts and the app agree.
 *
 * Path helpers below are the single implementation of "where is the venv
 * interpreter". Default calls (no options) keep the historical join +
 * process.platform behaviour that candidates() already uses. Tests inject
 * path.win32 / a win32 flag / existsSync so Linux can assert Windows-shaped
 * strings without changing live resolution.
 */
function venvPython(parentDir, options = {}) {
  const p = options.path || path;
  const win32 = options.win32 ?? WIN;
  return p.join(parentDir, ".venv", win32 ? "Scripts/python.exe" : "bin/python");
}

function runtimeVenvPython(fridayRoot, options = {}) {
  const p = options.path || path;
  return venvPython(p.join(fridayRoot, "runtime"), options);
}

/** Same join candidates() has always used (platform path + process.platform). */
const venvIn = (dir) => venvPython(dir);

/**
 * Existence-only pick of the FRIDAY-managed interpreter for a given folder.
 * Primary is <root>/runtime/.venv (what setup/CMD actually creates). Legacy
 * is <root>/.venv (source checkout / older installs). Does not probe version
 * and does not consult PATH — resolvePython() still does that for the kernel.
 */
function resolveManagedPython(fridayRoot, options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const present = (file) => {
    try {
      return Boolean(file) && existsSync(file);
    } catch {
      return false;
    }
  };
  const tried = [];
  if (!fridayRoot) {
    return {
      exe: null,
      source: null,
      tried,
      reason: "no FRIDAY folder was given",
    };
  }
  const primary = runtimeVenvPython(fridayRoot, options);
  tried.push(primary);
  if (present(primary)) {
    return {
      exe: primary,
      source: "runtime",
      tried,
      reason: "primary runtime/.venv interpreter exists",
    };
  }
  const legacy = venvPython(fridayRoot, options);
  tried.push(legacy);
  if (present(legacy)) {
    return {
      exe: legacy,
      source: "legacy",
      tried,
      reason: `runtime interpreter not found at ${primary}; using legacy .venv`,
    };
  }
  return {
    exe: null,
    source: null,
    tried,
    reason: `runtime interpreter not found at ${primary}; legacy interpreter not found at ${legacy}`,
  };
}

function candidates(projectRoot = null) {
  // A FRIDAY-managed environment inside the selected folder always wins, so a
  // moved or re-selected FRIDAY home brings its own runtime with it.
  const workspaceVenv = paths.hasRoot() ? venvIn(paths.dir("runtime")) : null;
  const workspaceEnv = process.env.FRIDAY_WORKSPACE_ROOT
    ? venvIn(path.join(process.env.FRIDAY_WORKSPACE_ROOT, "runtime"))
    : null;
  const installDir =
    process.env.FRIDAY_INSTALL_DIR ||
    (process.resourcesPath ? path.dirname(path.dirname(process.resourcesPath)) : null);
  const appRoot = path.join(__dirname, "..");
  return [
    workspaceVenv ? { exe: workspaceVenv, prefix: [] } : null,
    workspaceEnv ? { exe: workspaceEnv, prefix: [] } : null,
    installDir ? { exe: venvIn(path.join(installDir, "runtime")), prefix: [] } : null,
    projectRoot ? { exe: venvIn(projectRoot), prefix: [] } : null,
    // The checkout / unpacked app itself — the environment `npm run
    // setup:python` really creates.
    { exe: venvIn(appRoot), prefix: [] },
    WIN
      ? {
          // prettier-ignore
          exe: path.join(path.dirname(process.execPath), "runtime", ".venv", "Scripts", "python.exe"),
          prefix: [],
        }
      : null,

    process.env.FRIDAY_PYTHON ? { exe: process.env.FRIDAY_PYTHON, prefix: [] } : null,

    WIN ? { exe: "py", prefix: ["-3"] } : null,
    { exe: WIN ? "python" : "python3", prefix: [] },
    WIN ? { exe: "python3", prefix: [] } : { exe: "python", prefix: [] },
    ...(WIN
      ? ["3.16", "3.15", "3.14", "3.13", "3.12"].map((v) => ({ exe: "py", prefix: [`-${v}`] }))
      : []),
    ...windowsInstalledPythons().map((exe) => ({ exe, prefix: [] })),
  ].filter(Boolean);
}

/** App Execution Aliases under WindowsApps open the Store and never exit. */
function isWindowsStoreAlias(file) {
  return /[\\/]WindowsApps[\\/]/i.test(String(file || ""));
}

/** First PATH hit for a bare command, so a Store alias can be skipped unspawned. */
function commandOnPath(name) {
  if (!name || path.isAbsolute(name)) return name || "";
  const pathEnv = process.env.PATH || process.env.Path || "";
  const suffixes = WIN ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      if (suffix && name.toLowerCase().endsWith(suffix)) continue;
      const candidate = path.join(dir, name + suffix);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return "";
}

function skipUnusableInterpreter(exe) {
  if (isWindowsStoreAlias(exe)) return true;
  const located = !exe || path.isAbsolute(exe) ? exe : commandOnPath(exe);
  if (located && isWindowsStoreAlias(located)) return true;
  if (exe && path.isAbsolute(exe)) {
    try {
      if (!fs.existsSync(exe)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function probe(candidate) {
  return new Promise((resolve) => {
    if (skipUnusableInterpreter(candidate.exe)) return resolve(null);
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = execFile(
      candidate.exe,
      [
        ...candidate.prefix,
        "-c",
        "import sys;print(sys.executable);print('.'.join(map(str,sys.version_info[:3])))",
      ],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) return finish(null);
        const [executable, version = ""] = stdout.trim().split(/\r?\n/);
        if (!executable || !isSupported(version.trim())) return finish(null);
        finish({
          exe: candidate.exe,
          prefix: candidate.prefix,
          executable,
          version: version.trim(),
        });
      },
    );
    timer = setTimeout(() => {
      try {
        if (WIN && child.pid) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.unref?.();
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
      finish(null);
    }, 8000);
  });
}

/**
 * The resolved interpreter depends on the selected FRIDAY folder (its
 * runtime/.venv wins). Caching it by value alone kept a stale interpreter
 * after the owner picked or moved a folder, so the cache is keyed by the
 * inputs that decide the answer and re-probes when they change.
 */
function cacheKey(projectRoot) {
  return [
    paths.hasRoot() ? paths.dir("runtime") : "",
    projectRoot || "",
    process.env.FRIDAY_PYTHON || "",
    process.env.FRIDAY_WORKSPACE_ROOT || "",
    process.env.FRIDAY_INSTALL_DIR || "",
  ].join("|");
}

async function resolvePython(projectRoot = null, force = false) {
  const key = cacheKey(projectRoot);
  if (cached && cachedKey === key && !force && fs.existsSync(cached.executable)) return cached;
  cached = null;
  cachedKey = key;
  for (const candidate of candidates(projectRoot)) {
    // Sequential by design: explicit configuration and the project venv win.

    const found = await probe(candidate);
    if (found) {
      cached = found;
      return found;
    }
  }
  return null;
}

/** Drop the cached interpreter (workspace changed / runtime repaired). */
function invalidatePython() {
  cached = null;
  cachedKey = "";
}

module.exports = {
  resolvePython,
  invalidatePython,
  MINIMUM,
  isSupported,
  venvPython,
  runtimeVenvPython,
  resolveManagedPython,
  isWindowsStoreAlias,
  skipUnusableInterpreter,
};
