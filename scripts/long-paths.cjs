/**
 * Windows long paths. A Python environment unpacks packages whose own folders run well past 100 characters
 * (`site-packages\<package>\...\tests\data\...`), and Windows refuses a path over 260 characters unless
 * `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled` is 1. A FRIDAY folder deep in the disk then
 * makes a package install fail with a "No such file or directory" that names no cause. This reports the state and,
 * when the folder is deep enough to matter, how to fix it. Nothing here changes the registry (it needs administrator
 * rights); the fix line is a command the owner runs.
 */
const { spawnSync } = require("node:child_process");

/** Longest path below a Python environment's root that a common wheel unpacks to. */
const DEEPEST_PACKAGE_PATH = 190;
const LIMIT = 260;

/** `Enabled` (1), `Disabled` (0 or no value) or `Unknown` (not Windows, or the key could not be read). */
function readLongPathsEnabled(platform = process.platform, run = spawnSync) {
  if (platform !== "win32") return "Unknown";
  try {
    const out = run(
      "reg",
      ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"],
      { encoding: "utf8", windowsHide: true, timeout: 8000 },
    );
    if (out.error || out.status !== 0) return "Disabled";
    const match = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out.stdout || "");
    return match && parseInt(match[1], 16) === 1 ? "Enabled" : "Disabled";
  } catch {
    return "Unknown";
  }
}

/**
 * @param {{ state: "Enabled"|"Disabled"|"Unknown", root: string }} input
 * @returns {{ ok: boolean, note: string, fix: string }}
 */
function assess({ state, root }) {
  const length = String(root || "").length;
  if (state === "Enabled") return { ok: true, note: "long paths are enabled", fix: "" };
  if (state === "Unknown") return { ok: true, note: "not checked on this system", fix: "" };
  const room = LIMIT - length;
  if (length + DEEPEST_PACKAGE_PATH <= LIMIT) {
    return {
      ok: true,
      note: `long paths are off, but the FRIDAY folder is short enough (${length} characters, ${room} left under 260)`,
      fix: "",
    };
  }
  return {
    ok: false,
    note: `long paths are off and the FRIDAY folder is ${length} characters deep, so a package with a deep path can fail to install`,
    fix: 'Move the FRIDAY folder somewhere shorter (for example C:\\FRIDAY), or in an administrator PowerShell run: New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force',
  };
}

module.exports = { DEEPEST_PACKAGE_PATH, LIMIT, readLongPathsEnabled, assess };
