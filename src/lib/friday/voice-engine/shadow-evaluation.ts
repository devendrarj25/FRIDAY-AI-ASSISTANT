/**
 * FRIDAY · measuring the acoustic barge-in detector on the owner's own devices before it may decide anything.
 *
 * `BargeInDetector` runs beside the live interruption path and changes nothing she does (`BargeShadow` only pairs
 * its hits with the live pauses). This file keeps the evidence: every resolved pairing is recorded with the levels
 * it happened at, the totals survive a restart, and `shadowVerdict` says whether there is enough real-device data,
 * and agreement, to even consider letting the detector make the decision. It does not make that switch; the
 * criteria are a gate for a human decision, not an automatic promotion.
 *
 * Meaning of the three outcomes:
 *   both          the live path paused her and the detector fired within the window (agreement; `leadMs` is
 *                 detector time minus live time, negative when the detector would have stopped her earlier)
 *   liveOnly      the live path paused her and the detector did not fire (the detector would have missed it)
 *   detectorOnly  the detector fired and the live path did not (the detector would have interrupted her when the
 *                 live path judged it was not the owner: the false-interruption risk, e.g. echo or a TV)
 * The live path is the reference, not ground truth: a disagreement says where to listen, not who was right.
 */

export type ShadowOutcome =
  | { kind: "both"; leadMs: number; playbackLevel: number; micLevel: number }
  | { kind: "detectorOnly"; playbackLevel: number; micLevel: number }
  | { kind: "liveOnly"; playbackLevel: number; micLevel: number };

export type LevelBucket = "quiet" | "mid" | "loud";
export const bucketOf = (playbackLevel: number): LevelBucket =>
  playbackLevel < 0.05 ? "quiet" : playbackLevel < 0.2 ? "mid" : "loud";

type BucketCounts = { both: number; detectorOnly: number; liveOnly: number };
const empty = (): BucketCounts => ({ both: 0, detectorOnly: 0, liveOnly: 0 });

export type ShadowReport = {
  version: 1;
  /** Milliseconds of playback during which the detector was running. */
  exposureMs: number;
  sessions: number;
  totals: BucketCounts;
  byPlaybackLevel: Record<LevelBucket, BucketCounts>;
  /** Detector time minus live time for agreed pairs, newest last, bounded. */
  leadMs: number[];
  firstAt: number;
  lastAt: number;
};

export type ShadowCriteria = {
  minLivePauses: number;
  minExposureHours: number;
  minSessions: number;
  /** both / (both + liveOnly): the share of real pauses the detector also caught. */
  minAgreement: number;
  /** detectorOnly per hour of playback: how often it would have interrupted her without the live path. */
  maxDetectorOnlyPerHour: number;
  /** 90th percentile of how much later than the live path the detector fired, in milliseconds. */
  maxLateP90Ms: number;
};

export const PROMOTION_CRITERIA: ShadowCriteria = {
  minLivePauses: 50,
  minExposureHours: 2,
  minSessions: 3,
  minAgreement: 0.95,
  maxDetectorOnlyPerHour: 2,
  maxLateP90Ms: 300,
};

