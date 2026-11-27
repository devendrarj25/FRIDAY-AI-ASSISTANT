/**
 * FRIDAY · local self-improvement by fine-tuning
 *
 * The experience store is the training data: verified successes, the way she
 * actually solved them. From that, FRIDAY can train a LoRA/QLoRA adapter for
 * one of her LOCAL models — entirely on this PC, never uploaded anywhere — and
 * keep every adapter version so an older one can be re-activated if a newer
 * one turns out worse.
 *
 * Training is never automatic: it goes through the same governance gate as any
 * other self-change, so the owner approves each run before a single step runs.
 */

import { governance } from "./governance";
import { experiences, type Experience } from "./task-ledger";

export type FinetuneRun = {
  id: string;
  base: string;
  examples: number;
  startedAt: number;
  endedAt: number | null;
  state: "running" | "done" | "failed";
  progress: number;
  detail: string;
  output: string;
  loss: number | null;
  error: string | null;
};

export type FinetuneAdapter = {
  id: string;
  dir: string;
  base: string | null;
  examples: number | null;
  loss: number | null;
  finishedAt: number | null;
  active: boolean;
};

export type FinetuneReadiness = {
  ready: boolean;
  python: string | null;
  missing: string[];
  quantised?: boolean;
  detail: string;
};

export type FinetuneState = { runs: FinetuneRun[]; activeAdapter: string | null; busy: boolean };

export type TrainingExample = { prompt: string; response: string };

/** Who wrote a piece of text, or what content sat in the context that produced it. */
export type RowProvenance = {
  /** Who wrote the prompt. Only "owner" may train. */
  promptAuthor: string;
  /** Untrusted content in the context (tool, web, screen, mcp, file, email...). Must be an empty array to train; missing = unknown = dropped. */
  contextKinds: string[] | undefined;
  /** What produced the reply. Only a local model may train unless outputMayTrain is true. */
  responseModel?: "local" | "cloud" | "unknown";
  /** NEW field: a cloud or unknown output trains only when this is exactly true. Missing = false. */
  outputMayTrain?: boolean;
};

/** A candidate training row with its provenance tag and the data class the owner would have to accept. */
export type TrainingRow = TrainingExample & { dataClass: string; provenance: RowProvenance };

/** The ONE kernel privacy classifier call path, injected (no classifier lives here). */
export type PrivacyClassify = (text: string) => { level: string } | Promise<{ level: string }>;

export type DropReason =
  | "class-not-accepted"
  | "not-owner-authored"
  | "untrusted-context"
  | "output-not-allowed"
  | "sensitive"
  | "classifier-failed"
  | "empty";

export type RowSelection = {
  kept: TrainingExample[];
  /** The same rows with their tags, for the main process to re-check. */
  rows: TrainingRow[];
  dropped: { reason: DropReason; count: number }[];
};

type Bridge = {
  finetuneState?: () => Promise<FinetuneState>;
  finetuneProbe?: () => Promise<FinetuneReadiness>;
  finetuneStart?: (job: {
    base: string;
    /** Tagged rows: the main process re-runs the row rule on them and drops what fails. */
    examples: TrainingRow[];
    classesAccepted?: string[];
    epochs?: number;
    rank?: number;
    learningRate?: number;
    quantised?: boolean;
    heldOut?: TrainingRow[];
    adaptersEnabled?: boolean;
  }) => Promise<{ ok: boolean; run?: FinetuneRun; error?: string; missing?: string[] }>;
  finetuneCancel?: () => Promise<{ ok: boolean; error?: string }>;
  finetuneAdapters?: () => Promise<{
    ok: boolean;
    adapters: FinetuneAdapter[];
    activeAdapter: string | null;
  }>;
  finetuneActivate?: (
    id: string | null,
  ) => Promise<{ ok: boolean; activeAdapter?: string | null; error?: string }>;
  finetuneRemove?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onFinetuneRun?: (fn: (run: FinetuneRun) => void) => () => void;
  onFinetuneActive?: (fn: (payload: { activeAdapter: string | null }) => void) => () => void;
};

