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

const fs = require("fs");

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
 * before the file. When a read throws (a busy file) the last known state stands, and when nothing is known at all
 * FRIDAY counts as halted (the dial "ask"). A file that exists but is corrupt or unreadable (`UNREADABLE`) is halted
 * at once, and stays halted while the file is missing afterwards (the store set it aside), until a real state is read:
 * an unreadable state never opens the gate.
 * @param {() => unknown} readStored returns the stored autonomy record, null when nothing is stored, or UNREADABLE;
 *   may throw.
 * @returns {{read: () => {dial: "ask"|"balanced"|"full", halted: boolean}, signalHalted: (value: unknown) => boolean}}
 */
function createAutonomyReader(readStored) {
  let signal = null;
  let known = null;
  let damaged = false;
  return {
    read() {
      let state;
      try {
        const stored = readStored();
        const record = Boolean(stored) && typeof stored === "object";
        if (stored === UNREADABLE || (damaged && !record)) {
          damaged = true;
          state = { dial: known ? known.dial : "ask", halted: true };
        } else if (!record) {
          // Nothing stored is the shipped default (Balanced, still asks). "Stop everything" persists `halted`.
          state = { dial: "balanced", halted: false };
          known = state;
        } else {
          const halted = stored.halted === true;
          if (stored.approvalLevel === "full") state = { dial: "full", halted };
          else if (stored.approvalLevel === "balanced" || stored.approvalLevel === "trusted")
            state = { dial: "balanced", halted };
          else state = { dial: "ask", halted };
          damaged = false;
          known = state;
        }
      } catch {
        if (damaged || !known) state = { dial: known ? known.dial : "ask", halted: true };
        else state = { ...known };
      }
      return signal === null ? state : { ...state, halted: signal };
    },
    signalHalted(value) {
      signal = value === true;
      return signal;
    },
  };
}

/** What `readAutonomyFile` returns for a file that exists but gives no state: never a value a stored file can hold. */
const UNREADABLE = Symbol("autonomy-state-unreadable");

/**
 * Read the stored autonomy record through the state store. A missing file is null (the shipped default); a file that
 * is there but corrupt with no good backup, or cannot be read at all, is UNREADABLE (halted), never the default.
 * @param {{readState: (file: string) => unknown}} store the state store (`electron/state-store.cjs`).
 */
function readAutonomyFile(store, file, exists = (p) => fs.existsSync(p)) {
  const present = exists(file);
  const stored = store.readState(file);
  if (stored !== null && stored !== undefined) return stored;
  return present ? UNREADABLE : null;
}

/**
 * True only for a message from the main window's own top frame: not a sub-frame, another window or a frame that is
 * gone. `contents` is the main window's webContents (null when there is no window).
 */
function fromMainFrame(event, contents) {
  if (!event || !contents || event.sender !== contents) return false;
  if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
  const frame = event.senderFrame;
  const main = contents.mainFrame;
  if (!frame || !main) return false;
  return frame.processId === main.processId && frame.routingId === main.routingId;
}

module.exports = {
  ASK_TIMEOUT_MS,
  UNREADABLE,
  gateDecision,
  askWithTimeout,
  createAutonomyReader,
  readAutonomyFile,
  fromMainFrame,
};
