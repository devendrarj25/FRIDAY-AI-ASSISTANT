/**
 * FRIDAY · cursor tracker
 *
 * Reads the real cursor position from Electron's screen API. It only runs
 * while something is subscribed (gaze tracking or "follow mouse" placement),
 * throttles to a display-friendly cadence and publishes only on real
 * movement, so an idle desktop costs nothing.
 */
const { screen } = require("electron");

class MouseTracker {
  constructor(intervalMs = 60) {
    this.intervalMs = intervalMs;
    this.timer = null;
    this.listeners = new Set();
    this.last = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    this.start();
    if (this.last) fn(this.last);
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.stop();
    };
  }

  snapshot() {
    return this.last;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    let point = null;
    try {
      point = screen.getCursorScreenPoint();
    } catch {
      return;
    }
    if (this.last && this.last.x === point.x && this.last.y === point.y) return;
    this.last = { x: point.x, y: point.y, at: Date.now() };
    const value = this.last;
    this.listeners.forEach((fn) => {
      try {
        fn(value);
      } catch {
        /* keep the remaining listeners alive */
      }
    });
  }
}

module.exports = { MouseTracker };
