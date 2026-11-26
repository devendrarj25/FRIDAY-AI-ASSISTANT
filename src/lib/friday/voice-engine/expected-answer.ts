/**
 * The expected answer time: how long the real answer will take to reach its first spoken clause. The instant
 * acknowledgement is opt-in by this number (the brain bridge's `ackWanted` says yes only above 1500 ms), so a fast
 * lane stays silent and a slow one gets its short "one moment".
 *
 * Pure and deterministic: no clock, no timer, no storage. The conductor keeps the history object in memory and feeds
 * it back in; this module only reads and returns plain values. A session measures its own lanes (the rolling median
 * of the last eight first-clause times), and until a lane has enough samples fixed priors stand in.
 */
import type { LadderLane } from "./brain-bridge";

/** Measured first-clause times in milliseconds, newest last, per lane. */
export type FirstClauseHistory = Partial<Record<LadderLane, number[]>>;

/** At most this many samples are kept and read per lane. */
export const EXPECTED_HISTORY_CAP = 8;
/** A lane needs this many valid samples before its median replaces the prior. */
export const EXPECTED_MIN_SAMPLES = 3;
/** The priors in milliseconds: a quick answer, a full answer, a full answer that probably runs tools. */
export const EXPECTED_PRIORS = Object.freeze({ quick: 800, full: 2500, tools: 4000 });
/** Longest first-clause time that is believed; a longer one is a stall, not a measurement. */
const SAMPLE_MAX_MS = 60_000;

const LANES: readonly LadderLane[] = ["command", "quick", "full"];
const isLane = (value: unknown): value is LadderLane => LANES.includes(value as LadderLane);
const validSample = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= SAMPLE_MAX_MS;

/** The valid samples of one lane, oldest first, the last eight at most. Never throws on a damaged history. */
function samplesOf(history: unknown, lane: LadderLane): number[] {
  if (!history || typeof history !== "object") return [];
  const raw = (history as Record<string, unknown>)[lane];
  if (!Array.isArray(raw)) return [];
  return raw.filter(validSample).slice(-EXPECTED_HISTORY_CAP);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return hi;
  return Math.round(((sorted[mid - 1] ?? hi) + hi) / 2);
}

/**
 * Milliseconds to the first spoken clause for a turn, or null when the lane is not known (the acknowledgement then
 * stays silent). A command is instant. Quick and full use the rolling median of this session's measurements once
 * a lane has three of them, otherwise the priors (full with tools is slower than full without).
 */
export function expectedAnswerMs(input: {
  kind: string;
  lane: LadderLane;
  toolsLikely: boolean;
  history: FirstClauseHistory;
}): number | null {
  if (!input || typeof input !== "object") return null;
  const { lane } = input;
  if (!isLane(lane)) return null;
  if (lane === "command") return 0;
  const measured = samplesOf(input.history, lane);
  if (measured.length >= EXPECTED_MIN_SAMPLES) return median(measured);
  if (lane === "quick") return EXPECTED_PRIORS.quick;
  return input.toolsLikely === true ? EXPECTED_PRIORS.tools : EXPECTED_PRIORS.full;
}

/**
 * A new history with one more measured first-clause time on a lane (newest last, eight kept). A value that is not
 * finite, is negative or is over 60000 is ignored, and so is the command lane (it is never measured). The old
 * history and its arrays are never changed.
 */
export function recordFirstClause(
  history: FirstClauseHistory,
  lane: LadderLane,
  ms: number,
): FirstClauseHistory {
  const next: FirstClauseHistory = {};
  for (const known of LANES) {
    const kept = samplesOf(history, known);
    if (kept.length) next[known] = kept;
  }
  if (lane === "command" || !isLane(lane) || !validSample(ms)) return next;
  next[lane] = [...(next[lane] ?? []), ms].slice(-EXPECTED_HISTORY_CAP);
  return next;
}

/* ---------- which lane a turn is on ---------- */

/**
 * A short, obvious device or player control: the lead word is a control verb and the line is at most six words.
 * JavaScript's \b does not see Devanagari letters, so those leads end at a space, a mark or the end of the line.
 */
const CONTROL_LEAD =
  /^\s*(?:(?:please\s+)?(?:mute|unmute|volume|louder|quieter|pause|resume|skip|next|previous|brightness)\b|(?:awaaz|avaaz|volume)\s+(?:kam|badhao|zyada)\b|(?:आवाज़|आवाज|वॉल्यूम|म्यूट|पॉज़|पॉज)(?=$|[\s?,.!;:।]))/iu;
const CONTROL_MAX_WORDS = 6;

/**
 * The lane of a spoken turn, from the router's kind and the words: a side question rides the quick lane, an obvious
 * control verb is a command (no acknowledgement), a new task is the full lane with tools, everything else the full
 * lane. Anything odd falls to the full lane, the slowest honest guess.
 */
export function ackLane(input: { kind: string; text: string }): {
  lane: LadderLane;
  toolsLikely: boolean;
} {
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  const kind = typeof input?.kind === "string" ? input.kind : "";
  if (text && text.split(/\s+/).length <= CONTROL_MAX_WORDS && CONTROL_LEAD.test(text)) {
    return { lane: "command", toolsLikely: false };
  }
  if (kind === "side-question") return { lane: "quick", toolsLikely: false };
  return { lane: "full", toolsLikely: kind === "new-task" };
}
