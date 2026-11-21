/**
 * FRIDAY · the portable EXE keeps to itself.
 *
 * The portable EXE is the same program as the installed (Setup) FRIDAY, but it is run, not installed. Left alone it
 * shared everything with an installed copy on the same PC: the settings folder (`%APPDATA%\FRIDAY`), the single-instance
 * lock, the FRIDAY folder named in the registry, the kernel port, the sign-in entry, and the update path (which ran the
 * Setup installer). This module gives the portable EXE its own of each, so both can run at the same time and neither
 * disturbs the other:
 *
 *   - its own settings and Chromium data   `<home>\userData`   (so its own lock, preferences and logs)
 *   - its own FRIDAY folder                `<home>\FRIDAY`     (database, models, memory, keys, runtime)
 *   - its own kernel port                  8766 (the installed copy keeps 8765)
 *   - no registry write, no sign-in entry, no tray or background after close
 *   - updates replace the portable file, never run the Setup installer
 *
 * `<home>` is `FRIDAY-Portable-Data` next to the portable file, so the data travels with it. When that folder cannot be
 * written (a read-only stick, Program Files), or the file sits inside a source checkout (the `release\` folder a build
 * writes, which the next build deletes), it is `%LOCALAPPDATA%\FRIDAY-Portable-Data` instead.
 * `FRIDAY_PORTABLE_DATA` names another folder. The FRIDAY folder is, in order: `FRIDAY_PORTABLE_ROOT`, the folder the
 * owner chose inside the portable app, then `<home>\FRIDAY`. `FRIDAY_WORKSPACE_ROOT` (the installed FRIDAY's and the
 * build's variable) and the registry pointer of an installed copy are never used.
 *
 * Everything here is plain functions over `env`, `fs` and `path`, so a test drives it without Electron.
 */
const fs = require("node:fs");
const path = require("node:path");

const HOME_NAME = "FRIDAY-Portable-Data";
const PORTABLE_KERNEL_PORT = 8766;

/** True when this process is the portable launcher's program (electron-builder sets PORTABLE_EXECUTABLE_FILE). */
function isPortable(env = process.env) {
  return String(env.PORTABLE_EXECUTABLE_FILE || "").trim() !== "";
}

function writable(dir, fsImpl = fs) {
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fsImpl.writeFileSync(probe, "");
    fsImpl.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the folder is inside a FRIDAY source checkout (the build writes the EXEs to `release\` there, and the next
 * `npm run build:win` deletes that folder), so data kept beside the file would be wiped by the next build.
 */
function insideCheckout(dir, fsImpl = fs) {
  let current = path.resolve(String(dir || "."));
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      if (
        fsImpl.existsSync(path.join(current, "scripts", "build-windows.cmd")) ||
        fsImpl.existsSync(path.join(current, ".git"))
      ) {
        return true;
      }
    } catch {
      /* an unreadable folder is not a checkout */
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/** Where the portable EXE keeps its data. Null when this is not a portable run. */
function dataHome(env = process.env, fsImpl = fs) {
  if (!isPortable(env)) return null;
  const named = String(env.FRIDAY_PORTABLE_DATA || "").trim();
  if (named) return path.resolve(named);
  const beside = String(
    env.PORTABLE_EXECUTABLE_DIR || path.dirname(String(env.PORTABLE_EXECUTABLE_FILE)),
  ).trim();
  if (beside && !insideCheckout(beside, fsImpl)) {
    const home = path.join(beside, HOME_NAME);
    if (writable(home, fsImpl)) return home;
  }
  const local = String(env.LOCALAPPDATA || env.APPDATA || "").trim();
  return local ? path.join(local, HOME_NAME) : null;
}

/**
 * Points Electron's settings folder at the portable home and tells the rest of the app which FRIDAY folder to use.
 * Must run before the app is ready and before anything reads `userData` or asks for the single-instance lock.
 * Returns `{ portable, home, userData, root }` (`root` is the default FRIDAY folder); `portable` is false (and nothing
 * changes) for an installed run.
 */
function prepare(app, env = process.env, fsImpl = fs) {
  const none = { portable: false, home: "", userData: "", root: "" };
  if (!isPortable(env)) return none;
  const home = dataHome(env, fsImpl);
  if (!home) return { ...none, portable: true };
  const userData = path.join(home, "userData");
  // A FRIDAY_WORKSPACE_ROOT left in the shell (it is how the installed FRIDAY and the build are pointed at a folder)
  // belongs to them: the portable EXE never takes it, and its children do not inherit it. FRIDAY_PORTABLE_ROOT is the
  // portable EXE's own override.
  delete env.FRIDAY_WORKSPACE_ROOT;
  const named = String(env.FRIDAY_PORTABLE_ROOT || "").trim();
  const root = named ? path.resolve(named) : path.join(home, "FRIDAY");
  try {
    fsImpl.mkdirSync(userData, { recursive: true });
    fsImpl.mkdirSync(root, { recursive: true });
  } catch {
    return { ...none, portable: true, home };
  }
  try {
    app.setPath("userData", userData);
    app.setPath("sessionData", userData);
  } catch {
    /* a fake app in a test, or a path Electron refuses: the default stays */
  }
  return { portable: true, home, userData, root };
}

/** The taskbar identity: the portable EXE is not grouped with, or pinned as, the installed FRIDAY. */
function appUserModelId(base, env = process.env) {
  return isPortable(env) ? `${base}.portable` : base;
}

/** True for the file name of a portable build (`FRIDAY-Portable-1.1.5.7.exe`, `FRIDAY-Test-Portable-….exe`). */
function isPortableAsset(name) {
  const n = String(name || "").toLowerCase();
  return n.endsWith(".exe") && n.includes("portable");
}

/**
 * Where an update for the portable EXE goes: next to the running portable file when that folder can be written, else the
 * given fallback folder (the downloads folder of the FRIDAY folder). The running file is never overwritten.
 */
function updateTarget({ file, env = process.env, fallbackDir = "", fsImpl = fs } = {}) {
  const name = path.basename(String(file || ""));
  if (!name) return null;
  const beside = String(
    env.PORTABLE_EXECUTABLE_DIR || path.dirname(String(env.PORTABLE_EXECUTABLE_FILE || "")),
  ).trim();
  const running = String(env.PORTABLE_EXECUTABLE_FILE || "").trim();
  const dirs = [beside, fallbackDir].filter(Boolean);
  for (const dir of dirs) {
    const target = path.join(dir, name);
    if (running && path.resolve(target).toLowerCase() === path.resolve(running).toLowerCase()) {
      return null;
    }
    if (writable(dir, fsImpl)) return target;
  }
  return null;
}

module.exports = {
  HOME_NAME,
  PORTABLE_KERNEL_PORT,
  isPortable,
  dataHome,
  insideCheckout,
  prepare,
  appUserModelId,
  isPortableAsset,
  updateTarget,
};
