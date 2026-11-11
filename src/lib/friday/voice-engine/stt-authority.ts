/**
 * FRIDAY · who may turn a spoken utterance into a Brain turn.
 *
 * Two recognisers can hear the same utterance: the local one (always on, the default owner of the turn) and the
 * Sarvam live stream (a cloud service, off by default). The stream's partial words only ever draw a caption. This
 * file is the one place that decides, for each finished utterance, whether it becomes a turn, so that:
 *
 *  - in `captions` mode (the default) Sarvam text can never start a turn, exactly as before;
 *  - in `sarvam` mode a Sarvam final is the authoritative input, but only while the cloud gates pass at the moment
 *    the final arrives (cloud voice on, provider allowed, privacy mode off, a key, quota left); any gate that fails
 *    hands the utterance back to the local recogniser;
 *  - exactly one final creates a turn per utterance: the local final is held briefly for the cloud one and dropped
 *    when it arrives, or used when the cloud never answers; the slower engine's copy is dropped when it shows up;
 *  - a partial is provisional and is never submitted.
 *
 * Pure orchestration: timers, the clock and every side effect are injected, so it is tested without a microphone
 * or a network. The renderer owns the single `submit` that reaches the Brain.
 */

export type SttAuthority = "captions" | "sarvam";
export type UtteranceSource = "local" | "sarvam";

export type Utterance = {
  text: string;
  source: UtteranceSource;
  language?: string;
  /** The Sarvam turn id, when the text came from the stream. */
  turnId?: string;
};

export type ArbiterDecision =
  | { action: "submit"; source: UtteranceSource }
  | { action: "hold" }
  | {
      action: "drop";
      reason:
        | "partial"
        | "empty"
        | "captions-only"
        | "blocked"
        | "duplicate"
        | "counterpart-of-submitted"
        | "held-local-replaced";
      detail?: string;
    };

export type ArbiterDeps = {
  authority: () => SttAuthority;
  /** True while the Sarvam stream is open and able to deliver a final. */
  cloudHealthy: () => boolean;
  /** The mandatory cloud gates, asked again for every final. */
  gate: () => { ok: boolean; reason?: string };
  /** The one call that creates a turn. */
  submit: (utterance: Utterance) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** How long a local final waits for the cloud one before it is used (ms). */
  graceMs?: number;
  /** How long the slower engine's copy of a submitted utterance is recognised and dropped (ms). */
  pairWindowMs?: number;
};

const squash = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s.,!?;:।'"()\-_]+/gu, "");