const bridge = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as Bridge | undefined);

export const finetuneAvailable = () => Boolean(bridge()?.finetuneStart);

const NO_DESKTOP = "Local training runs in the installed FRIDAY desktop app.";

export const finetuneProbe = (): Promise<FinetuneReadiness> =>
  bridge()?.finetuneProbe?.() ??
  Promise.resolve({ ready: false, python: null, missing: [], detail: NO_DESKTOP });

export const finetuneState = (): Promise<FinetuneState> =>
  bridge()?.finetuneState?.() ?? Promise.resolve({ runs: [], activeAdapter: null, busy: false });

export const finetuneAdapters = () =>
  bridge()?.finetuneAdapters?.() ??
  Promise.resolve({ ok: false, adapters: [] as FinetuneAdapter[], activeAdapter: null });

export const cancelFinetune = () =>
  bridge()?.finetuneCancel?.() ?? Promise.resolve({ ok: false, error: NO_DESKTOP });

export const removeAdapter = (id: string) =>
  bridge()?.finetuneRemove?.(id) ?? Promise.resolve({ ok: false, error: NO_DESKTOP });

export const onFinetuneRun = (fn: (run: FinetuneRun) => void) => bridge()?.onFinetuneRun?.(fn);

/** The adapter switched (from this window or another). */
export const onFinetuneActive = (fn: (payload: { activeAdapter: string | null }) => void) =>
  bridge()?.onFinetuneActive?.(fn);

/** Minimum verified examples before training is worth doing at all. */
export const MIN_EXAMPLES = 8;

/**
 * Turn verified successes into prompt/response pairs.
 *
 * Only experiences that were both successful AND verified become training
 * data — an unchecked "seemed fine" is history, not a lesson. Owner
 * corrections are excluded outright, so FRIDAY never trains on her mistakes.
 */
export function buildTrainingSet(
  source: Experience[] = experiences.successes(300),
): TrainingExample[] {
  const seen = new Set<string>();
  const rows: TrainingExample[] = [];
  for (const item of source) {
    if (!item.success || !item.verified) continue;
    const prompt = item.attempted?.trim() || item.title?.trim();
    if (!prompt) continue;
    const response = [
      item.detail?.trim(),
      item.tools?.length ? `Tools used: ${item.tools.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!response) continue;
    const key = `${prompt}::${response}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ prompt, response });
  }
  return rows;
}

/** Held-out share of the rows (D12). */
export const HELD_OUT_FRACTION = 0.15;

const HELD_OUT_SEED = "friday-heldout-v1";

/** The levels the kernel privacy classifier can answer with; anything else is a failed classification. */
const PRIVACY_LEVELS = ["sensitive", "private", "internal", "public"];

/**
 * Keep only rows that may train: a data class the owner accepted, a prompt the
 * owner wrote, a context with NO tool/web/screen/MCP content (untrusted input is
 * data, never training), a reply from a local model (cloud output needs
 * outputMayTrain === true), and nothing the kernel privacy classifier calls
 * SENSITIVE (secret-looking text included). A missing classifier or a classifier
 * that throws or answers without a known level drops the row: the rails fail closed.
 * The main process (electron/finetune.cjs) runs this same rule again on what the renderer sends,
 * so this is the early check, not the authority; a test pins the two equal.
 */
