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
 *
 * A spoken turn has a third, much shorter deadline, per candidate model:
 *  • FIRST_DELTA    — the first words of the answer. A frame that carries no
 *                     words (the kernel's "ready" frame) is proof of life, not
 *                     progress: it neither moves nor ends this deadline. On a miss
 *                     the caller closes that socket and tries the next model, so a
 *                     slow first model costs seconds, not minutes of silence.
 */

const FIRST_BYTE_MS = 120000; // 2 min to produce the first token
const IDLE_MS = 150000; // 2.5 min of silence mid-stream — above the kernel's 120s read timeout
/** Spoken turn: the first words, from a model that is already loaded (a cloud model answers sooner). */
const FIRST_DELTA_CLOUD_MS = 15000;
const FIRST_DELTA_WARM_MS = 20000;
/** Spoken turn: the model is not loaded yet, so the load itself is part of the wait. */
const FIRST_DELTA_COLD_MS = 60000;

/**
 * How long a spoken turn waits for the first words of one candidate model; 0 means no such deadline (typed chat, and
 * every non-spoken request, keep the long first-byte limit above).
 * @param {{surface?: string, model?: {type?: string}, coldLoad?: boolean}} input
 */
function firstDeltaDeadlineMs({ surface, model, coldLoad = false } = {}) {
  if (surface !== "voice") return 0;
  if (model?.type !== "local") return FIRST_DELTA_CLOUD_MS;
  return coldLoad ? FIRST_DELTA_COLD_MS : FIRST_DELTA_WARM_MS;
}

/**
 * @param {(reason: {kind: "first-byte"|"first-delta"|"idle", ms: number, message: string}) => void} onStall
 * @param {{firstByteMs?: number, idleMs?: number, firstDeltaMs?: number, setTimer?: Function, clearTimer?: Function}} [options]
 *   `firstDeltaMs` (a spoken turn) arms the first-words deadline instead of the first-byte one.
 */
function createStallWatchdog(onStall, options = {}) {
  const firstByteMs = options.firstByteMs ?? FIRST_BYTE_MS;
  const idleMs = options.idleMs ?? IDLE_MS;
  const firstDeltaMs = options.firstDeltaMs > 0 ? options.firstDeltaMs : 0;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;

  let timer = null;
  let stopped = false;
  let sawData = false;
  let sawWords = false;

  function fire() {
    if (stopped) return;
    stopped = true;
    timer = null;
    if (firstDeltaMs && !sawWords) {
      onStall({
        kind: "first-delta",
        ms: firstDeltaMs,
        message: `timeout: no first words within ${Math.round(firstDeltaMs / 1000)}s — this model was too slow to start, so the next one is tried`,
      });
      return;
    }
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

  arm(firstDeltaMs || firstByteMs);

  return {
    /**
     * Call on every byte/frame received — restarts the idle deadline. With a first-words deadline, a frame that is not
     * words (the "ready" frame) does not count: that deadline keeps running until `progress()`.
     */
    beat() {
      sawData = true;
      if (firstDeltaMs && !sawWords) return;
      arm(idleMs);
    },
    /** Call when the first words (or a tool notice) arrive: the first-words deadline is met, the idle one takes over. */
    progress() {
      sawData = true;
      sawWords = true;
      arm(idleMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

module.exports = {
  createStallWatchdog,
  firstDeltaDeadlineMs,
  FIRST_BYTE_MS,
  IDLE_MS,
  FIRST_DELTA_CLOUD_MS,
  FIRST_DELTA_WARM_MS,
  FIRST_DELTA_COLD_MS,
};
