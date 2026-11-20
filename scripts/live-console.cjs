#!/usr/bin/env node
/**
 * The console look of setup, Doctor and the build: colour that means something, and one live line that moves.
 *
 * Three pieces, each small and testable:
 *
 *  1. `colorize(line)` gives a printed line its colours by what it says (ok green, FAIL red, INFO and NOTE yellow, a
 *     step that is working cyan, the `[friday]` tag dim, banners bold). `installColorConsole()` applies it to
 *     console.log/info/warn/error of a script that prints in plain text, only on a real console that wants colour.
 *
 *  2. `LiveLine` is the line at the bottom of the output that proves a step is alive: a spinner, the name of the step
 *     with a light that sweeps across its letters, and the time, size and speed so far. Any text printed meanwhile
 *     goes above it (the line is erased, the text printed, the line drawn again), so nothing is overwritten and the
 *     bottom line never sits in the middle of the output. It stays out of the way of a live download bar (a board or
 *     a bar touches the shared stamp, electron/activity.cjs) so there is never a bar and a spinner on one row.
 *
 *  3. `runLive` runs a command under that line: the command's output is read, coloured and printed above the line,
 *     and when it ends the line is replaced by one summary (`✔ pip  done in 1m48s · 507 MB`).
 *
 * Off a real console (a log file, CI, NO_COLOR, FRIDAY_ACTIVITY=0) nothing here draws: callers fall back to the plain
 * "still working" lines of scripts/with-activity.cjs, so a log stays readable.
 *
 *   node scripts/live-console.cjs --label "pip" --watch <dir>;<dir> [--combine max] [--cwd <dir>] -- <command> [args]
 */
"use strict";

const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const paint = (code, text) => (text === "" ? text : `${ESC}${code}m${text}${RESET}`);
const dim = (t) => paint("2", t);
const bold = (t) => paint("1", t);
const green = (t) => paint("32", t);
const red = (t) => paint("31", t);
const yellow = (t) => paint("33", t);
const cyan = (t) => paint("36", t);
const magenta = (t) => paint("35", t);
const boldGreen = (t) => paint("1;32", t);
const boldRed = (t) => paint("1;31", t);
const boldCyan = (t) => paint("1;36", t);

/** Colour is wanted on a real console, never with NO_COLOR, never on a dumb terminal; FORCE_COLOR asks for it. */
function colorWanted(stream = process.stdout, env = process.env) {
  if (String(env.NO_COLOR ?? "") !== "") return false;
  if (String(env.FRIDAY_ACTIVITY ?? "") === "0") return false;
  if (String(env.TERM || "") === "dumb") return false;
  if (String(env.FORCE_COLOR ?? "") !== "" && String(env.FORCE_COLOR) !== "0") return true;
  // A step run under a live host is piped, but the host prints to a real console.
  if (String(env.FRIDAY_LIVE_TTY ?? "") === "1") return true;
  return Boolean(stream && stream.isTTY);
}

