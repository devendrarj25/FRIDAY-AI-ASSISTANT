/**
 * Proof of life for a long step that prints nothing.
 *
 * pip, npm, winget and rustup draw their progress bars only on a real console; FRIDAY runs them with their output
 * piped, so a 1 GB download looked like a hung window. This module measures what such a step is doing from the
 * outside (how many bytes appeared in the folders it writes to, and how long it has run) and says so on one line
 * every few seconds: `[friday] pip  still working · 1m20s · 412 MB so far · 5.1 MB/s`. It never touches the step
 * itself, so a measuring failure can only mean fewer lines, never a failed install.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Bytes under `dir`, walking for at most `budgetMs` and `maxFiles` files; a folder that vanishes counts as 0. */
function dirSize(dir, { budgetMs = 400, maxFiles = 60_000 } = {}) {
  const started = Date.now();
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() - started > budgetMs || files > maxFiles) break;
    const here = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(here, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(here, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
          files += 1;
        } catch {
          /* a file that is being replaced */
        }
      }
    }
  }
  return total;
}

/**
 * One number for several folders. `sum` adds them; `max` takes the largest, for a step whose bytes pass through
 * two folders (pip downloads a wheel into its cache and then unpacks it into site-packages, so adding both counts
 * every package twice). The largest of two growing folders still only grows.
 */
function sizeOfAll(dirs, combine = "sum") {
  const sizes = dirs.map((dir) => dirSize(dir));
  return combine === "max" ? Math.max(0, ...sizes) : sizes.reduce((sum, n) => sum + n, 0);
}

function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 1) return `${rest}s`;
  return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

function megabytes(bytes) {
  const value = Number(bytes) / 1024 ** 2;
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/**
 * The line printed for a step that is still running. `grownBytes` is what appeared in the watched folders since
 * the step began, `recentBytes` over the last interval (for the speed). Pure.
 */
function activityText({ elapsedMs, grownBytes = 0, recentBytes = 0, recentMs = 0 }) {
  const parts = [`still working`, duration(elapsedMs)];
  if (grownBytes > 0) parts.push(`${megabytes(grownBytes)} MB so far`);
  // Nothing moved in the window (an unpack or a compile step): no speed, rather than "0.0 MB/s".
  if (recentBytes > 0 && recentMs > 0 && (recentBytes / recentMs) * 1000 >= 0.05 * 1024 ** 2) {
    parts.push(`${megabytes((recentBytes / recentMs) * 1000)} MB/s`);
  }
  return parts.join(" · ");
}

function activityLine({ label, ...rest }) {
  return `[friday] ${String(label).padEnd(14)} ${activityText(rest)}`;
}

/**
 * A ticker for async code. `first` and `every` are in milliseconds; `watch` is a list of folders whose growth is
 * reported. `now`, `size` and `write` are injectable for tests. Returns `{ stop() }`.
 */
function startTicker({
  label,
  watch = [],
  first = 8_000,
  every = 15_000,
  now = Date.now,
  combine = "sum",
  size = (dirs) => sizeOfAll(dirs, combine),
  write = (line) => console.log(line),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const began = now();
  const baseline = watch.length ? size(watch) : 0;
  // A folder walk is time-limited and a download can move between folders (pip's cache, then site-packages), so one
  // reading can be lower than the one before. Only the high-water mark is reported, and the speed is the growth
  // over the last few readings, so a single noisy reading cannot show 246 MB/s or take the total back to 0.2 MB.
  let high = baseline;
  const recent = [{ at: began, bytes: baseline }];
  let timer = null;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const at = now();
    try {
      if (watch.length) high = Math.max(high, size(watch));
    } catch {
      /* measuring is best effort */
    }
    recent.push({ at, bytes: high });
    while (recent.length > 5) recent.shift();
    const from = recent[0];
    const measured = {
      elapsedMs: at - began,
      grownBytes: Math.max(0, high - baseline),
      recentBytes: Math.max(0, high - from.bytes),
      recentMs: at - from.at,
    };
    write(activityLine({ label, ...measured }), activityText(measured));
    timer = setTimer(tick, every);
    timer?.unref?.();
  };
  timer = setTimer(tick, first);
  timer?.unref?.();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
    },
  };
}

/** Folders a Python package install writes to: pip's cache, the environment's packages, winget's download folder. */
function pipWatchDirs(python, env = process.env) {
  const dirs = [];
  const cache =
    env.PIP_CACHE_DIR ||
    (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "pip", "Cache") : "") ||
    (env.HOME ? path.join(env.HOME, ".cache", "pip") : "");
  if (cache) dirs.push(cache);
  if (python) {
    const venv = path.resolve(path.dirname(python), "..");
    dirs.push(path.join(venv, "Lib", "site-packages"));
    dirs.push(path.join(venv, "lib"));
  }
  return dirs;
}

function wingetWatchDirs(env = process.env) {
  const temp = env.TEMP || env.TMPDIR || "";
  return temp ? [path.join(temp, "WinGet")] : [];
}

function npmWatchDirs(env = process.env) {
  if (env.npm_config_cache) return [env.npm_config_cache];
  if (env.LOCALAPPDATA) return [path.join(env.LOCALAPPDATA, "npm-cache")];
  return env.HOME ? [path.join(env.HOME, ".npm")] : [];
}

/** The folders an install of this tool writes to, by the way it installs. */
function watchDirsFor(tool, env = process.env) {
  if (tool?.pip) return pipWatchDirs("", env);
  if (tool?.npm) return npmWatchDirs(env);
  return wingetWatchDirs(env);
}

module.exports = {
  dirSize,
  sizeOfAll,
  duration,
  activityText,
  activityLine,
  startTicker,
  pipWatchDirs,
  wingetWatchDirs,
  npmWatchDirs,
  watchDirsFor,
};
