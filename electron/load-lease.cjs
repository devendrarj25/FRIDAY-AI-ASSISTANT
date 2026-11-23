/**
 * Load leases: the one step every heavy model load takes before it starts (electron/resource-governor.cjs).
 *
 * A caller describes what the load needs (video memory and RAM, best option first, smaller ones after) and how
 * important the turn is (voice, chat, background, prefetch). The governor answers granted (possibly with a smaller
 * option and its hint), queued or refused. This module turns that answer into something a turn can act on without
 * ever hanging: a queued request waits a short, bounded time and then counts as refused, and a refusal carries one
 * plain line for the owner. With no governor, no sizes, or any failure here, the answer is "none" and the caller
 * loads exactly as it did before (nothing in this file can stop a load by throwing).
 *
 * Pure apart from the governor handed in, so every path is tested without Electron.
 */
"use strict";

/** How long a request may wait in the governor's queue before it counts as refused (ms), by priority. */
const QUEUE_WAIT_MS = { voice: 300, chat: 3000, background: 0, prefetch: 0 };
/** How long a load may wait for the model-load slot before it is given up (ms), by priority. */
const SLOT_WAIT_MS = { voice: 300, chat: 5000, background: 0, prefetch: 0 };
/** The most a voice request waits for the governor to decide, queue included (the voice budget is 800 ms end to end). */
const VOICE_BOUND_MS = 300;
/** A lease for a model that stays resident is released when its holder is gone (`alive`), not by a heartbeat. */
const RESIDENT_TTL_MS = 24 * 60 * 60 * 1000;

const REASONS = {
  "memory-critical": "memory is critically low",
  "queue-full": "other loads are already waiting",
  "no-room": "there is no room for it right now",
  waited: "memory did not free up in time",
  "deferred-lag": "FRIDAY is busy",
  "deferred-pressure": "the PC is short of memory",
  "deferred-power": "the PC is saving power",
};

const mb = (gb) => {
  const n = Number(gb);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1024) : 0;
};

/** Options in GB (`vramGb`, `ramGb`, `hint`) as the governor wants them in MB; entries with no size are dropped. */
function toOptions(list) {
  return (Array.isArray(list) ? list : [])
    .map((o) => ({
      vramMb: mb(o?.vramGb),
      ramMb: mb(o?.ramGb),
      hint: o?.hint ?? null,
    }))
    .filter((o) => o.vramMb > 0 || o.ramMb > 0);
}

const NOT_IN_TIME = Symbol("not in time");

/**
 * Wait for the governor's answer at most `ms`. A grant that lands after that is handed back (nobody holds it), a
 * queued request is cancelled; the caller gets NOT_IN_TIME and loads as before.
 */
function boundedForVoice(asked, ms) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(NOT_IN_TIME), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(asked), late]).then((answer) => {
    clearTimeout(timer);
    if (answer === NOT_IN_TIME) {
      Promise.resolve(asked).then(
        (after) => {
          try {
            if (after?.state === "granted") after.lease?.release?.();
            else if (after?.state === "queued") after.cancel?.();
          } catch {
            /* already gone */
          }
        },
        () => {},
      );
    }
    return answer;
  });
}

/** One plain line for a refusal: what could not load and why, with no jargon. */
function refusalLine(label, reason) {
  const why =
    REASONS[reason] || REASONS[String(reason).replace(/^deferred-.*/, "deferred-pressure")];
  return `${label || "The model"} was not loaded: ${why || "the PC has no room for it right now"}.`;
}

const none = () => ({
  state: "none",
  lease: null,
  hint: null,
  shrunk: false,
  reason: null,
  line: null,
});

