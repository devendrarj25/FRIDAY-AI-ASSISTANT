"use strict";

/**
 * Second layer of stall protection for the chat.stream IPC bridge.
 *
 * The kernel's HTTP client now has a finite idle read timeout, but the kernel
 * process itself can also wedge (a hung task, a stuck local model server, a
 * bridge socket that never delivers another frame). If that happens the UI has
 * nothing to end the turn, and FRIDAY goes silent forever — the same symptom
 * class as the old never-cleared activeRunId bug.
 *
 * So the bridge keeps its own deadlines:
 *  • FIRST_BYTE_MS  — nothing at all arrived yet (kernel/model never started).
 *  • IDLE_MS        — the stream started and then stopped sending bytes. This
 *                     is an *idle* deadline, reset on every delta, so a long
 *                     legitimate generation is never cut off.
 */

const FIRST_BYTE_MS = 120000; // 2 min to produce the first token
const IDLE_MS = 150000; // 2.5 min of silence mid-stream — above the kernel's 120s read timeout

/**
 * @param {(reason: {kind: "first-byte"|"idle", ms: number, message: string}) => void} onStall
 * @param {{firstByteMs?: number, idleMs?: number, setTimer?: Function, clearTimer?: Function}} [options]
 */
function createStallWatchdog(onStall, options = {}) {
  const firstByteMs = options.firstByteMs ?? FIRST_BYTE_MS;
  const idleMs = options.idleMs ?? IDLE_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;

  let timer = null;
  let stopped = false;
  let sawData = false;

  function fire() {
    if (stopped) return;
    stopped = true;
    timer = null;
    const kind = sawData ? "idle" : "first-byte";
    const ms = sawData ? idleMs : firstByteMs;
    onStall({
      kind,
      ms,
      message: sawData
        ? `timeout: the reply stalled — nothing arrived for ${Math.round(ms / 1000)}s, so the request was cancelled`
        : `timeout: no response within ${Math.round(ms / 1000)}s — the local AI service never answered`,
    });
  }

  function arm(ms) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(fire, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  arm(firstByteMs);

  return {
    /** Call on every byte/frame received — restarts the idle deadline. */
    beat() {
      sawData = true;
      arm(idleMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

module.exports = { createStallWatchdog, FIRST_BYTE_MS, IDLE_MS };