const hasEscape = (text) => text.includes("\x1b");
/** Cursor movement or an erase: the output redraws a row itself. A colour code alone is just a coloured line. */
const redrawsInPlace = (text) => text.includes("\r") || /\x1b\[[0-9;]*[A-HJKSTf]/.test(text);

/* ------------------------------------------------------------------------------------------------- colour */

const STATUS_WORD = [
  [/^(ok)(\s)/i, (w) => green(w)],
  [/^(PASS)\b/, (w) => boldGreen(w)],
  [/^(FAIL(?:ED)?|MISSING|ACTION REQUIRED|RESTART WINDOWS)\b/, (w) => boldRed(w)],
  [/^(INFO|NOTE|SKIP(?:PED)?|later|OPTIONAL|WARN)\b/i, (w) => yellow(w)],
  [/^(fetching|updating|installing|downloading|pulling|running|checking)\b/i, (w) => cyan(w)],
];

/**
 * The line with colours. A line that already carries colour, or an empty one, is returned as it is. The text is never
 * changed, only wrapped in colour codes, so a log written without colour holds the same words.
 */
function colorize(line) {
  const text = String(line ?? "");
  if (!text.trim() || hasEscape(text)) return text;
  // Banners: the verdict of a whole step.
  if (/\b(SETUP PASS|DOCTOR PASS|TOOLCHAIN PASS|BUILD READY|ready to build)\b/i.test(text)) {
    return boldGreen(text);
  }
  if (/\b(SETUP FAIL|DOCTOR FAIL|BUILD FAILED|FAILED)\b/.test(text) && !/^\s*PASS\b/.test(text)) {
    return boldRed(text);
  }
  if (/^[-=]{10,}\s*$/.test(text)) return dim(text);
  const tagged = /^(\[(?:friday|FRIDAY)\])(\s*)(.*)$/s.exec(text);
  if (tagged) {
    const [, tag, gap, rest] = tagged;
    const upper = tag === "[FRIDAY]";
    // `[FRIDAY] ...` lines are the headline of a stage; `[friday] ...` lines are its details.
    const body = upper ? boldCyan(rest) : colorBody(rest);
    return `${dim(tag)}${gap}${body}`;
  }
  return colorBody(text);
}

function colorBody(text) {
  for (const [pattern, wrap] of STATUS_WORD) {
    const hit = pattern.exec(text);
    if (hit) return `${wrap(hit[1])}${text.slice(hit[1].length)}`;
  }
  // `numpy ok`, `chromadb ok (semantic memory enabled)`: the verdict closes the line.
  const closing = /^(\S[^]*?)(\s+)(ok)(\s.*)?$/.exec(text);
  if (closing && closing[1].length < 40) {
    return `${closing[1]}${closing[2]}${green(closing[3])}${dim(closing[4] ?? "")}`;
  }
  // Table rows: PASS / FAIL / MISSING / SKIPPED in the first column.
  const row = /^(PASS|FAIL|MISSING|SKIPPED|SKIP|WARN)(\s+)(\S.*)$/.exec(text);
  if (row) {
    const word =
      row[1] === "PASS"
        ? boldGreen(row[1])
        : /^SKIP/.test(row[1]) || row[1] === "WARN"
          ? yellow(row[1])
          : boldRed(row[1]);
    return `${word}${row[2]}${row[3]}`;
  }
  return text;
}

/** Colour the output of a plain-text script: console.log/info/warn/error. Returns the function that undoes it. */
function installColorConsole(env = process.env) {
  if (!colorWanted(process.stdout, env)) return () => {};
  const originals = {};
  for (const name of ["log", "info", "warn", "error"]) {
    originals[name] = console[name];
    console[name] = (...args) => {
      if (args.length && typeof args[0] === "string") args[0] = colorize(args[0]);
      return originals[name].apply(console, args);
    };
  }
  return () => {
    for (const name of Object.keys(originals)) console[name] = originals[name];
  };
}

/* ------------------------------------------------------------------------------------------------ live line */

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII = ["|", "/", "-", "\\"];

/** Windows Terminal and every modern console draw the braille spinner; an old console host gets plain ASCII. */
function spinnerFrames(env = process.env) {
  if (String(env.FRIDAY_ASCII ?? "") === "1") return ASCII;
  if (process.platform !== "win32") return BRAILLE;
  return env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON" ? BRAILLE : ASCII;
}

/** The label with one bright letter sweeping across it, so the words themselves look busy. */
function shimmer(label, tick) {
  const text = String(label);
  if (!text.length) return "";
  const at = tick % (text.length + 6);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const d = Math.abs(i - at);
    out +=
      d === 0 ? paint("1;97", text[i]) : d === 1 ? paint("1;96", text[i]) : paint("36", text[i]);
  }
  return out;
}

const clock = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
};

class LiveLine {
  constructor({
    stream = process.stdout,
    env = process.env,
    now = Date.now,
    frames = spinnerFrames(env),
    everyMs = 110,
    boardActive = () => false,
  } = {}) {
    this.stream = stream;
    this.now = now;
    this.frames = frames;
    this.everyMs = everyMs;
    this.boardActive = boardActive;
    this.label = "";
    this.detail = "";
    this.tick = 0;
    this.timer = null;
    this.drawn = false;
    this.paused = false;
    this.started = 0;
  }

  get active() {
    return this.timer !== null;
  }

  start(label) {
    this.label = label;
    this.started = this.now();
    this.paused = false;
    if (!this.timer) {
      this.timer = setInterval(() => this.draw(), this.everyMs);
      this.timer.unref?.();
    }
    this.draw();
  }