export async function selectTrainingRows(
  rows: TrainingRow[],
  options: { classesAccepted: string[]; classify?: PrivacyClassify },
): Promise<RowSelection> {
  const accepted = new Set(options.classesAccepted);
  const counts = new Map<DropReason, number>();
  const drop = (reason: DropReason) => counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const kept: TrainingExample[] = [];
  const keptRows: TrainingRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const prompt = String(row?.prompt ?? "").trim();
    const response = String(row?.response ?? "").trim();
    if (!prompt || !response) {
      drop("empty");
      continue;
    }
    if (!accepted.has(row.dataClass)) {
      drop("class-not-accepted");
      continue;
    }
    const source = row.provenance;
    if (source?.promptAuthor !== "owner") {
      drop("not-owner-authored");
      continue;
    }
    if (!Array.isArray(source.contextKinds) || source.contextKinds.length > 0) {
      drop("untrusted-context");
      continue;
    }
    if (source.responseModel !== "local" && source.outputMayTrain !== true) {
      drop("output-not-allowed");
      continue;
    }
    let level: string;
    try {
      if (!options.classify) throw new Error("no classifier");
      level = String((await options.classify(`${prompt}\n${response}`))?.level);
      if (!PRIVACY_LEVELS.includes(level)) throw new Error("unknown level");
    } catch {
      drop("classifier-failed");
      continue;
    }
    if (level === "sensitive") {
      drop("sensitive");
      continue;
    }
    const key = `${prompt}::${response}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ prompt, response });
    keptRows.push({ ...row, prompt, response });
  }
  return {
    kept,
    rows: keptRows,
    dropped: [...counts].map(([reason, count]) => ({ reason, count })),
  };
}

function seededOrder(length: number, seed: string): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const next = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** Deterministic split: the same rows and seed always give the same held-out set. Each part keeps input order. */
export function splitHeldOut<T>(
  rows: T[],
  fraction: number = HELD_OUT_FRACTION,
  seed: string = HELD_OUT_SEED,
): { train: T[]; heldOut: T[] } {
  const share = Number.isFinite(fraction)
    ? Math.min(Math.max(fraction, 0), 0.5)
    : HELD_OUT_FRACTION;
  const want = rows.length < 2 ? 0 : Math.max(1, Math.round(rows.length * share));
  const heldIdx = new Set(seededOrder(rows.length, seed).slice(0, want));
  return {
    train: rows.filter((_, i) => !heldIdx.has(i)),
    heldOut: rows.filter((_, i) => heldIdx.has(i)),
  };
}

export type TrainingGateInput = {
  /** brain.learn.adapters: the owner opted in. Missing = off. */
  enabled?: boolean | undefined;
  idle?: boolean | undefined;
  onAc?: boolean | undefined;
  inVoiceTurn?: boolean | undefined;
  /** The governor lease for the run. */
  leaseGranted?: boolean | undefined;
};

/** Training runs only when opted in, idle, on AC power, outside a voice turn, under a lease. Unknown = blocked. */
export function trainingGate(input: TrainingGateInput): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.enabled !== true) reasons.push("on-device learning is off");
  if (input.idle !== true) reasons.push("the PC is not idle");
  if (input.onAc !== true) reasons.push("not on AC power");
  if (input.inVoiceTurn !== false) reasons.push("a voice turn may be running");
  if (input.leaseGranted !== true) reasons.push("no governor lease");
  return { allowed: reasons.length === 0, reasons };
}

export const ADAPTER_SCORE_KEYS = ["heldout", "safety", "toolcall", "language"] as const;
export type AdapterScores = Record<(typeof ADAPTER_SCORE_KEYS)[number], number>;

/**
 * Keep a new adapter only if held-out, safety, tool-call and language scores did
 * not drop against the base. Anything missing or not a number counts as a drop,
 * so a gate that measured nothing discards the adapter (automatic rollback).
 */
export function acceptAdapter(
  before: Partial<AdapterScores> | null | undefined,
  after: Partial<AdapterScores> | null | undefined,
): { accept: boolean; dropped: string[] } {
  const dropped = ADAPTER_SCORE_KEYS.filter((key) => {
    const a = before?.[key];
    const b = after?.[key];
    if (
      typeof a !== "number" ||
      typeof b !== "number" ||
      !Number.isFinite(a) ||
      !Number.isFinite(b)
    )
      return true;
    return b < a;
  });
  return { accept: dropped.length === 0, dropped };
}

/**
 * Propose ONE training run and, if the owner approves, actually train.
 *
 * Nothing starts unless the owner opted in (brain.learn.adapters), the gate is
 * open and provenance-tagged rows survive selection. The governance item carries
 * the real numbers so the approval is informed, and the run itself is local-only.
 */
export async function proposeFinetune(options: {
  base: string;
  epochs?: number;
  rank?: number;
  learningRate?: number;
  quantised?: boolean;
  /** brain.learn.adapters. Default false. */
  adaptersEnabled?: boolean;
  gate?: Omit<TrainingGateInput, "enabled">;
  rows?: TrainingRow[];
  classesAccepted?: string[];
  classify?: PrivacyClassify;
}): Promise<{ started: boolean; reason?: string; run?: FinetuneRun }> {
  if (!finetuneAvailable()) return { started: false, reason: NO_DESKTOP };
  if (options.adaptersEnabled !== true) {
    return {
      started: false,
      reason: "On-device learning is off. Turn it on in Settings first; nothing trains by default.",
    };
  }
  const gate = trainingGate({ ...options.gate, enabled: true });
  if (!gate.allowed) {
    return { started: false, reason: `Training waits: ${gate.reasons.join(", ")}.` };
  }

  const readiness = await finetuneProbe();
  if (!readiness.ready) return { started: false, reason: readiness.detail };

  const selection = await selectTrainingRows(options.rows ?? [], {
    classesAccepted: options.classesAccepted ?? [],
    ...(options.classify ? { classify: options.classify } : {}),
  });
  const { train: examples, heldOut } = splitHeldOut(selection.rows);
  if (examples.length < MIN_EXAMPLES) {
    return {
      started: false,
      reason: `Only ${examples.length} safe example(s) so far — I need at least ${MIN_EXAMPLES} before training is worth it.`,
    };
  }

  const holder: { run: FinetuneRun | undefined; error: string | undefined } = {
    run: undefined,
    error: undefined,
  };
  const item = await governance.submit({
    kind: "self-upgrade",
    title: `Train a local adapter for ${options.base}`,
    rationale: `${examples.length} verified successes become a LoRA${readiness.quantised ? "/QLoRA" : ""} adapter for ${options.base}, with ${heldOut.length} held out to check it. Everything runs on this PC — no data leaves the machine — and the current model stays available to switch back to.`,
    risk: "review",
    evidence: [
      `base:${options.base}`,
      `examples:${examples.length}`,
      `heldout:${heldOut.length}`,
      readiness.quantised ? "mode:qlora-4bit" : "mode:lora",
      `python:${readiness.python ?? "unknown"}`,
    ],
    apply: async () => {
      const result = await bridge()!.finetuneStart!({
        base: options.base,
        examples,
        heldOut,
        classesAccepted: options.classesAccepted ?? [],
        adaptersEnabled: true,
        ...(options.epochs ? { epochs: options.epochs } : {}),
        ...(options.rank ? { rank: options.rank } : {}),
        ...(options.learningRate ? { learningRate: options.learningRate } : {}),
        ...(options.quantised === undefined ? {} : { quantised: options.quantised }),
      });
      holder.run = result.run;
      holder.error = result.error;
      return {
        ok: Boolean(result.ok),
        detail: result.ok
          ? `training started (${examples.length} examples)`
          : (result.error ?? "the trainer could not start"),
      };
    },
  });

  if (item.stage === "rejected") {
    return { started: false, reason: "You did not approve the training run, so nothing ran." };
  }
  if (item.stage !== "completed" || !holder.run) {
    return {
      started: false,
      reason: holder.error ?? item.error ?? "The training run did not start.",
    };
  }
  return { started: true, run: holder.run };
}

/**
 * Switch FRIDAY to a trained adapter — or back to the plain base model by
 * passing null. This is the rollback path: every version stays on disk.
 */
export const activateAdapter = (id: string | null) =>
  bridge()?.finetuneActivate?.(id) ?? Promise.resolve({ ok: false, error: NO_DESKTOP });
