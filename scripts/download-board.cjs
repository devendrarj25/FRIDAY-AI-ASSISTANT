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
  constructor({ stream = process.stdout, tty, now = Date.now, intervalMs = 100, log } = {}) {
    this.stream = stream;
    this.tty = tty ?? Boolean(stream && stream.isTTY);
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

  draw(force = false) {
    if (!this.tty || this.stopped) return;
    const at = this.now();
    if (!force && at - this.lastDraw < this.intervalMs) return;
    this.lastDraw = at;
    const lines = [
      ...this.order.map((id) => renderRow(this.rows.get(id))),
      renderOverall(this.total()),
    ];
    this.clear();
    this.stream.write(lines.map((line) => `${line}\x1b[K`).join("\n") + "\n");
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

module.exports = { DownloadBoard, renderRow, renderOverall, mb, clock };