  /** The time, size and speed after the label. */
  setDetail(text) {
    this.detail = String(text || "");
  }

  width() {
    const columns =
      Number(this.stream && this.stream.columns) || Number(process.env.FRIDAY_COLUMNS) || 100;
    return Math.max(30, columns - 1);
  }

  frame() {
    const elapsed = clock(this.now() - this.started);
    const spin = cyan(this.frames[this.tick % this.frames.length]);
    const detail = this.detail ? dim(` · ${this.detail}`) : dim(` · ${elapsed}`);
    return `${spin} ${shimmer(this.label, this.tick)}${detail}`;
  }

  erase() {
    if (this.drawn) this.stream.write("\r\x1b[K");
    this.drawn = false;
  }

  draw() {
    if (!this.active) return;
    this.tick += 1;
    // A live download bar or board owns the bottom row right now.
    if (this.paused || this.boardActive()) {
      this.erase();
      return;
    }
    // Cut to the width of the console without counting colour codes: build the plain text first.
    const plainLabel = `${this.frames[0]} ${this.label} · ${this.detail || clock(this.now() - this.started)}`;
    const room = this.width();
    let line = this.frame();
    if (plainLabel.length > room) {
      const keep = Math.max(10, room - 4);
      line = `${cyan(this.frames[this.tick % this.frames.length])} ${shimmer(this.label.slice(0, Math.max(6, keep - 24)), this.tick)}${dim(` · ${(this.detail || clock(this.now() - this.started)).slice(-22)}`)}`;
    }
    this.stream.write(`\r\x1b[K${line}`);
    this.drawn = true;
  }

  /** Print text above the line: erase, print with a newline, draw again. */
  write(text, stream = this.stream) {
    this.erase();
    stream.write(`${text}\n`);
    if (this.active) this.draw();
  }

  /** Output that moves the cursor on its own (a child's own bar): the line steps aside until `resume`. */
  raw(chunk) {
    this.erase();
    this.paused = true;
    this.stream.write(chunk);
  }

  /** The child's bar is over. `closeRow` ends a row left open by a bar so the line starts on a fresh one. */
  resume(closeRow) {
    if (closeRow) this.stream.write("\n");
    this.paused = false;
    if (this.active) this.draw();
  }

  stop(finalLine) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.erase();
    if (finalLine) this.stream.write(`${finalLine}\n`);
  }
}

/* ------------------------------------------------------------------------------------------------ the host */