function createLoadLeases({
  governor = null,
  log = () => {},
  notify = () => {},
  voiceBoundMs = VOICE_BOUND_MS,
} = {}) {
  const enabled = Boolean(governor && typeof governor.acquire === "function");

  const say = (line) => {
    try {
      notify(line);
    } catch {
      /* the line is a courtesy */
    }
  };

  /**
   * Ask for memory. Resolves one of:
   *   none     no governor, nothing sized, or the governor failed: load as before
   *   granted  `lease` (call lease.release() when the model is gone), `hint` and `shrunk` when a smaller option fit
   *   refused  `reason` and `line` (already sent to the owner): do not load this model now
   */
  async function acquire(spec = {}) {
    if (!enabled) return none();
    const options = toOptions(spec.options);
    if (!options.length) return none();
    const priority = Object.hasOwn(QUEUE_WAIT_MS, spec.priority) ? spec.priority : "background";
    const waitMs = Number.isFinite(spec.waitMs)
      ? Math.max(0, spec.waitMs)
      : QUEUE_WAIT_MS[priority];
    const label = String(spec.label || spec.owner || "The model");
    const started = Date.now();
    let answer;
    try {
      const asked = governor.acquire({
        owner: String(spec.owner || label),
        kind: String(spec.kind || "model"),
        priority,
        options,
        queue: waitMs > 0,
        ttlMs: Number(spec.ttlMs) > 0 ? Number(spec.ttlMs) : RESIDENT_TTL_MS,
        ...(typeof spec.alive === "function" ? { alive: spec.alive } : {}),
        ...(typeof spec.onPause === "function" ? { onPause: spec.onPause } : {}),
        ...(typeof spec.onResume === "function" ? { onResume: spec.onResume } : {}),
        ...(typeof spec.onCancel === "function" ? { onCancel: spec.onCancel } : {}),
        ...(spec.preempt === "cancel" ? { preempt: "cancel" } : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
      });
      answer = priority === "voice" ? await boundedForVoice(asked, voiceBoundMs) : await asked;
    } catch (error) {
      log(
        `load lease: the governor failed (${String(error?.message || error)}); loading as before`,
      );
      return none();
    }
    // Voice never waits long, and "none" from the governor (it was busy) means load as before.
    if (answer === NOT_IN_TIME || answer?.state === "none") return none();
    if (answer?.state === "queued" && answer.wait) {
      const left =
        priority === "voice"
          ? Math.max(0, Math.min(waitMs, voiceBoundMs - (Date.now() - started)))
          : waitMs;
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), left);
        timer.unref?.();
      });
      const first = await Promise.race([answer.wait, timeout]);
      clearTimeout(timer);
      if (first === "timeout") {
        try {
          answer.cancel?.();
        } catch {
          /* already settled */
        }
        // A grant may have landed in the same instant the wait ran out: honour it rather than waste it.
        answer = await answer.wait;
        if (answer?.state !== "granted") answer = { state: "refused", reason: "waited" };
      } else {
        answer = first;
      }
    }
    if (answer?.state === "granted" && answer.lease) {
      const lease = answer.lease;
      if (lease.shrunk) log(`load lease: ${label} fits only as "${lease.hint ?? "smaller"}"`);
      return {
        state: "granted",
        lease,
        hint: lease.hint ?? null,
        shrunk: Boolean(lease.shrunk),
        reason: null,
        line: null,
      };
    }
    const reason = String(answer?.reason || answer?.state || "no-room");
    const line = refusalLine(label, reason);
    log(`load lease: ${label} refused (${reason})`);
    say(line);
    return { state: "refused", lease: null, hint: null, shrunk: false, reason, line };
  }

  /**
   * Run the load itself inside the governor's model-load cap (one at a time, voice first). Resolves
   * `{ ran: true, value }`, or `{ ran: false, reason }` when it waited too long or the queue was full, so the caller
   * can degrade (skip the model, or load anyway when it must never block). A load that has started is never
   * abandoned and its own errors pass through.
   */
  async function runLoad(priority, fn, { waitMs } = {}) {
    if (!enabled || typeof governor.run !== "function") return { ran: true, value: await fn() };
    const rank = Object.hasOwn(SLOT_WAIT_MS, priority) ? priority : "background";
    const limit = Number.isFinite(waitMs) ? Math.max(0, waitMs) : SLOT_WAIT_MS[rank];
    const controller = new AbortController();
    let started = false;
    const timer = setTimeout(() => {
      if (!started) controller.abort();
    }, limit);
    timer.unref?.();
    try {
      const value = await governor.run(
        "modelLoad",
        async () => {
          started = true;
          clearTimeout(timer);
          return fn();
        },
        { priority: rank, signal: controller.signal },
      );
      return { ran: true, value };
    } catch (error) {
      if (started) throw error;
      const code = error && typeof error === "object" ? error.code : null;
      if (code === "CANCELLED" || code === "QUEUE_FULL") {
        log(`load lease: a model load was not started (${code})`);
        return { ran: false, reason: code === "QUEUE_FULL" ? "queue-full" : "waited" };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return { enabled, acquire, runLoad };
}

module.exports = {
  createLoadLeases,
  toOptions,
  refusalLine,
  QUEUE_WAIT_MS,
  SLOT_WAIT_MS,
  VOICE_BOUND_MS,
  RESIDENT_TTL_MS,
};