export function createUtteranceArbiter(deps: ArbiterDeps) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const graceMs = deps.graceMs ?? 1500;
  const pairWindowMs = deps.pairWindowMs ?? 2500;

  let held: { utterance: Utterance; timer: unknown } | null = null;
  /** After one engine submitted, the other engine's copy of the same utterance is expected once. */
  let expect: { from: UtteranceSource; until: number } | null = null;
  let lastCloud = { key: "", at: 0 };
  const counts = { submitted: 0, local: 0, sarvam: 0, dropped: 0, heldTimedOut: 0 };

  const submit = (utterance: Utterance): ArbiterDecision => {
    counts.submitted += 1;
    counts[utterance.source] += 1;
    // The other engine is expected to report this same utterance once, soon.
    expect = {
      from: utterance.source === "local" ? "sarvam" : "local",
      until: now() + pairWindowMs,
    };
    deps.submit(utterance);
    return { action: "submit", source: utterance.source };
  };

  const dropped = (
    reason: Extract<ArbiterDecision, { action: "drop" }>["reason"],
    detail?: string,
  ): ArbiterDecision => {
    counts.dropped += 1;
    return { action: "drop", reason, ...(detail ? { detail } : {}) };
  };

  /** The counterpart of an utterance that was already submitted: consumed once, inside the window. */
  const isCounterpart = (source: UtteranceSource): boolean => {
    if (!expect) return false;
    if (now() > expect.until) {
      expect = null;
      return false;
    }
    if (expect.from !== source) {
      // The same engine spoke again: the other one missed the earlier utterance, so this is a new one.
      expect = null;
      return false;
    }
    expect = null;
    return true;
  };

  const releaseHeld = () => {
    if (!held) return;
    clearTimer(held.timer);
    held = null;
  };

  return {
    /** A finished utterance from the local recogniser. */
    local(text: string, language?: string): ArbiterDecision {
      const heard = text.trim();
      if (!heard) return dropped("empty");
      const utterance: Utterance = {
        text: heard,
        source: "local",
        ...(language ? { language } : {}),
      };
      if (isCounterpart("local"))
        return dropped("counterpart-of-submitted", "sarvam answered first");
      const wait =
        deps.authority() === "sarvam" && deps.cloudHealthy() && deps.gate().ok && held === null;
      if (!wait) {
        if (held) {
          // A second local final while one is still held: the held one goes first, in order.
          const earlier = held.utterance;
          releaseHeld();
          submit(earlier);
        }
        return submit(utterance);
      }
      const timer = setTimer(() => {
        if (!held || held.utterance !== utterance) return;
        held = null;
        counts.heldTimedOut += 1;
        submit(utterance); // the cloud never answered: the local text is used, so no utterance is lost
      }, graceMs);
      held = { utterance, timer };
      return { action: "hold" };
    },

    /** A partial transcript from the stream. It is never an utterance. */
    cloudPartial(): ArbiterDecision {
      return dropped("partial");
    },

    /** A finished utterance from the Sarvam stream. */
    cloudFinal(text: string, language?: string, turnId?: string): ArbiterDecision {
      const heard = text.trim();
      if (!heard) return dropped("empty");
      if (deps.authority() !== "sarvam") return dropped("captions-only");
      const gate = deps.gate();
      if (!gate.ok) {
        // Cloud permissions and privacy stay mandatory: a failed gate never lets cloud text through, and a held
        // local final is released at once.
        if (held) {
          const earlier = held.utterance;
          releaseHeld();
          submit(earlier);
        }
        return dropped("blocked", gate.reason);
      }
      const key = squash(heard);
      if (key && key === lastCloud.key && now() - lastCloud.at < pairWindowMs)
        return dropped("duplicate", "the same cloud final twice");
      lastCloud = { key, at: now() };
      if (isCounterpart("sarvam"))
        return dropped("counterpart-of-submitted", "local was used first");
      const utterance: Utterance = {
        text: heard,
        source: "sarvam",
        ...(language ? { language } : {}),
        ...(turnId ? { turnId } : {}),
      };
      const replacedLocal = held !== null;
      if (replacedLocal) {
        releaseHeld(); // the cloud text replaces the local copy of this same utterance
        counts.dropped += 1;
      }
      const decision = submit(utterance);
      // The local copy was already in hand (and dropped), so no second local final is expected for it.
      if (replacedLocal) expect = null;
      return decision;
    },

    /** The stream closed or failed: a held local final is used now rather than after the wait. */
    cloudLost(): void {
      if (!held) return;
      const earlier = held.utterance;
      releaseHeld();
      submit(earlier);
    },

    dispose(): void {
      releaseHeld();
      expect = null;
    },

    stats: () => ({ ...counts, holding: held !== null }),
  };
}

/**
 * Cloud speech is billed by audio duration. The client counts what it sent; the provider reports what it billed
 * when the session ends. Whichever is known when the stream is closed is recorded once: the provider's figure
 * replaces the estimate, and the estimate stands only when the provider never reported (a dropped stream).
 */
export class SttBillingReconciler {
  private estimate = 0;
  private billed: number | null = null;

  addSentSeconds(seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) this.estimate += seconds;
  }

  reportBilled(seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) this.billed = seconds;
  }

  get hasBilled(): boolean {
    return this.billed !== null;
  }

  /** The seconds to record now, once; the counters start again. */
  take(): { seconds: number; source: "provider" | "estimate" | "none" } {
    const out =
      this.billed !== null
        ? { seconds: this.billed, source: "provider" as const }
        : this.estimate > 0
          ? { seconds: this.estimate, source: "estimate" as const }
          : { seconds: 0, source: "none" as const };
    this.estimate = 0;
    this.billed = null;
    return out;
  }
}
