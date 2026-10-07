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

type Bridge = {
  finetuneState?: () => Promise<FinetuneState>;
  finetuneProbe?: () => Promise<FinetuneReadiness>;
  finetuneStart?: (job: {
    base: string;
    examples: TrainingExample[];
    epochs?: number;
    rank?: number;
    learningRate?: number;
    quantised?: boolean;
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

/**
 * Propose ONE training run and, if the owner approves, actually train.
 *
 * The governance item carries the real numbers (base model, example count) so
 * the approval is informed, and the run itself is local-only.
 */
export async function proposeFinetune(options: {
  base: string;
  epochs?: number;
  rank?: number;
  learningRate?: number;
  quantised?: boolean;
  examples?: TrainingExample[];
}): Promise<{ started: boolean; reason?: string; run?: FinetuneRun }> {
  if (!finetuneAvailable()) return { started: false, reason: NO_DESKTOP };

  const readiness = await finetuneProbe();
  if (!readiness.ready) return { started: false, reason: readiness.detail };

  const examples = options.examples ?? buildTrainingSet();
  if (examples.length < MIN_EXAMPLES) {
    return {
      started: false,
      reason: `Only ${examples.length} verified example(s) so far — I need at least ${MIN_EXAMPLES} before training is worth it.`,
    };
  }

  const holder: { run: FinetuneRun | undefined; error: string | undefined } = {
    run: undefined,
    error: undefined,
  };
  const item = await governance.submit({
    kind: "self-upgrade",
    title: `Train a local adapter for ${options.base}`,
    rationale: `${examples.length} verified successes become a LoRA${readiness.quantised ? "/QLoRA" : ""} adapter for ${options.base}. Everything runs on this PC — no data leaves the machine — and the current model stays available to switch back to.`,
    risk: "review",
    evidence: [
      `base:${options.base}`,
      `examples:${examples.length}`,
      readiness.quantised ? "mode:qlora-4bit" : "mode:lora",
      `python:${readiness.python ?? "unknown"}`,
    ],
    apply: async () => {
      const result = await bridge()!.finetuneStart!({
        base: options.base,
        examples,
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
