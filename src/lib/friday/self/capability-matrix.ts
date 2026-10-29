/**
 * FRIDAY · capability matrix (what she is actually good at, per domain)
 *
 * One honest, persisted score per capability domain — coding, reasoning,
 * research, file-operations, planning, tool-use, conversation. The matrix is
 * NOT a marketing number: it starts from a conservative declared baseline and
 * is designed to be moved only by real task outcomes through `record()`, which
 * the outcome-feed work wires to the task ledger.
 *
 * Storage: one persisted record per domain (runs, successes, score). Reading
 * is free and synchronous, so the system map can fold the scores in like any
 * other live snapshot and every existing status surface shows them with no new
 * page and no duplicated registry.
 *
 * Scoring — keep this comment and AUDIT.md in sync when tuning:
 *   observed  = successes / runs                     (0 runs ⇒ no observation)
 *   weight    = min(1, runs / CONFIDENT_RUNS)        (trust grows with evidence)
 *   score     = round(100 * (baseline*(1-weight) + observed*weight))
 * so a domain that has never run reports exactly its declared baseline, and a
 * domain with real history reports what really happened.
 */

import { readLocalState, restoreFromDisk, writeState } from "../persist";

export type CapabilityDomain =
  | "coding"
  | "reasoning"
  | "research"
  | "file-operations"
  | "planning"
  | "tool-use"
  | "conversation";

/** Runs after which the measured rate fully replaces the declared baseline. */
export const CONFIDENT_RUNS = 12;

/**
 * Declared baselines. Deliberately modest: these describe what FRIDAY can do
 * unaided on a normal machine before any measurement exists, not an ambition.
 */
export const BASELINES: Record<CapabilityDomain, number> = {
  coding: 0.6,
  reasoning: 0.6,
  research: 0.5,
  "file-operations": 0.75,
  planning: 0.65,
  "tool-use": 0.7,
  conversation: 0.8,
};

export const DOMAIN_LABEL: Record<CapabilityDomain, string> = {
  coding: "Coding",
  reasoning: "Reasoning",
  research: "Research",
  "file-operations": "File operations",
  planning: "Planning",
  "tool-use": "Tool use",
  conversation: "Conversation",
};

export const DOMAINS = Object.keys(BASELINES) as CapabilityDomain[];

export type CapabilityScore = {
  domain: CapabilityDomain;
  label: string;
  /** 0–100. Baseline until real runs exist, then measurement-weighted. */
  score: number;
  baseline: number;
  runs: number;
  successes: number;
  /** null until at least one real run was recorded. */
  observed: number | null;
  lastRunAt: number | null;
  /** True while the number is still the declared baseline, not measured. */
  provisional: boolean;
};

export type CapabilityMatrixState = { at: number; scores: CapabilityScore[] };

type DomainRecord = { runs: number; successes: number; lastRunAt: number | null };

const STORAGE_KEY = "friday.capability-matrix.v1";

const emptyRecord = (): DomainRecord => ({ runs: 0, successes: 0, lastRunAt: null });

/** Pure score fold — the tests drive this directly. */
export function scoreFor(domain: CapabilityDomain, record: DomainRecord): CapabilityScore {
  const baseline = BASELINES[domain];
  const runs = Math.max(0, record.runs | 0);
  const successes = Math.min(runs, Math.max(0, record.successes | 0));
  const observed = runs ? successes / runs : null;
  const weight = Math.min(1, runs / CONFIDENT_RUNS);
  const value = observed === null ? baseline : baseline * (1 - weight) + observed * weight;
  return {
    domain,
    label: DOMAIN_LABEL[domain],
    score: Math.round(100 * value),
    baseline: Math.round(100 * baseline),
    runs,
    successes,
    observed,
    lastRunAt: record.lastRunAt,
    provisional: runs === 0,
  };
}

class CapabilityMatrix {
  private records: Record<CapabilityDomain, DomainRecord> = DOMAINS.reduce(
    (acc, domain) => {
      acc[domain] = emptyRecord();
      return acc;
    },
    {} as Record<CapabilityDomain, DomainRecord>,
  );
  private snapshot: CapabilityMatrixState = { at: 0, scores: [] };
  private listeners = new Set<() => void>();
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): CapabilityMatrixState => {
    this.load();
    return this.snapshot;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const local = readLocalState<Record<string, DomainRecord>>(STORAGE_KEY);
    if (local) this.merge(local);
    restoreFromDisk<Record<string, DomainRecord>>(STORAGE_KEY, (disk) => {
      if (!disk) return;
      this.merge(disk);
      this.emit(false);
    });
    this.emit(false);
  }

  private merge(stored: Record<string, DomainRecord>) {
    for (const domain of DOMAINS) {
      const value = stored[domain];
      if (!value || typeof value !== "object") continue;
      this.records[domain] = {
        runs: Number(value.runs) || 0,
        successes: Number(value.successes) || 0,
        lastRunAt: value.lastRunAt ?? null,
      };
    }
  }

  private emit(persist = true) {
    this.snapshot = {
      at: Date.now(),
      scores: DOMAINS.map((domain) => scoreFor(domain, this.records[domain])),
    };
    this.listeners.forEach((fn) => fn());
    if (!persist) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeState(STORAGE_KEY, this.records);
    }, 400);
  }

  /** Current scores, ordered as DOMAINS. */
  scores(): CapabilityScore[] {
    return this.getSnapshot().scores;
  }

  /** One domain's current score. */
  score(domain: CapabilityDomain): CapabilityScore {
    this.load();
    return scoreFor(domain, this.records[domain] ?? emptyRecord());
  }

  /** 0–1 capability for a domain, the form the confidence engine consumes. */
  ability(domain: CapabilityDomain): number {
    return this.score(domain).score / 100;
  }

  /**
   * Feed ONE real task outcome in. This is the only way a score moves — no
   * estimation, no decay, no back-fill.
   */
  record(domain: CapabilityDomain, ok: boolean, at: number = Date.now()): CapabilityScore {
    this.load();
    if (!DOMAINS.includes(domain)) return this.score(domain);
    const current = this.records[domain] ?? emptyRecord();
    this.records[domain] = {
      runs: current.runs + 1,
      successes: current.successes + (ok ? 1 : 0),
      lastRunAt: at,
    };
    this.emit();
    return this.score(domain);
  }

  /** Forget measurements for one domain (owner-driven reset). */
  reset(domain?: CapabilityDomain): void {
    this.load();
    if (domain) this.records[domain] = emptyRecord();
    else for (const key of DOMAINS) this.records[key] = emptyRecord();
    this.emit();
  }

  /** One-line digest for prompts and logs. */
  digest(): string {
    return this.scores()
      .map((s) => `${s.label} ${s.score}${s.provisional ? " (baseline)" : ""}`)
      .join(" · ");
  }
}

export const capabilityMatrix = new CapabilityMatrix();
