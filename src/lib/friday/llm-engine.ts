/**
 * FRIDAY · the dual chat engine, as the screens see it.
 *
 * Two bridge calls (`llmEngineState`, `llmEngineBench`) and the plain words around them. The state is read on demand
 * (the shared poller or a button), never on a timer of its own. Every outcome of a bench has a sentence.
 */
import type { EnginePrefer } from "./preferences";

export type EngineRow = {
  installed: boolean;
  tag: string | null;
  backend: string | null;
  healthy: boolean;
  name: string | null;
};

export type EngineDoctorRow = { id: string; name: string; ok: boolean; detail: string };

export type EngineState = {
  ok: boolean;
  error?: string;
  prefer?: EnginePrefer;
  active?: "own" | "official" | null;
  reason?: string;
  outdated?: boolean;
  own?: EngineRow;
  official?: EngineRow;
  bench?: {
    winner: string;
    ownTps: number;
    officialTps: number;
    sameTokens: boolean;
    at: number;
  } | null;
  thresholdsUnverified?: boolean;
  rows?: { own: string; official: string; status: string | null; outdated: string | null };
  doctor?: EngineDoctorRow[];
  adapter?: { id: string | null; scale: number; reason: string | null };
  benchRunning?: boolean;
};

export type BenchResult = {
  ok: boolean;
  ran?: boolean;
  stored?: boolean;
  stopping?: boolean;
  winner?: string;
  reason?: string;
  error?: string;
  ownTps?: number;
  officialTps?: number;
  speedup?: number;
};

type Bridge = {
  llmEngineState?: (payload?: { prefer?: EnginePrefer }) => Promise<EngineState>;
  llmEngineBench?: (payload?: { stop?: boolean }) => Promise<BenchResult>;
};

const bridge = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as Bridge | undefined);

export const llmEngineAvailable = () => Boolean(bridge()?.llmEngineState);

const NO_DESKTOP = "Engine choice and the benchmark run in the installed FRIDAY desktop app.";

export async function readEngineState(prefer?: EnginePrefer): Promise<EngineState> {
  const read = bridge()?.llmEngineState;
  if (!read) return { ok: false, error: NO_DESKTOP };
  return read(prefer ? { prefer } : {});
}

export async function startBench(): Promise<BenchResult> {
  const run = bridge()?.llmEngineBench;
  if (!run) return { ok: false, ran: false, reason: "error", error: NO_DESKTOP };
  try {
    return await run({});
  } catch (failure) {
    return {
      ok: false,
      ran: false,
      reason: "error",
      error: failure instanceof Error ? failure.message : String(failure),
    };
  }
}

export async function stopBench(): Promise<BenchResult> {
  const run = bridge()?.llmEngineBench;
  if (!run) return { ok: false, error: NO_DESKTOP };
  return run({ stop: true });
}

/** Plain names for the three choices of `brain.engine.prefer`. */
export function engineLabel(choice: EnginePrefer): string {
  if (choice === "own") return "FRIDAY Runtime LLM (own)";
  if (choice === "official") return "llama.cpp (official)";
  return "Automatic";
}

/** One sentence for the outcome of a bench. */
export function benchMessage(result: BenchResult): string {
  if (result.ok && result.ran) {
    const gain =
      result.ownTps && result.officialTps
        ? ` (own ${result.ownTps.toFixed(1)} and official ${result.officialTps.toFixed(1)} tokens a second)`
        : "";
    return result.winner === "own"
      ? `FRIDAY Runtime LLM was faster on this PC and will be used${gain}.`
      : `llama.cpp (official) stays: the own build did not beat it on this PC${gain}.`;
  }
  switch (result.reason) {
    case "voice-turn":
      return "A voice turn is running. Try the benchmark again when it has ended.";
    case "already-running":
      return "A benchmark is already running.";
    case "needs-both-engines":
      return "Both engines have to be installed before they can be compared.";
    case "own-outdated":
      return "The own build is outdated against the official one, so the official engine stays until it is rebuilt.";
    case "no-model":
      return "No local model is installed yet, so there is nothing to measure.";
    case "stopped":
      return "The benchmark was stopped. Nothing was saved and no engine was left running.";
    case "not-idle":
    case "governor-refused":
      return "This PC is busy right now. Try again when it is idle.";
    default:
      return result.error
        ? `The benchmark could not finish: ${result.error}`
        : "The benchmark measured nothing, so nothing was saved.";
  }
}

/** Where Undo goes: the previous adapter when one is older than the active one, else the plain base model. */
export function adapterUndoTarget(
  adapters: { id: string; finishedAt: number | null }[],
  active: string | null,
): { id: string | null } | null {
  if (!active) return null;
  const ordered = [...adapters].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const at = ordered.findIndex((entry) => entry.id === active);
  if (at < 0) return { id: null };
  return { id: ordered[at + 1]?.id ?? null };
}
