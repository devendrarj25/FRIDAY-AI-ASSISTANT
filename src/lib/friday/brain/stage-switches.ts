/**
 * FRIDAY · measurement switches for optional Brain stages
 *
 * Lets a benchmark run the same turn with one optional stage off, to see what that stage is worth. Every
 * stage is on unless a measurement turns it off; nothing here is stored, so a restart is always the normal
 * Brain. Safety stages (firewalls, approvals, verification of consequential work) are not listed and cannot
 * be switched off.
 */

export const MEASURABLE_STAGES = [
  "world-insight",
  "meta-review",
  "vector-index",
  "knowledge-recall",
  "memory-retrieve",
  "context-recall",
] as const;

export type MeasurableStage = (typeof MEASURABLE_STAGES)[number];

const off = new Set<MeasurableStage>();

export function stageOff(stage: MeasurableStage): boolean {
  return off.has(stage);
}

/** Run `work` with the named stages off, then put them back exactly as they were, even on a throw. */
export async function withStagesOff<T>(
  stages: readonly MeasurableStage[],
  work: () => Promise<T> | T,
): Promise<T> {
  const added = stages.filter((stage) => MEASURABLE_STAGES.includes(stage) && !off.has(stage));
  for (const stage of added) off.add(stage);
  try {
    return await work();
  } finally {
    for (const stage of added) off.delete(stage);
  }
}
