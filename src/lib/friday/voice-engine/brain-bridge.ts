/**
 * Brain bridge, pure. The voice side's rules for asking the brain: the ladder of lanes a
 * spoken turn climbs (command, quick, full) with a time box on each rung, the one place that
 * builds the send options of a voice turn, when a spoken "one moment" is wanted, and when a
 * draft started while the owner was still talking may run. No timers, no clock, no DOM: the
 * caller feeds events and reads indexes, so every rule is testable with plain values.
 */

export type LadderLane = "command" | "quick" | "full";

export type LadderStep = {
  readonly lane: LadderLane;
  /** Longest wait for the first token before the next rung; null means no time box. */
  readonly timeboxMs: number | null;
  /** True when a refusal or a timeout of this rung must leave the running foreground turn alone. */
  readonly foregroundSafe: boolean;
};

export type LadderEvent = "first-token" | "timeout" | "refused";

/** The quick lane has one second to produce its first token, then the turn goes on to full. */
export const LADDER_QUICK_FIRST_TOKEN_MS = 1000;

/** Spoken context handed to the brain is cut here. */
export const CONTEXT_MAX_CHARS = 800;

/** A spoken "one moment" is wanted only when the answer is expected later than this. */
export const ACK_THRESHOLD_MS = 1500;

const COMMAND_STEP: LadderStep = Object.freeze({
  lane: "command",
  timeboxMs: null,
  foregroundSafe: true,
});
const QUICK_STEP: LadderStep = Object.freeze({
  lane: "quick",
  timeboxMs: LADDER_QUICK_FIRST_TOKEN_MS,
  foregroundSafe: true,
});
const FULL_STEP: LadderStep = Object.freeze({
  lane: "full",
  timeboxMs: null,
  foregroundSafe: false,
});

export type PlanInput = {
  text: string;
  /** A local command matched the words. */
  commandHit: boolean;
  /** The quick lane may take this turn (short, read-only, answerable from memory). */
  quickEligible: boolean;
  /** A foreground brain turn is already running. */
  busy: boolean;
};

/**
 * The rungs for one spoken turn, in order. Command first when it matched, then the quick
 * lane when the turn may use it, and a whole turn last. While a foreground turn runs the
 * plan holds no full rung at all: the quick lane may answer beside it, nothing else may start.
 */
export function planLadder(input: PlanInput): readonly LadderStep[] {
  if (!String(input.text || "").trim()) return Object.freeze([]);
  const steps: LadderStep[] = [];
  if (input.commandHit) steps.push(COMMAND_STEP);
  if (input.quickEligible) steps.push(QUICK_STEP);
  if (!input.busy) steps.push(FULL_STEP);
  return Object.freeze(steps);
}

/**
 * Where the ladder goes after an event on rung `at`: null when a first token accepted the
 * rung, or when no rung is left; otherwise the index of the next rung. A refusal moves down
 * the ladder and never stops the foreground turn: read `foregroundSafe` on the rung.
 */
export function nextRung(
  plan: readonly LadderStep[],
  at: number,
  event: LadderEvent,
): number | null {
  if (!Number.isInteger(at) || at < 0 || at >= plan.length) return null;
  if (event === "first-token") return null;
  return at + 1 < plan.length ? at + 1 : null;
}

/** A refused rung never cancels, queues behind or replaces the running foreground turn. */
export function refusalKeepsForeground(step: LadderStep): boolean {
  return step.foregroundSafe;
}

export type VoiceSendOptions = {
  routingSurface: "voice";
  lane: "quick" | "full";
  turnId: string;
  context?: string;
};

export type VoiceSendInput = {
  lane: "quick" | "full";
  turnId: string;
  context?: string;
  /** The one privacy classifier (brain/memory-policy.ts looksSensitive), injected. */
  isSensitive?: (text: string) => boolean;
};

function trimContext(raw: string): string {
  let cut = raw.trim().slice(0, CONTEXT_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trim();
}

function safeToSend(text: string, isSensitive: ((s: string) => boolean) | undefined): boolean {
  if (!isSensitive) return false;
  try {
    return !isSensitive(text);
  } catch {
    return false;
  }
}

/**
 * The send options of a voice turn, built in one place so the surface is never forgotten.
 * Context is cut to 800 characters and dropped when the classifier calls it sensitive, when
 * no classifier was given, or when the classifier fails: a voice turn never leaks by default.
 */
export function voiceSendOptions(input: VoiceSendInput): VoiceSendOptions {
  const out: VoiceSendOptions = { routingSurface: "voice", lane: input.lane, turnId: input.turnId };
  const raw = typeof input.context === "string" ? input.context : "";
  if (raw.trim() && safeToSend(raw, input.isSensitive)) {
    const context = trimContext(raw);
    if (context) out.context = context;
  }
  return out;
}

/** True when a short spoken acknowledgement should cover the wait; never for a command. */
export function ackWanted(input: { lane: LadderLane; expectedMs: number }): boolean {
  return (
    input.lane !== "command" &&
    Number.isFinite(input.expectedMs) &&
    input.expectedMs > ACK_THRESHOLD_MS
  );
}

/**
 * A draft begun before the turn ended may run only read-only, and only while privacy, paid
 * access and the autonomy dial are all as they were when it started.
 */
export function speculationAllowed(input: {
  privacyChanged: boolean;
  paidChanged: boolean;
  autonomyChanged: boolean;
  readOnly: boolean;
}): boolean {
  return input.readOnly && !input.privacyChanged && !input.paidChanged && !input.autonomyChanged;
}
