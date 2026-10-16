/**
 * Debug-only main-process stall counter. It starts only when FRIDAY_DEBUG=1.
 * A stall is a turn of the interval that arrives more than 100ms late.
 */
const fs = require("node:fs");
const path = require("node:path");

function startEventLoopLag({ file, intervalMs = 500, stallMs = 100 } = {}) {
  let expected = Date.now() + intervalMs;
  let stalls = 0;
  let max = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + intervalMs;
    if (lag < stallMs) return;
    stalls += 1;
    if (lag > max) max = lag;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ at: now, lag, stalls, max })}\n`);
    } catch {
      /* the counter still updates when the log cannot be written */
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
    snapshot() {
      return { stalls, max, stallMs };
    },
  };
}

module.exports = { startEventLoopLag };
