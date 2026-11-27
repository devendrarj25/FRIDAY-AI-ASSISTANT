/**
 * FRIDAY · the owner's autonomy dial applied to one tool call (main process, pure logic).
 *
 * The tool permission gate (`authorizeToolCall` in main.cjs) asks for every write and exec call by default. The owner's
 * autonomy dial is the one switch that changes that:
 *
 *   Ask every time / Balanced  write and exec calls ask, as before.
 *   Full                       write and exec calls run without a prompt, except what the dial never covers: the
 *                              app's own shutdown and restart (they always ask, decided before this module), a tool
 *                              the owner set to "ask" by name, and every refusal made after the signature (the
 *                              kernel's argument policy and its secret and credential refusals).
 *   Stop everything (halted)   write and exec calls are refused, whatever the dial says. Reads still run.
 *
 * A prompt that nobody answers must end: the question carries a deadline and an abort signal, and no answer is no.
 */

/** How long the owner has to answer a permission question before it counts as "no". */
const ASK_TIMEOUT_MS = 120_000;

/**
 * @param {{risk: string, decision: string, dial?: string, halted?: boolean, stored?: string}} input
 *   `decision` is what the stored policy and the owner's permission toggles already decided (allow, ask, deny);
 *   `stored` is the owner's own per-tool choice, when there is one.
 * @returns {{decision: "allow"|"ask"|"deny", reason: string|null}}
 */
function gateDecision({ risk, decision, dial = "balanced", halted = false, stored = "" }) {
  const base = ["allow", "ask", "deny"].includes(decision) ? decision : "ask";
  if (base === "deny") return { decision: "deny", reason: "policy" };
  if (risk === "safe") return { decision: base, reason: null };
  // Anything that changes something: a halted FRIDAY does none of it.
  if (halted === true) return { decision: "deny", reason: "halted" };
  if (dial === "full" && base === "ask" && stored !== "ask") {
    return { decision: "allow", reason: "full-autonomy" };
  }
  return { decision: base, reason: null };
}

/**
 * Run `ask(signal)` (a modal question) with a deadline. When it passes, the signal aborts the question and the answer
 * is a refusal; a question that throws is a refusal too.
 * @returns {Promise<{granted: boolean, remember: boolean, timedOut?: boolean}>}
 */
async function askWithTimeout(
  ask,
  { ms = ASK_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  const controller = new AbortController();
  let timer = null;
  const expired = new Promise((resolve) => {
    timer = setTimer(() => {
      controller.abort();
      resolve({ granted: false, remember: false, timedOut: true });
    }, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => ask(controller.signal))
        .catch(() => ({ granted: false, remember: false })),
      expired,
    ]);
  } finally {
    if (timer !== null) clearTimer(timer);
  }
}

/**
 * The owner's autonomy state as the main process knows it. Stop everything is written to disk on a short delay, so the
 * renderer also sends a synchronous signal (`signalHalted`) the moment the state changes; `read` takes that signal
 * before the file. When the file cannot be read the last known state stands, and when nothing is known at all FRIDAY
 * counts as halted (the dial "ask"): an unreadable state never opens the gate.
 * @param {() => unknown} readStored returns the stored autonomy record, or null when nothing is stored; may throw.
 * @returns {{read: () => {dial: "ask"|"balanced"|"full", halted: boolean}, signalHalted: (value: unknown) => boolean}}
 */
function createAutonomyReader(readStored) {
  let signal = null;
  let known = null;
  return {
    read() {
      let state;
      try {
        const stored = readStored();
        // Nothing stored is the shipped default (Balanced, still asks). "Stop everything" persists `halted`.
        if (!stored || typeof stored !== "object") {
          state = { dial: "balanced", halted: false };
        } else {
          const halted = stored.halted === true;
          if (stored.approvalLevel === "full") state = { dial: "full", halted };
          else if (stored.approvalLevel === "balanced" || stored.approvalLevel === "trusted")
            state = { dial: "balanced", halted };
          else state = { dial: "ask", halted };
        }
        known = state;
      } catch {
        state = known ? { ...known } : { dial: "ask", halted: true };
      }
      return signal === null ? state : { ...state, halted: signal };
    },
    signalHalted(value) {
      signal = value === true;
      return signal;
    },
  };
}

module.exports = { ASK_TIMEOUT_MS, gateDecision, askWithTimeout, createAutonomyReader };