function formatBytes(bytes) {
  const mb = Number(bytes) / 1024 ** 2;
  if (!(mb > 0)) return "";
  return mb >= 1024
    ? `${(mb / 1024).toFixed(2)} GB`
    : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The closing line of a step: a mark, its name, how long it took and what it moved. */
function summaryLine({ label, ok, ms, bytes, code }) {
  const took = clock(ms);
  const size = formatBytes(bytes);
  if (ok)
    return `${green("✔")} ${bold(label)}${dim(`  done in ${took}${size ? ` · ${size}` : ""}`)}`;
  return `${red("✖")} ${bold(label)}${red(`  failed (exit ${code ?? "none"}) after ${took}`)}`;
}

/**
 * Run `cmd args` with its output coloured above the live line. Resolves to { status, ms }. The command's stdin is the
 * console's, so a prompt still works; its stdout and stderr are read here.
 */
function runLive({
  label,
  watch = [],
  combine = "sum",
  cmd,
  args = [],
  cwd,
  env = process.env,
  stream = process.stdout,
}) {
  return new Promise((resolve) => {
    const win = require("./win-spawn.cjs");
    const activity = require("./electron-module.cjs").load("activity.cjs");
    const live = new LiveLine({ stream, env, boardActive: () => activity.boardIsActive(1500) });
    const started = Date.now();
    const childEnv = {
      ...env,
      FRIDAY_LIVE_TTY: "1",
      FRIDAY_COLUMNS: String(stream.columns || ""),
    };
    const child = win.spawnChild(cmd, args, {
      cwd,
      env: childEnv,
      stdio: ["inherit", "pipe", "pipe"],
    });

    // Sizes come from a worker so a big folder never stalls the spinner.
    let bytes = 0;
    let worker = null;
    if (watch.length) {
      try {
        worker = new Worker(__filename, { workerData: { watch, combine, since: started - 1000 } });
        worker.on("message", (value) => {
          bytes = Math.max(bytes, Number(value) || 0);
        });
        worker.on("error", () => {});
        worker.unref();
      } catch {
        worker = null;
      }
    }
    const ticker = activity.startTicker({
      label,
      watch: watch.length ? watch : [],
      first: 1000,
      every: 1000,
      boardActive: () => false,
      size: () => bytes,
      write: (_line, text) => live.setDetail(String(text).replace(/^still working · /, "")),
    });
    live.start(label);

    let partial = { out: "", err: "" };
    let openRow = false;
    let quiet = null;
    const settle = () => {
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => {
        if (openRow || live.paused) {
          live.resume(openRow);
          openRow = false;
        }
      }, 1200);
    };
    const feed = (kind) => (chunk) => {
      const text = partial[kind] + String(chunk);
      const parts = text.split("\n");
      partial[kind] = parts.pop() ?? "";
      for (const rawLine of parts) {
        const line = rawLine.replace(/\r$/, "");
        if (redrawsInPlace(line)) {
          // The command draws in place (its own bar): let it, and keep the line out of its way.
          live.raw(`${rawLine}\n`);
          openRow = false;
          settle();
        } else {
          if (live.paused) live.resume(false);
          live.write(colorize(line), kind === "err" ? process.stderr : stream);
        }
      }
      if (partial[kind]) {
        // A row the command has not finished (a bar redrawn with \r): pass it through now.
        live.raw(partial[kind]);
        partial[kind] = "";
        openRow = true;
        settle();
      }
    };
    child.stdout?.on("data", feed("out"));
    child.stderr?.on("data", feed("err"));

    const finish = (code, error) => {
      if (quiet) clearTimeout(quiet);
      ticker.stop();
      try {
        worker?.terminate();
      } catch {
        /* already gone */
      }
      if (openRow) live.resume(true);
      const ms = Date.now() - started;
      // One last reading, so the summary holds what the step really wrote and not the reading of a few seconds ago.
      if (watch.length && ms > 1500) {
        try {
          bytes = Math.max(bytes, activity.sizeOfAll(watch, combine, started - 1000));
        } catch {
          /* the summary then shows the last reading */
        }
      }
      const ok = code === 0 && !error;
      // A step that finished at once needs no summary: it would only add a line.
      live.stop(ms > 1500 || !ok ? summaryLine({ label, ok, ms, bytes, code }) : "");
      resolve({ status: code === null || code === undefined ? 1 : code, ms, error });
    };
    child.on("error", (error) => {
      process.stderr.write(`[friday] ${label}: ${error.message}\n`);
      finish(1, error);
    });
    child.on("close", (code) => finish(code));
  });
}

/* ------------------------------------------------------------------------------------------------- the worker */

if (!isMainThread && workerData && Array.isArray(workerData.watch)) {
  const activity = require("./electron-module.cjs").load("activity.cjs");
  const measure = () => {
    try {
      parentPort.postMessage(
        activity.sizeOfAll(workerData.watch, workerData.combine, workerData.since),
      );
    } catch {
      /* a failed reading means a smaller number, never a failed step */
    }
  };
  measure();
  setInterval(measure, 2500);
}

function main(argv) {
  const split = argv.indexOf("--");
  const options = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  if (!command.length) {
    console.error(
      'usage: node scripts/live-console.cjs --label "<name>" [--watch <dir>;<dir>] -- <command> [args]',
    );
    process.exit(2);
  }
  const value = (flag) => {
    const at = options.indexOf(flag);
    return at === -1 ? "" : options[at + 1] || "";
  };
  const [cmd, ...args] = command;
  void runLive({
    label: value("--label") || path.basename(cmd),
    watch: value("--watch")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.resolve(dir)),
    combine: value("--combine") === "max" ? "max" : "sum",
    cmd,
    args,
    cwd: value("--cwd") || undefined,
  }).then(({ status }) => process.exit(status));
}

if (require.main === module && isMainThread) main(process.argv.slice(2));

module.exports = {
  colorWanted,
  colorize,
  redrawsInPlace,
  installColorConsole,
  spinnerFrames,
  shimmer,
  LiveLine,
  runLive,
  summaryLine,
  formatBytes,
  clock,
};