const LEAD_KEEP = 400;
const KEY = "friday.voice.bargeShadow.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export class ShadowLedger {
  private data: ShadowReport;

  constructor(
    initial?: ShadowReport | null,
    private readonly now: () => number = Date.now,
  ) {
    this.data = initial ?? {
      version: 1,
      exposureMs: 0,
      sessions: 0,
      totals: empty(),
      byPlaybackLevel: { quiet: empty(), mid: empty(), loud: empty() },
      leadMs: [],
      firstAt: 0,
      lastAt: 0,
    };
  }

  static load(storage: StorageLike | null, now: () => number = Date.now): ShadowLedger {
    try {
      const parsed = JSON.parse(storage?.getItem(KEY) ?? "null") as ShadowReport | null;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.leadMs))
        return new ShadowLedger(parsed, now);
    } catch {
      /* a missing or damaged record starts clean */
    }
    return new ShadowLedger(null, now);
  }

  save(storage: StorageLike | null): void {
    try {
      storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage can be full or blocked; the measurement just is not kept */
    }
  }

  /** One session is one start of the listening mode with the detector running. */
  beginSession(): void {
    this.data.sessions += 1;
    this.touch();
  }

  addExposure(ms: number): void {
    if (Number.isFinite(ms) && ms > 0 && ms < 60_000) this.data.exposureMs += ms;
  }

  record(outcome: ShadowOutcome): void {
    const bucket = this.data.byPlaybackLevel[bucketOf(outcome.playbackLevel)];
    this.data.totals[outcome.kind] += 1;
    bucket[outcome.kind] += 1;
    if (outcome.kind === "both" && Number.isFinite(outcome.leadMs)) {
      this.data.leadMs.push(Math.round(outcome.leadMs));
      if (this.data.leadMs.length > LEAD_KEEP)
        this.data.leadMs.splice(0, this.data.leadMs.length - LEAD_KEEP);
    }
    this.touch();
  }

  private touch(): void {
    const at = this.now();
    if (!this.data.firstAt) this.data.firstAt = at;
    this.data.lastAt = at;
  }

  report(): ShadowReport {
    return JSON.parse(JSON.stringify(this.data)) as ShadowReport;
  }

  reset(): void {
    this.data = new ShadowLedger(null, this.now).data;
  }
}

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
};

export type ShadowVerdict = {
  /** True only when every criterion is met on the owner's devices. It is advice for a human, never an action. */
  ready: boolean;
  agreement: number | null;
  detectorOnlyPerHour: number | null;
  lateP90Ms: number | null;
  livePauses: number;
  exposureHours: number;
  /** What is still missing or failing, in plain words. */
  reasons: string[];
};

export function shadowVerdict(
  report: ShadowReport,
  criteria: ShadowCriteria = PROMOTION_CRITERIA,
): ShadowVerdict {
  const livePauses = report.totals.both + report.totals.liveOnly;
  const hours = report.exposureMs / 3_600_000;
  const agreement = livePauses ? report.totals.both / livePauses : null;
  const perHour = hours > 0 ? report.totals.detectorOnly / hours : null;
  const late = percentile(report.leadMs, 0.9);
  const reasons: string[] = [];
  if (livePauses < criteria.minLivePauses)
    reasons.push(`${livePauses} of ${criteria.minLivePauses} live pauses seen`);
  if (hours < criteria.minExposureHours)
    reasons.push(`${hours.toFixed(2)} of ${criteria.minExposureHours} hours of playback measured`);
  if (report.sessions < criteria.minSessions)
    reasons.push(`${report.sessions} of ${criteria.minSessions} listening sessions`);
  if (agreement !== null && agreement < criteria.minAgreement)
    reasons.push(
      `it caught ${(agreement * 100).toFixed(0)}% of real pauses, ${criteria.minAgreement * 100}% needed`,
    );
  if (perHour !== null && perHour > criteria.maxDetectorOnlyPerHour)
    reasons.push(
      `it would have interrupted her ${perHour.toFixed(1)} times an hour on its own, ${criteria.maxDetectorOnlyPerHour} allowed`,
    );
  if (late !== null && late > criteria.maxLateP90Ms)
    reasons.push(
      `it fires up to ${late} ms later than the live pause (p90), ${criteria.maxLateP90Ms} allowed`,
    );
  return {
    ready: reasons.length === 0,
    agreement,
    detectorOnlyPerHour: perHour,
    lateP90Ms: late,
    livePauses,
    exposureHours: Number(hours.toFixed(3)),
    reasons,
  };
}

/** One line for Voice diagnostics. */
export function verdictLine(verdict: ShadowVerdict): string {
  if (verdict.ready)
    return "enough agreement on this PC's devices to consider switching (a person decides)";
  return `not enough evidence yet — ${verdict.reasons.slice(0, 3).join("; ")}`;
}
