/**
 * FRIDAY · measured voice latency, from real turns only.
 *
 * Each finished turn (see `voice-turn-trace.ts`) contributes the time between its stages. Nothing is invented:
 * a stage that did not happen adds no sample, and a metric with no samples reports none. Samples are bounded
 * per metric. The percentiles use the nearest-rank method on the samples kept.
 */
import type { VoiceTurn } from "../voice-turn-trace";

export type LatencySummary = { count: number; p50: number; p95: number; last: number; max: number };

const MAX_SAMPLES = 100;

/** The named gaps between stages of one turn, in ms, for the stages that really ran. */
export function turnDurations(turn: VoiceTurn): Record<string, number> {
  const at = (stage: string): number | null => {
    const row = turn.rows.find((r) => r.stage === stage && r.ok);
    return row ? row.at : null;
  };
  const heard = at("heard");
  const routed = at("routed");
  const model = at("model");
  const reply = at("reply");
  const spoken = at("spoken");
  const out: Record<string, number> = {};
  const gap = (name: string, from: number | null, to: number | null) => {
    if (from !== null && to !== null && to >= from) out[name] = to - from;
  };
  gap("heardToRouted", heard, routed);
  gap("routedToModel", routed, model);
  gap("modelToReply", model, reply);
  gap("replyToSpoken", reply, spoken);
  gap("heardToSpoken", heard, spoken);
  return out;
}

export class LatencyMonitor {
  private readonly samples = new Map<string, number[]>();

  record(metric: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const list = this.samples.get(metric) ?? [];
    list.push(Math.round(ms));
    if (list.length > MAX_SAMPLES) list.shift();
    this.samples.set(metric, list);
  }

  recordTurn(turn: VoiceTurn): void {
    for (const [metric, ms] of Object.entries(turnDurations(turn))) this.record(metric, ms);
  }

  summary(metric: string): LatencySummary | null {
    const list = this.samples.get(metric);
    if (!list?.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    const rank = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
    return {
      count: sorted.length,
      p50: rank(0.5),
      p95: rank(0.95),
      last: list[list.length - 1] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
    };
  }

  metrics(): string[] {
    return [...this.samples.keys()];
  }

  reset(): void {
    this.samples.clear();
  }

  /** One plain line, or a statement that nothing was measured. */
  line(metric = "heardToSpoken"): string {
    const s = this.summary(metric);
    return s
      ? `${s.p50} ms typical, ${s.p95} ms slow end, ${s.last} ms last (${s.count} turns)`
      : "no finished turn measured yet";
  }
}

export const voiceLatency = new LatencyMonitor();

/** The stages one spoken turn passes through, in the order a turn meets them. Each is stamped at most once. */
export const VOICE_STAGES = [
  "micSpeechStart",
  "wakeDetected",
  "sttAudioFirstSent",
  "sttPartialFirstReceived",
  "sttFinalReceived",
  "brainRequestStarted",
  "brainFirstToken",
  "firstSpeakableSentence",
  "ttsRequestStarted",
  "ttsFirstAudioReceived",
  "audioFirstDecoded",
  "playbackFirstSample",
  "interruptCandidate",
  "interruptConfirmed",
  "playbackLastAudibleSample",
] as const;
export type VoiceStage = (typeof VOICE_STAGES)[number];

/** The named gaps between two stages. Both ends must have been stamped for a gap to count. */
const STAGE_GAPS: Array<[string, VoiceStage, VoiceStage]> = [
  ["wakeToFirstAudioSent", "wakeDetected", "sttAudioFirstSent"],
  ["sttFirstPartial", "sttAudioFirstSent", "sttPartialFirstReceived"],
  ["sttFinal", "sttAudioFirstSent", "sttFinalReceived"],
  ["brainFirstToken", "brainRequestStarted", "brainFirstToken"],
  ["firstSpeakable", "brainRequestStarted", "firstSpeakableSentence"],
  ["ttsFirstChunk", "ttsRequestStarted", "ttsFirstAudioReceived"],
  ["ttsDecode", "ttsFirstAudioReceived", "audioFirstDecoded"],
  ["firstAudible", "ttsRequestStarted", "playbackFirstSample"],
  ["finalToFirstAudible", "sttFinalReceived", "playbackFirstSample"],
  ["audibleStop", "interruptCandidate", "playbackLastAudibleSample"],
  ["interruptConfirm", "interruptCandidate", "interruptConfirmed"],
];

/**
 * Monotonic stage stamps for one turn. "Requested" and "audible" are different stages: a request time is never
 * reported as the first sound. `finish` feeds each gap that really happened into a monitor, and returns them.
 */
export class StageClock {
  private readonly stamps = new Map<VoiceStage, number>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Stamp a stage the first time it happens in this turn. Returns false when it was already stamped. */
  mark(stage: VoiceStage, at: number = this.now()): boolean {
    if (this.stamps.has(stage)) return false;
    this.stamps.set(stage, at);
    return true;
  }

  at(stage: VoiceStage): number | null {
    return this.stamps.get(stage) ?? null;
  }

  durations(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, from, to] of STAGE_GAPS) {
      const a = this.stamps.get(from);
      const b = this.stamps.get(to);
      if (a !== undefined && b !== undefined && b >= a) out[name] = Math.round(b - a);
    }
    return out;
  }

  finish(monitor: LatencyMonitor = voiceLatency): Record<string, number> {
    const out = this.durations();
    for (const [name, ms] of Object.entries(out)) monitor.record(name, ms);
    return out;
  }

  reset(): void {
    this.stamps.clear();
  }
}
