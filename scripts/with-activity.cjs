#!/usr/bin/env node
/**
 * Proof of life for the long, silent steps of setup, doctor and the build (see electron/activity.cjs).
 *
 *   node scripts/with-activity.cjs --label "npm ci" --watch node_modules -- npm ci --no-audit --no-fund
 *   (--first and --every, in milliseconds, change when the first line and the next ones print)
 *
 * runs the command with its output untouched and, beside it, prints `still working · 1m20s · 412 MB so far · 5 MB/s`
 * every few seconds, so a console that shows nothing for minutes is not mistaken for a hung one. From code:
 * `withActivity(label, folders, () => spawnSync(...))` does the same around a synchronous call. The exit code is the
 * command's own. FRIDAY_ACTIVITY=0 turns the lines off.
 */
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const core = require("./electron-module.cjs").load("activity.cjs");

const off = () => process.env.FRIDAY_ACTIVITY === "0";

/** Start the ticker as its own process (a synchronous call blocks this one). Returns `{ stop() }`. */
function startTickerProcess({ label, watch = [], first = 8_000, every = 15_000 } = {}) {
  if (off()) return { stop() {} };
  let child = null;
  try {
    child = spawn(
      process.execPath,
      [__filename, "--ticker", label, watch.join(path.delimiter), String(first), String(every)],
      { stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
    );
    child.on("error", () => {});
  } catch {
    child = null;
  }
  return {
    stop() {
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/** Run a synchronous step with a ticker beside it. The step's own result is returned. */
function withActivity(label, watch, step, timing = {}) {
  const ticker = startTickerProcess({ label, watch, ...timing });
  try {
    return step();
  } finally {
    ticker.stop();
  }
}

function main(argv) {
  if (argv[0] === "--ticker") {
    const [, label, watchText, first, every] = argv;
    core.startTicker({
      label,
      watch: watchText ? watchText.split(path.delimiter).filter(Boolean) : [],
      first: Number(first) || 8_000,
      every: Number(every) || 15_000,
    });
    // The ticker's timers are unref'd for library use; this process exists only to tick, so keep it alive.
    setInterval(() => {}, 1 << 30);
    return;
  }
  const split = argv.indexOf("--");
  const options = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  if (!command.length) {
    console.error(
      'usage: node scripts/with-activity.cjs --label "<name>" [--watch <dir>;<dir>] -- <command> [args]',
    );
    process.exit(2);
  }
  const value = (flag) => {
    const at = options.indexOf(flag);
    return at === -1 ? "" : options[at + 1] || "";
  };
  const label = value("--label") || path.basename(command[0]);
  const watch = value("--watch")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.resolve(dir));
  const win = require("./win-spawn.cjs");
  const [cmd, ...args] = command;
  const run = () =>
    /^npm(\.cmd)?$/i.test(cmd)
      ? win.spawnNpm(args, { stdio: "inherit" })
      : win.spawnDirect(cmd, args, { stdio: "inherit" });
  const timing = {};
  if (value("--first")) timing.first = Number(value("--first"));
  if (value("--every")) timing.every = Number(value("--every"));
  const result = withActivity(label, watch, run, timing);
  if (result.error) {
    console.error(`[friday] ${label}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  withActivity,
  startTickerProcess,
  pipWatchDirs: core.pipWatchDirs,
  wingetWatchDirs: core.wingetWatchDirs,
};
