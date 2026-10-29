"use strict";
/**
 * Re-read the Windows PATH into this process.
 *
 * A package manager writes a new PATH to the registry, but a console that was
 * already open keeps the PATH it started with. Setup installs and upgrades
 * tools (winget replaces a versioned folder when it upgrades FFmpeg), so the
 * next command in the same console, Doctor or the build, would report a tool it
 * just installed as missing. Every Windows script that checks tools calls this
 * first. Entries already in the process come first, registry entries are added.
 */
const { spawnSync } = require("node:child_process");

const READ_PATH =
  "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";

function readRegistryPath() {
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", READ_PATH], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  return out.status === 0 ? String(out.stdout || "").trim() : "";
}

/** Merge two PATH strings, first one first, without duplicates (Windows paths ignore case). */
function mergePaths(current, fresh) {
  const seen = new Set();
  const merged = [];
  for (const part of `${current || ""};${fresh || ""}`.split(";")) {
    const dir = part.trim().replace(/[\\/]+$/, "");
    if (!dir) continue;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(dir);
  }
  return merged.join(";");
}

/** Returns true when PATH changed. Off Windows it does nothing. */
function refreshWindowsPath(
  env = process.env,
  read = readRegistryPath,
  platform = process.platform,
) {
  if (platform !== "win32") return false;
  const fresh = read();
  if (!fresh) return false;
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") || "PATH";
  const next = mergePaths(env[key], fresh);
  const changed = next !== env[key];
  env[key] = next;
  return changed;
}

module.exports = { refreshWindowsPath, mergePaths, readRegistryPath };
