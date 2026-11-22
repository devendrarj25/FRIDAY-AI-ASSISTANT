/**
 * FRIDAY · self-answer ledger
 *
 * One small, bounded record of who answered each turn and how it turned out,
 * so "FRIDAY answers more by herself" is a measured number and not a feeling.
 * An entry holds no prompt text: only the task kind, the source, the numbers
 * and the privacy tier. The functions that score the record are pure and take
 * the entries as input, so a fixed fixture gives a fixed answer.
 *
 * Both firewalls are read here after the fact: a SENSITIVE turn that reached a
 * cloud model, or a paid cloud call nobody approved, is a hard failure.
 */

import { readLocalState, writeState } from "../persist";

export type AnswerSource =
  "skill" | "memory" | "learned-card" | "local-model" | "cloud" | "unknown-model";
export type AnswerOutcome = "confirmed" | "corrected" | "unknown";
export type AnswerTier = "SENSITIVE" | "STANDARD";

export type LedgerEntry = {
  id: number;
  at: number;
  kind: string;
  source: AnswerSource;
  /** True when a cheaper path was tried or considered and the turn moved up. */
  escalated: boolean;
  /** The confidence the decision used, 0..1. */
  confidence: number;
  tier: AnswerTier;
  outcome: AnswerOutcome;
  /** Cloud call that costs money, and whether the owner approved it. */
  paid?: boolean;
  paidApproved?: boolean;
};

export type LedgerInput = Omit<LedgerEntry, "id" | "at" | "outcome"> & {
  at?: number;
  outcome?: AnswerOutcome;
};

const KEY = "friday.brain.answer-ledger.v1";
export const LEDGER_LIMIT = 500;
const BINS = 10;
const Z95 = 1.96;

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const round = (value: number): number => Math.round(value * 1000) / 1000;

/** A model turn whose server was never learned is neither self nor cloud: it is not guessed. */
export const isSelfSource = (source: AnswerSource): boolean =>
  source !== "cloud" && source !== "unknown-model";
const isSelfAnswered = (entry: LedgerEntry): boolean =>
  isSelfSource(entry.source) && !entry.escalated;
const known = (entry: LedgerEntry): boolean => entry.outcome !== "unknown";
const hit = (entry: LedgerEntry): number => (entry.outcome === "confirmed" ? 1 : 0);

/** Wilson score interval for a proportion. Zero trials give the widest honest range. */
export function wilson(successes: number, total: number): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 1 };
  const p = successes / total;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const margin = (Z95 * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { low: round(Math.max(0, centre - margin)), high: round(Math.min(1, centre + margin)) };
}

export type KindRate = {
  kind: string;
  turns: number;
  selfAnswered: number;
  rate: number;
  low: number;
  high: number;
};

/** Share of turns FRIDAY answered herself (no cloud, no escalation), per task kind, with a Wilson interval. */
export function selfAnswerRate(entries: LedgerEntry[]): KindRate[] {
  const groups = new Map<string, { turns: number; self: number }>();
  for (const entry of entries) {
    const row = groups.get(entry.kind) ?? { turns: 0, self: 0 };
    row.turns += 1;
    if (isSelfAnswered(entry)) row.self += 1;
    groups.set(entry.kind, row);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, row]) => ({
      kind,
      turns: row.turns,
      selfAnswered: row.self,
      rate: round(row.self / row.turns),
      ...wilson(row.self, row.turns),
    }));
}

/** Of the self answers whose outcome is known, how many were confirmed. Null with no evidence. */
export function precision(entries: LedgerEntry[]): { value: number | null; n: number } {
  const rows = entries.filter((entry) => isSelfAnswered(entry) && known(entry));
  if (!rows.length) return { value: null, n: 0 };
  return {
    value: round(rows.reduce((sum, row) => sum + hit(row), 0) / rows.length),
    n: rows.length,
  };
}

/** Brier score over known outcomes (0 is perfect). Null with no evidence. */
export function brierScore(entries: LedgerEntry[]): number | null {
  const rows = entries.filter(known);
  if (!rows.length) return null;
  const sum = rows.reduce((acc, row) => acc + (clamp01(row.confidence) - hit(row)) ** 2, 0);
  return round(sum / rows.length);
}

/** Expected calibration error over ten equal bins of confidence. Null with no evidence. */
export function expectedCalibrationError(entries: LedgerEntry[]): number | null {
  const rows = entries.filter(known);
  if (!rows.length) return null;
  const bins = Array.from({ length: BINS }, () => ({ n: 0, conf: 0, right: 0 }));
  for (const row of rows) {
    const confidence = clamp01(row.confidence);
    const bin = bins[Math.min(BINS - 1, Math.floor(confidence * BINS))];
    if (!bin) continue;
    bin.n += 1;
    bin.conf += confidence;
    bin.right += hit(row);
  }
  const gap = bins.reduce(
    (acc, bin) => (bin.n ? acc + Math.abs(bin.conf / bin.n - bin.right / bin.n) * bin.n : acc),
    0,
  );
  return round(gap / rows.length);
}

