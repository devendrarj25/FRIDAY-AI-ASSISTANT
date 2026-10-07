/**
 * FRIDAY · probe execution context (packaged-app safe).
 *
 * The measurement code in `system-monitor.cjs` and `hardware.cjs` is correct —
 * what used to break was the *execution context* it ran in once the app was
 * packaged and launched from a Start-menu / elevated shortcut instead of a dev
 * shell:
 *
 *  1. `execFile("powershell.exe", …)` resolves through PATH. A packaged,
 *     elevated process can inherit a PATH without `%SystemRoot%\System32`
 *     (or a machine-policy PATH that never got refreshed), and the spawn dies
 *     with ENOENT. We now resolve the interpreter by absolute path first.
 *  2. `nvidia-smi` / `nvcc` are frequently NOT on PATH. Older NVIDIA drivers
 *     install nvidia-smi into `C:\Program Files\NVIDIA Corporation\NVSMI`, and
 *     the CUDA toolkit adds `nvcc` to the *user* PATH, which an already-running
 *     elevated process never sees. We search the real install locations.
 *  3. PowerShell scripts were blocked by execution policy on locked-down
 *     machines. `-Command` is mostly exempt, but `-ExecutionPolicy Bypass`
 *     removes the whole class of failure (and Constrained Language Mode is now
 *     reported as a real reason instead of silence).
 *  4. The packaged app's working directory can be a folder PowerShell refuses
 *     to start in. Probes now always run from the system root.
 *  5. `Get-NetAdapterStatistics` auto-loads the NetAdapter CIM module on first
 *     use, which regularly takes longer than the old 6 s budget on a cold,
 *     AV-scanned machine — so it timed out on *every* sample and silently
 *     produced `null` forever. Timeouts are now realistic.
 *
 * Above all: every failure returns a REAL reason string. Nothing here ever
 * swallows an error into `null`, which is what made this invisible in the UI.
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const isWindows = process.platform === "win32";
const systemRoot = process.env["SystemRoot"] || process.env["windir"] || "C:\\Windows";

/** Working directory probes are launched from — always known-good. */
function probeCwd() {
  try {
    if (isWindows && fs.existsSync(systemRoot)) return systemRoot;
  } catch {
    /* fall through */
  }
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

/** Turn a spawn/exec failure into a sentence the owner can act on. */
function describeFailure(cmd, err, stderr, timeout) {
  const text = String(stderr || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (err && err.code === "ENOENT") {
    return `${path.basename(cmd)} was not found (not on PATH and not in its known install locations)`;
  }
  if (err && err.code === "EACCES") return `${path.basename(cmd)} is not allowed to run (EACCES)`;
  if (err && (err.killed || err.signal === "SIGTERM")) {
    return `${path.basename(cmd)} timed out after ${timeout} ms`;
  }
  if (text && /cannot be loaded because running scripts is disabled|UnauthorizedAccess/i.test(text))
    return `PowerShell access blocked by execution policy: ${text}`;
  if (text && /ConstrainedLanguage|not allowed in this language mode/i.test(text))
    return `PowerShell is in Constrained Language Mode: ${text}`;
  if (text) return text;
  if (err && typeof err.code === "number") {
    return `${path.basename(cmd)} exited with code ${err.code}`;
  }
  if (err) return `${path.basename(cmd)} failed: ${String(err.message || err)}`;
  return null;
}

/**
 * Run a probe. Never throws.
 * @returns {Promise<{ok: boolean, stdout: string|null, error: string|null}>}
 */
function runProbe(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { timeout, windowsHide: true, cwd: probeCwd(), maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const out = String(stdout ?? "").trim();
          if (err) {
            resolve({
              ok: false,
              stdout: out || null,
              error: describeFailure(cmd, err, stderr, timeout),
            });
            return;
          }
          const warn = describeFailure(cmd, null, stderr, timeout);
          resolve({
            ok: true,
            stdout: out,
            error: out ? null : (warn ?? `${path.basename(cmd)} produced no output`),
          });
        },
      );
    } catch (error) {
      resolve({ ok: false, stdout: null, error: describeFailure(cmd, error, null, timeout) });
    }
  });
}

/* ------------------------------------------------------------ resolution -- */

const exists = (candidate) => {
  try {
    return Boolean(candidate) && fs.existsSync(candidate);
  } catch {
    return false;
  }
};

let cachedShell;

/** Absolute path to a PowerShell host, resolved without relying on PATH. */
function powershellPath() {
  if (cachedShell !== undefined) return cachedShell;
  if (!isWindows) {
    cachedShell = "powershell";
    return cachedShell;
  }
  const candidates = [
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(systemRoot, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(systemRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  ];
  cachedShell = candidates.find(exists) || "powershell.exe";
  return cachedShell;
}

/** Search PATH plus explicit install directories for a Windows executable. */
function resolveBinary(name, extraDirs = []) {
  if (!isWindows) return name;
  const exe = name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`;
  for (const dir of extraDirs) {
    if (!dir) continue;
    const direct = path.join(dir, exe);
    if (exists(direct)) return direct;
  }
  const pathDirs = String(process.env["PATH"] || process.env["Path"] || "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ""), exe);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Every place a working `nvidia-smi` realistically lives on Windows. */
function nvidiaSmiPath() {
  if (!isWindows) return "nvidia-smi";
  return resolveBinary("nvidia-smi", [
    path.join(systemRoot, "System32"),
    "C:\\Program Files\\NVIDIA Corporation\\NVSMI",
    "C:\\Program Files (x86)\\NVIDIA Corporation\\NVSMI",
  ]);
}

/** CUDA toolkit `nvcc`, including versioned toolkit roots the PATH may miss. */
function nvccPath() {
  if (!isWindows) return "nvcc";
  const dirs = [];
  if (process.env["CUDA_PATH"]) dirs.push(path.join(process.env["CUDA_PATH"], "bin"));
  const toolkitRoot = "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA";
  try {
    for (const entry of fs.readdirSync(toolkitRoot))
      dirs.push(path.join(toolkitRoot, entry, "bin"));
  } catch {
    /* toolkit not installed */
  }
  return resolveBinary("nvcc", dirs);
}

/**
 * Run an inline PowerShell expression in a context a packaged app can rely on.
 * Bypasses execution policy, skips the profile, and starts from the system root.
 */
function runPowerShell(expression, timeout = 12000) {
  const shell = powershellPath();
  if (isWindows && !exists(shell)) {
    return Promise.resolve({
      ok: false,
      stdout: null,
      error: `PowerShell host not found at ${shell} — the packaged app cannot reach System32`,
    });
  }
  return runProbe(
    shell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", expression],
    timeout,
  );
}

module.exports = {
  runProbe,
  runPowerShell,
  powershellPath,
  nvidiaSmiPath,
  nvccPath,
  resolveBinary,
  probeCwd,
  describeFailure,
};
