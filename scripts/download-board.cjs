/**
 * The live download board: one row for every file that is queued, running or finished, and one line for the whole
 * step (how many are done, how much of the total has arrived, the speed of the line, the time left).
 *
 * In a terminal the rows are redrawn in place about ten times a second, so the bars move smoothly even with two
 * downloads side by side; any other message is printed above the board without breaking it. Anywhere else (a log
 * file, a CI run) there is no redrawing: a line per ten percent of each file and one overall line per finished file.
 */
"use strict";

const BAR = 24;
const mb = (bytes) => {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  return `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
};
const clock = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
};
const bar = (fraction) => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * BAR);
  return `${"#".repeat(filled)}${"-".repeat(BAR - filled)}`;
};

/** ANSI colours for a terminal board. NO_COLOR turns them off; FORCE_COLOR turns them on. */
function colourWanted(stream, env = process.env) {
  if (String(env.NO_COLOR ?? "") !== "") return false;
  if (String(env.FORCE_COLOR ?? "") !== "" && String(env.FORCE_COLOR) !== "0") return true;
  if (String(env.TERM || "") === "dumb") return false;
  return Boolean(stream && stream.isTTY);
}
const paintWith = (code) => (text) => (text === "" ? text : `\x1b[${code}m${text}\x1b[0m`);
const dim = paintWith("2");
const bold = paintWith("1");
const red = paintWith("31");
const green = paintWith("32");
const yellow = paintWith("33");
const blue = paintWith("34");
const magenta = paintWith("35");
const cyan = paintWith("36");

/**
 * Colour a line that has already been cut to the terminal width (so the width never counts the colour codes):
 * the bar in the colour of its state, sizes in blue, speed in magenta, time left in yellow, FAILED in red.
 */
function paint(line, state = "running") {
  const barColour = state === "failed" ? red : state === "done" ? green : cyan;
  return line
    .replace(/^\[friday\]/, dim("[friday]"))
    .replace(/\[([#!]*)(-*)\]/, (_all, filled, rest) => `[${barColour(filled)}${dim(rest)}]`)
    .replace(/FAILED/, red(bold("FAILED")))
    .replace(/waiting/, yellow("waiting"))
    .replace(
      /(\d+(?:\.\d+)? (?:MB|GB))\/(\d+(?:\.\d+)? (?:MB|GB))/,
      (_all, a, b) => `${blue(a)}/${blue(b)}`,
    )
    .replace(/(\d+(?:\.\d+)? MB\/s)/g, (v) => magenta(v))
    .replace(/(\d+m?\d*s left)/, (v) => yellow(v))
    .replace(/ (\d+)%/, (_all, n) => ` ${Number(n) === 100 ? green(`${n}%`) : bold(`${n}%`)}`)
    .replace(/(\d+\/\d+ ready)/, (v) => bold(v))
    .replace(/(ready|average in \d+s|in \d+m?\d*s)\s*$/, (v) => (state === "done" ? green(v) : v));
}

/** One row. `row` is { id, state, percent, bytesDone, bytesTotal, speed, eta, connections, note, seconds }. */
function renderRow(row, idWidth = 16) {
  const id = String(row.id).padEnd(idWidth);
  if (row.state === "queued") return `[friday] ${id} [${"-".repeat(BAR)}]   0%  waiting`;
  if (row.state === "done")
    return `[friday] ${id} [${bar(1)}] 100%  ${row.note || "ready"}${row.seconds ? `  in ${clock(row.seconds)}` : ""}`;
  if (row.state === "failed")
    return `[friday] ${id} [${"!".repeat(BAR)}] FAILED  ${row.note || ""}`;
  const percent = Math.max(0, Math.min(100, Math.round(row.percent || 0)));
  const size = row.bytesTotal > 0 ? `  ${mb(row.bytesDone)}/${mb(row.bytesTotal)}` : "";
  const speed = row.speed > 0 ? `  ${row.speed.toFixed(1)} MB/s` : "";
  const eta = row.eta > 0 ? `  ${clock(row.eta)} left` : "";
  const conns = row.connections > 0 ? `  ${row.connections} conn` : "";
  return `[friday] ${id} [${bar(percent / 100)}] ${String(percent).padStart(3)}%${size}${speed}${eta}${conns}`;
}

/** The whole-step line. */
function renderOverall(total) {
  const percent = total.bytesTotal > 0 ? total.bytesDone / total.bytesTotal : 0;
  const speed = total.speed > 0 ? `  ${total.speed.toFixed(1)} MB/s` : "";
  const left =
    total.speed > 0 && total.bytesTotal > total.bytesDone
      ? `  ${clock((total.bytesTotal - total.bytesDone) / 1024 ** 2 / total.speed)} left`
      : "";
  return `[friday] ${"ALL".padEnd(16)} [${bar(percent)}] ${String(Math.round(percent * 100)).padStart(3)}%  ${total.done}/${total.count} ready  ${mb(total.bytesDone)}/${mb(total.bytesTotal)}${speed}${left}  elapsed ${clock(total.elapsed)}`;
}

class DownloadBoard {
  constructor({
    stream = process.stdout,
    tty,
    now = Date.now,
    intervalMs = 250,
    log,
    color,
    env,
  } = {}) {
    this.stream = stream;
    this.tty = tty ?? Boolean(stream && stream.isTTY);
    this.color = color ?? (this.tty && colourWanted(stream, env || process.env));
    this.now = now;
    this.intervalMs = intervalMs;
    this.log = log || ((line) => stream.write(`${line}\n`));
    this.rows = new Map();
    this.order = [];
    this.started = now();
    this.drawn = 0;
    this.lastDraw = 0;
    this.lastBucket = new Map();
    this.timer = null;
    this.stopped = false;
  }

  /** Announce the plan: [{ id, approxBytes }] in the order they will run. */
  start(planned) {
    this.started = this.now();
    for (const item of planned) {
      this.order.push(item.id);
      this.rows.set(item.id, {
        id: item.id,
        state: "queued",
        approx: Number(item.approxBytes) || 0,
        bytesDone: 0,
        bytesTotal: 0,
        percent: 0,
        speed: 0,
        eta: 0,
        connections: 0,
        startedAt: 0,
      });
    }
    if (this.tty) {
      this.timer = setInterval(() => this.draw(), this.intervalMs);
      this.timer.unref?.();
      this.draw(true);
    } else {
      this.log(
        `[friday] download plan (${this.order.length}): ${this.order
          .map((id) => `${id} ${mb(this.rows.get(id).approx)}`)
          .join(", ")}`,
      );
    }
  }

  total() {
    let bytesDone = 0;
    let bytesTotal = 0;
    let speed = 0;
    let done = 0;
    for (const row of this.rows.values()) {
      const size = row.bytesTotal || row.approx;
      bytesTotal += size;
      if (row.state === "done") {
        bytesDone += size;
        done += 1;
      } else if (row.state === "running") {
        bytesDone += Math.min(row.bytesDone, size);
        speed += row.speed;
      } else if (row.state === "failed") {
        done += 1;
      }
    }
    return {
      done,
      count: this.rows.size,
      bytesDone,
      bytesTotal,
      speed,
      elapsed: (this.now() - this.started) / 1000,
    };
  }

  /** A progress event from one download. */
  update(id, event) {
    const row = this.rows.get(id);
    if (!row || row.state === "done" || row.state === "failed") return;
    if (event?.progress == null && !(event?.bytesDone > 0)) return;
    if (row.state === "queued") {
      row.state = "running";
      row.startedAt = this.now();
    }
    row.percent = event.progress == null ? row.percent : Number(event.progress);
    row.bytesDone = Number(event.bytesDone) || row.bytesDone;
    row.bytesTotal = Number(event.bytesTotal) || row.bytesTotal;
    row.speed = Number(event.speedMbps) || 0;
    row.eta = Number(event.etaSeconds) || 0;
    row.connections = Number(event.connections) || 0;
    if (!this.tty) {
      const bucket = Math.floor(Math.max(0, Math.min(100, row.percent)) / 10);
      if (bucket > (this.lastBucket.get(id) ?? -1)) {
        this.lastBucket.set(id, bucket);
        this.log(renderRow(row));
      }
    }
  }

  /** A download finished. `bytes` is what arrived (0 when it was already on disk). */
  finish(id, { ok, note = "", bytes = 0 }) {
    const row = this.rows.get(id);
    if (!row) return;
    row.state = ok ? "done" : "failed";
    row.note = note;
    if (bytes > 0) row.bytesTotal = bytes;
    row.seconds = row.startedAt ? (this.now() - row.startedAt) / 1000 : 0;
    if (!this.tty) {
      this.log(renderRow(row));
      this.log(renderOverall(this.total()));
    } else {
      this.draw(true);
    }
  }

  /** Any other message: printed above the board in a terminal, as a plain line elsewhere. */
  say(line) {
    if (!this.tty || this.stopped) return this.log(line);
    this.clear();
    this.stream.write(`${line}\n`);
    this.draw(true);
  }

  clear() {
    if (this.drawn > 0) this.stream.write(`\x1b[${this.drawn}A\x1b[J`);
    this.drawn = 0;
  }

  /** Columns of the terminal right now (it can be resized while a download runs). */
  width() {
    const columns = Number(this.stream && this.stream.columns);
    return columns > 20 ? columns : 100;
  }

  /**
   * The lines to draw. Every line is cut to the terminal width, because a line that wraps takes two rows and
   * the cursor then moves up one row too few, leaving a stale copy of the first row behind on every redraw.
   * When the board is taller than the terminal can hold, only the running and failed rows and the overall line
   * are drawn, so the cursor can always reach the top.
   */
  frame() {
    const rows = this.order.map((id) => this.rows.get(id));
    const high = Number(this.stream && this.stream.rows) || 0;
    const room = high > 6 ? high - 3 : Infinity;
    let shown = rows;
    if (rows.length + 1 > room) {
      shown = rows
        .filter((row) => row.state === "running" || row.state === "failed")
        .slice(0, room - 2);
    }
    const fit = this.width() - 1;
    const cut = (line) => (line.length > fit ? line.slice(0, fit) : line);
    const lines = shown.map((row) => {
      const plain = cut(renderRow(row));
      return this.color ? paint(plain, row.state) : plain;
    });
    const overall = cut(renderOverall(this.total()));
    lines.push(this.color ? paint(overall, "running") : overall);
    return lines;
  }

  /**
   * Redraw in place: go up to the first row, overwrite each row and clear only the rest of that row (no screen
   * wipe, so there is no flicker), and erase below only when the board got shorter.
   */
  draw(force = false) {
    if (!this.tty || this.stopped) return;
    const at = this.now();
    if (!force && at - this.lastDraw < this.intervalMs) return;
    this.lastDraw = at;
    const lines = this.frame();
    let out = this.drawn > 0 ? `\x1b[${this.drawn}A` : "";
    out += lines.map((line) => `${line}\x1b[K`).join("\n") + "\n";
    if (this.drawn > lines.length) out += "\x1b[J";
    this.stream.write(out);
    this.drawn = lines.length;
  }

  /** Leave the final state on screen and stop redrawing. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.tty) this.draw(true);
    else this.log(renderOverall(this.total()));
    this.stopped = true;
  }
}

module.exports = { DownloadBoard, renderRow, renderOverall, mb, clock, paint, colourWanted };