/** Accuracy of the self answers that stood at or above a confidence, and how much of the record they cover. */
export function selectiveAccuracy(
  entries: LedgerEntry[],
  threshold: number,
): { coverage: number; accuracy: number | null; n: number } {
  const rows = entries.filter((entry) => isSelfSource(entry.source) && known(entry));
  const kept = rows.filter((row) => clamp01(row.confidence) >= threshold);
  return {
    coverage: rows.length ? round(kept.length / rows.length) : 0,
    accuracy: kept.length
      ? round(kept.reduce((sum, row) => sum + hit(row), 0) / kept.length)
      : null,
    n: kept.length,
  };
}

export type HardGateFailure = { id: number; rule: "sensitive-to-cloud" | "unapproved-paid" };

/** Both firewalls, read after the fact. Any failure means the route was wrong, whatever the averages say. */
export function hardGate(entries: LedgerEntry[]): { pass: boolean; failures: HardGateFailure[] } {
  const failures: HardGateFailure[] = [];
  for (const entry of entries) {
    if (entry.tier === "SENSITIVE" && entry.source === "cloud") {
      failures.push({ id: entry.id, rule: "sensitive-to-cloud" });
    }
    if (entry.paid && !entry.paidApproved) failures.push({ id: entry.id, rule: "unapproved-paid" });
  }
  return { pass: failures.length === 0, failures };
}

/* -------------------------------------------------------------- storage */

let hydrated = false;
let ring: LedgerEntry[] = [];
let seq = 0;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const saved = readLocalState<LedgerEntry[]>(KEY);
  if (!Array.isArray(saved)) return;
  ring = saved.filter((row) => row && typeof row.id === "number").slice(-LEDGER_LIMIT);
  seq = ring.reduce((max, row) => Math.max(max, row.id), 0);
}

function persist(): void {
  try {
    writeState(KEY, ring);
  } catch {
    /* the in-memory ring still stands */
  }
}

export function resetAnswerLedger(): void {
  hydrated = true;
  ring = [];
  seq = 0;
}

export function listLedger(): LedgerEntry[] {
  hydrate();
  return [...ring];
}

/** Record one turn. Only kind, source, numbers and tier are kept. Returns the entry id. */
export function recordAnswer(input: LedgerInput): number {
  hydrate();
  seq += 1;
  const entry: LedgerEntry = {
    id: seq,
    at: input.at ?? Date.now(),
    kind: String(input.kind || "chat").slice(0, 40),
    source: input.source,
    escalated: Boolean(input.escalated),
    confidence: clamp01(input.confidence),
    tier: input.tier,
    outcome: input.outcome ?? "unknown",
    ...(input.paid ? { paid: true, paidApproved: Boolean(input.paidApproved) } : {}),
  };
  ring = [...ring, entry].slice(-LEDGER_LIMIT);
  persist();
  return entry.id;
}

const MODEL_SOURCES: AnswerSource[] = ["local-model", "cloud", "unknown-model"];

/**
 * Settle a model turn with the model that actually answered. A card, skill or memory answer is
 * never touched, and a known server is never downgraded to unknown by a later, blinder call.
 */
export function finishAnswer(
  id: number,
  served: {
    source: "local-model" | "cloud" | "unknown-model";
    paid?: boolean;
    paidApproved?: boolean;
    tier?: AnswerTier;
  },
): boolean {
  hydrate();
  const entry = ring.find((row) => row.id === id);
  if (!entry || !MODEL_SOURCES.includes(entry.source)) return false;
  if (served.source === "unknown-model" && entry.source !== "unknown-model") return false;
  entry.source = served.source;
  if (served.tier === "SENSITIVE") entry.tier = "SENSITIVE";
  if (served.source === "cloud" && served.paid) {
    entry.paid = true;
    entry.paidApproved = Boolean(served.paidApproved);
  } else {
    delete entry.paid;
    delete entry.paidApproved;
  }
  persist();
  return true;
}

/** Set what later happened. An outcome already known is never flipped back to unknown. */
export function noteAnswerOutcome(id: number, outcome: AnswerOutcome): boolean {
  hydrate();
  const entry = ring.find((row) => row.id === id);
  if (!entry || outcome === "unknown") return false;
  entry.outcome = outcome;
  persist();
  return true;
}
