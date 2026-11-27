/**
 * FRIDAY · "Learn from me": the inputs the training rails need, built from what the app really knows.
 *
 * The rails (`self/finetune.ts`) drop every row that is not provably the owner's own text with a clean context.
 * The experience ledger records the outcome of a task, not who wrote it or what sat in its context, so its rows are
 * tagged `unknown` and fail closed: nothing trains from them until the ledger records that provenance. A row that
 * used a tool is also tagged with a tool context, because tool output is data, never training.
 */
import { buildTrainingSet, type TrainingGateInput, type TrainingRow } from "./self/finetune";
import type { Experience } from "./self/task-ledger";
import type { GovernorStatus } from "./desktop";
import { kernelApi } from "./kernel-api";

/** The kernel reads this stored setting itself (it never asks the page), so the page writes it there too. */
export const GLOSSARY_SETTING_KEY = "brain.learn.glossary";

/** Store the glossary switch in the kernel. False when the kernel did not answer (offline or stalled). */
export async function mirrorGlossarySetting(on: boolean): Promise<boolean> {
  try {
    return (await kernelApi.settings.set(GLOSSARY_SETTING_KEY, on === true)) !== null;
  } catch {
    return false;
  }
}

/**
 * After a restart or an offline toggle: write the owner's choice into the kernel when it holds another one.
 * A kernel that never stored it counts as on (the default), so nothing is written for an untouched "on".
 */
export async function reconcileGlossarySetting(on: boolean): Promise<boolean> {
  try {
    const stored = await kernelApi.settings.get();
    if (!stored) return false;
    const held = stored.settings[GLOSSARY_SETTING_KEY];
    if ((held === undefined ? true : held !== false) === on) return true;
    return mirrorGlossarySetting(on);
  } catch {
    return false;
  }
}

/** The data class of rows that come from the experience ledger (`LEARN_DATA_CLASSES` in preferences.ts). */
export const LEDGER_DATA_CLASS = "verified-runs";

const responseModelOf = (item: Experience): "local" | "cloud" | "unknown" => {
  const kinds = (item.models ?? []).map((model) => model.kind);
  if (!kinds.length) return "unknown";
  if (kinds.includes("cloud")) return "cloud";
  return kinds.every((kind) => kind === "local") ? "local" : "unknown";
};

/** One candidate row per verified success, each with its provenance tag. */
export function rowsFromExperiences(items: Experience[]): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (const item of items) {
    const [example] = buildTrainingSet([item]);
    if (!example) continue;
    rows.push({
      ...example,
      dataClass: LEDGER_DATA_CLASS,
      provenance: {
        promptAuthor: "unknown",
        contextKinds: item.tools?.length ? ["tool"] : undefined,
        responseModel: responseModelOf(item),
      },
    });
  }
  return rows;
}

/**
 * What the resource governor says about this PC right now, as the inputs of `trainingGate`. Anything the governor
 * does not state is not true: no status means blocked. "Lease" here means the governor reports room for a
 * background job; the lease itself is taken by the trainer when it starts.
 */
export function gateFromGovernor(
  status: GovernorStatus | null | undefined,
): Omit<TrainingGateInput, "enabled"> {
  if (!status || !status.ok) return {};
  const voice = status.leases.some((lease) => lease.priority === "voice");
  const chat = status.leases.some((lease) => lease.priority === "chat");
  const calm = status.level === "ok" && !status.lag.paused && status.holds.length === 0;
  return {
    idle: calm && !voice && !chat,
    onAc: status.power.stress === "none",
    inVoiceTurn: voice,
    leaseGranted: calm,
  };
}
