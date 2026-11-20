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
function startTickerProcess({
  label,
  watch = [],
  first = 8_000,
  every = 15_000,
  combine = "sum",
} = {}) {
  if (off()) return { stop() {} };
  let child = null;
  try {
    child = spawn(
      process.execPath,
      [
        __filename,
        "--ticker",
        label,
        watch.join(path.delimiter),
        String(first),
        String(every),
        combine,
      ],
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

/** A real console that wants the live line (colour, a moving spinner). A log file, CI or NO_COLOR gets plain lines. */
function liveWanted(env = process.env, stream = process.stdout) {
  if (off()) return false;
  if (String(env.FRIDAY_LIVE_LINE ?? "") === "0") return false;
  return require("./live-console.cjs").colorWanted(stream, env) && Boolean(stream && stream.isTTY);
}

/**
 * Run `cmd args` and return its { status, error } like spawnSync. On a real console the command runs under the live
 * line of scripts/live-console.cjs (colour, a spinner, the time, size and speed, one summary line at the end); anywhere
 * else it runs as before with a "still working" line every few seconds.
 */
function withActivityCommand(label, watch, cmd, args, spawnOptions = {}, timing = {}) {
  const win = require("./win-spawn.cjs");
  if (liveWanted()) {
    const hostArgs = [
      path.join(__dirname, "live-console.cjs"),
      "--label",
      label,
      "--watch",
      (watch || []).join(path.delimiter),
      "--combine",
      timing.combine === "max" ? "max" : "sum",
      ...(spawnOptions.cwd ? ["--cwd", spawnOptions.cwd] : []),
      "--",
      cmd,
      ...args,
    ];
    return win.spawnDirect(process.execPath, hostArgs, {
      stdio: "inherit",
      ...(spawnOptions.env ? { env: spawnOptions.env } : {}),
    });
  }
  const run = () =>
    /^npm(\.cmd)?$/i.test(path.basename(String(cmd)))
      ? win.spawnNpm(args, { stdio: "inherit", ...spawnOptions })
      : win.spawnDirect(cmd, args, { stdio: "inherit", ...spawnOptions });
  return withActivity(label, watch, run, timing);
}

function main(argv) {
  if (argv[0] === "--ticker") {
    const [, label, watchText, first, every, combine] = argv;
    core.startTicker({
      label,
      watch: watchText ? watchText.split(path.delimiter).filter(Boolean) : [],
      first: Number(first) || 8_000,
      every: Number(every) || 15_000,
      combine: combine === "max" ? "max" : "sum",
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
  const timing = {};
  if (value("--first")) timing.first = Number(value("--first"));
  if (value("--every")) timing.every = Number(value("--every"));
  void win;
  const result = withActivityCommand(label, watch, cmd, args, {}, timing);
  if (result.error) {
    console.error(`[friday] ${label}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  withActivity,
  withActivityCommand,
  liveWanted,
  startTickerProcess,
  pipWatchDirs: core.pipWatchDirs,
  wingetWatchDirs: core.wingetWatchDirs,
};
