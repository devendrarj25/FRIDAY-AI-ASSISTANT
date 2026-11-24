/**
 * How long the main process's event loop was blocked, measured with Node's own histogram.
 *
 * "FRIDAY feels stuck" has two possible homes: the page (frames, `perf-governor.ts`) or this process. This answers
 * for this process: p99 and max delay of the loop in milliseconds, no timer of its own work beyond the histogram,
 * and a log line when the loop is blocked for a long stretch so the cause shows in the log instead of in a
 * complaint. Pure apart from the injected `perf_hooks`.
 */
"use strict";

function createLoopLag({
  perfHooks = require("node:perf_hooks"),
  log = () => {},
  warnAtMs = 250,
  onWindow = null,
} = {}) {
  let histogram = null;
  let timer = null;
  let strikes = 0;
  const toMs = (ns) => Math.round((Number(ns) || 0) / 1e6);

  const read = () => {
    if (!histogram) return { p99Ms: 0, maxMs: 0 };
    return { p99Ms: toMs(histogram.percentile(99)), maxMs: toMs(histogram.max) };
  };

  return {
    start(everyMs = 10_000) {
      if (histogram || !perfHooks.monitorEventLoopDelay) return false;
      histogram = perfHooks.monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();
      timer = setInterval(() => {
        const { p99Ms, maxMs } = read();
        // The resource governor rides this window instead of owning a timer (electron/resource-governor.cjs).
        if (typeof onWindow === "function") {
          try {
            const pending = onWindow({ p99Ms, maxMs });
            if (pending && typeof pending.catch === "function") pending.catch(() => undefined);
          } catch {
            /* a listener never stops the measurement */
          }
        }
        // Three blocked windows in a row, not one blip, are worth a line.
        strikes = p99Ms >= warnAtMs ? strikes + 1 : 0;
        if (strikes === 3) {
          log(
            `main process event loop is blocked: p99 ${p99Ms} ms, longest ${maxMs} ms over the last 10 s`,
          );
        }
        histogram.reset();
      }, everyMs);
      timer.unref?.();
      return true;
    },
    read,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      histogram?.disable();
      histogram = null;
    },
  };
}

module.exports = { createLoopLag };
