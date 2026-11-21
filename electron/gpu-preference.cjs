/**
 * FRIDAY · use the fast graphics card on a PC that has two.
 *
 * A laptop with an integrated and a discrete graphics chip (Intel or AMD plus NVIDIA, "Optimus"/"switchable graphics")
 * runs an app on the integrated one unless Windows is told otherwise, so FRIDAY's window drew with the weak chip while
 * the strong one idled: low frame rates and stutter with the same work. Windows keeps that choice per program in
 * Settings → System → Display → Graphics, as a value named after the program's path under
 * `HKCU\Software\Microsoft\DirectX\UserGpuPreferences` (`GpuPreference=2;` is "High performance"). Chromium picks the
 * adapter Windows lists first, so this one value is the whole fix. It takes effect from the next start of FRIDAY.
 *
 * The owner's own choice is never changed: a value that already exists for this program stays as it is (including
 * "Power saving" set on purpose). A PC with one graphics chip ignores it. The uninstaller removes the value. The
 * portable EXE runs from a different temporary folder each time, so it writes nothing. `FRIDAY_GPU_PREFERENCE=default`
 * turns it off.
 */
"use strict";

const KEY = "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences";
const HIGH_PERFORMANCE = "GpuPreference=2;";

function wanted({ platform = process.platform, env = process.env, portable = false } = {}) {
  if (platform !== "win32" || portable) return false;
  if (env.FRIDAY_READINESS === "1" || env.FRIDAY_BOOT_SELFTEST) return false;
  return String(env.FRIDAY_GPU_PREFERENCE || "").toLowerCase() !== "default";
}

/** `reg` as a promise that never rejects: { code, out }. */
function runReg(execFile, args) {
  return new Promise((resolve) => {
    try {
      execFile("reg", args, { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          out: String(stdout || ""),
        });
      });
    } catch {
      resolve({ code: 1, out: "" });
    }
  });
}

/**
 * Sets "High performance" for the program when Windows has no preference for it yet.
 * Resolves { changed, reason }; never throws.
 */
async function ensureHighPerformance({ exe, execFile, log = () => {}, ...rest } = {}) {
  if (!wanted(rest)) return { changed: false, reason: "not wanted here" };
  if (!exe || !execFile) return { changed: false, reason: "no program path" };
  const existing = await runReg(execFile, ["query", KEY, "/v", exe]);
  if (existing.code === 0 && existing.out.includes(exe)) {
    return { changed: false, reason: "Windows already has a graphics preference for FRIDAY" };
  }
  const written = await runReg(execFile, [
    "add",
    KEY,
    "/v",
    exe,
    "/t",
    "REG_SZ",
    "/d",
    HIGH_PERFORMANCE,
    "/f",
  ]);
  if (written.code !== 0) {
    log(`graphics preference not set (reg add exit ${written.code})`);
    return { changed: false, reason: "the registry refused the value" };
  }
  log("graphics preference set to High performance for FRIDAY (applies from the next start)");
  return { changed: true, reason: "set to High performance" };
}

module.exports = { KEY, HIGH_PERFORMANCE, wanted, ensureHighPerformance };
