"use strict";

/**
 * Recover from an unexpected mid-session kernel crash.
 *
 * Deliberate stops (Diagnostics apply-fix, workspace change, app quit) must
 * not trigger this. A broken environment must not loop forever.
 *
 * Backoff: immediate, then 2s, then 8s (three attempts). Attempts only reset
 * after the kernel has stayed healthy for STABLE_MS, so a crash storm still
 * hits the cap.
 */

const DELAYS_MS = Object.freeze([0, 2000, 8000]);
const STABLE_MS = 60_000;
const MAX_ATTEMPTS = DELAYS_MS.length;

function isUnexpectedExit(code, { shutdownStarted = false, expectedStop = false } = {}) {
  if (shutdownStarted || expectedStop) return false;
  return code !== 0 && code !== null;
}

function createKernelAutoRestart(options = {}) {
  const delays = options.delaysMs || DELAYS_MS;
  const maxAttempts = delays.length;
  const stableMs = options.stableMs ?? STABLE_MS;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;

  let attempts = 0;
  let expectedStop = false;
  let givenUp = false;
  let running = false;
  let pending = null;
  let stableTimer = null;
  let idle = Promise.resolve();
  const sequence = [];

  function unref(handle) {
    try {
      handle?.unref?.();
    } catch {
      // Test clocks and some timers have no unref.
    }
    return handle;
  }

  function cancelPending() {
    if (pending !== null) {
      clearTimer(pending);
      pending = null;
    }
  }

  function cancelStable() {
    if (stableTimer !== null) {
      clearTimer(stableTimer);
      stableTimer = null;
    }
  }

  function cancelAll() {
    cancelPending();
    cancelStable();
    running = false;
  }

  function beginExpectedStop() {
    expectedStop = true;
    cancelPending();
  }

  function endExpectedStop() {
    expectedStop = false;
  }

  function noteManualRestart() {
    givenUp = false;
    attempts = 0;
    running = false;
    cancelAll();
  }

  function schedule(code) {
    if (attempts >= maxAttempts) {
      givenUp = true;
      const event = { action: "give-up", attempts, maxAttempts, code };
      sequence.push(event);
      options.onGaveUp?.({ attempts, maxAttempts, code });
      return event;
    }
    const delayMs = delays[attempts] ?? delays[delays.length - 1];
    const attempt = attempts + 1;
    const event = { action: "schedule", attempt, maxAttempts, delayMs, code };
    sequence.push(event);
    options.onAttempt?.({ attempt, maxAttempts, delayMs, code });
    pending = unref(
      setTimer(() => {
        pending = null;
        idle = runAttempt(code).catch(() => {});
      }, delayMs),
    );
    return event;
  }

  async function runAttempt(code) {
    running = true;
    attempts += 1;
    try {
      beginExpectedStop();
      await options.restartKernel();
    } catch {
      // The next waitUntilReady decides whether this attempt counted.
    } finally {
      endExpectedStop();
    }

    let ready = false;
    try {
      ready = Boolean(await options.waitUntilReady());
    } catch {
      ready = false;
    }
    running = false;

    if (ready) {
      const event = { action: "recovered", attempts, maxAttempts, code };
      sequence.push(event);
      options.onRecovered?.({ attempts, maxAttempts, code });
      stableTimer = unref(
        setTimer(() => {
          stableTimer = null;
          attempts = 0;
          givenUp = false;
        }, stableMs),
      );
      return event;
    }

    if (attempts >= maxAttempts) {
      givenUp = true;
      const event = { action: "give-up", attempts, maxAttempts, code };
      sequence.push(event);
      options.onGaveUp?.({ attempts, maxAttempts, code });
      return event;
    }
    return schedule(code);
  }

  function onProcessExit(code, ctx = {}) {
    const unexpected = isUnexpectedExit(code, {
      shutdownStarted: Boolean(ctx.shutdownStarted),
      expectedStop,
    });
    if (!unexpected) {
      const event = {
        action: "ignore",
        code,
        expectedStop,
        shutdownStarted: Boolean(ctx.shutdownStarted),
      };
      sequence.push(event);
      return event;
    }
    if (running) {
      const event = { action: "busy", attempts, code };
      sequence.push(event);
      return event;
    }
    if (givenUp) {
      const event = { action: "given-up", attempts, maxAttempts, code };
      sequence.push(event);
      return event;
    }
    cancelStable();
    return schedule(code);
  }

  return {
    onProcessExit,
    beginExpectedStop,
    endExpectedStop,
    noteManualRestart,
    cancelAll,
    waitIdle: () => idle,
    getState: () => ({ attempts, givenUp, expectedStop, running }),
    getSequence: () => sequence.slice(),
  };
}

module.exports = {
  DELAYS_MS,
  STABLE_MS,
  MAX_ATTEMPTS,
  isUnexpectedExit,
  createKernelAutoRestart,
};
