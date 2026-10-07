/**
 * FRIDAY · cost policy for model orchestration
 *
 * The owner's usage policy ("free only", "prefer free", "paid allowed") is
 * chosen once in the model selector and stored by the renderer model
 * registry. Until now only the free-first router in the main process obeyed
 * it — the Brain's own pipeline planner did not, so a paid cloud model could
 * still be planned into a step under a free-only policy.
 *
 * These are pure helpers so the planner and the tests share one rule set.
 * Nothing is invented: a cloud model counts as free only when live discovery
 * really reported a free tier for its provider.
 */

import { modelRegistry as usageRegistry, type UsagePolicy } from "../model-registry";
import { modelRegistry, type ModelCapabilityRecord } from "./model-registry";

export type { UsagePolicy };

/** The owner's current policy; free-first when nothing has been chosen yet. */
export function currentPolicy(): UsagePolicy {
  try {
    return usageRegistry.getSnapshot().policy || "free-preferred";
  } catch {
    return "free-preferred";
  }
}

/** Providers that live discovery reported as having a usable free model. */
export function freeModelIds(): Set<string> {
  try {
    const snapshot = usageRegistry.getSnapshot();
    return new Set(
      snapshot.models
        .filter((model) => model.type === "cloud" && model.access === "free")
        .map((model) => model.id),
    );
  } catch {
    return new Set<string>();
  }
}

/** @deprecated provider-wide free is incorrect; kept as the set of free model ids. */
export function freeProviders(): Set<string> {
  return freeModelIds();
}

/** True when using this model costs the owner nothing. */
export function isFree(
  record: ModelCapabilityRecord,
  free: Set<string> = freeProviders(),
): boolean {
  if (record.kind === "local" || record.cost === "free") return true;
  const access = String((record as ModelCapabilityRecord & { access?: string }).access || "");
  if (access === "free") return true;
  // A provider that has some free models does not make every model free.
  // The optional set is model ids (and only those ids) that live discovery
  // already classified as free.
  if (free.has(record.id)) return true;
  return false;
}

/**
 * HARD SAFETY RULE — cloud is opt-in and manual only.
 *
 * A cloud/paid provider is only ever a candidate when the owner has manually
 * picked it for this use: an explicit selection in the model menu, or a route
 * mode that IS an explicit cloud choice ("Cloud only", "Manual", "Multi").
 * FRIDAY never proposes, defaults to, or falls back to a cloud model on her
 * own — this machine's local models are free and unlimited by design.
 */
export type CloudChoice = { allowed: boolean; ids: Set<string> };

export function manualCloudChoice(): CloudChoice {
  try {
    const snapshot = usageRegistry.getSnapshot();
    const ids = new Set((snapshot.selected ?? []).filter(Boolean));
    const mode = snapshot.routeMode;
    const explicit = mode === "cloud-only" || mode === "manual" || mode === "multi";
    return { allowed: explicit || ids.size > 0, ids };
  } catch {
    return { allowed: false, ids: new Set<string>() };
  }
}

/** Is THIS cloud model one the owner manually selected right now? */
function cloudPermitted(record: ModelCapabilityRecord, choice = manualCloudChoice()): boolean {
  if (record.kind !== "cloud") return true;
  if (!choice.allowed) return false;
  // With no id picked, an explicit cloud route mode is itself the pick.
  if (!choice.ids.size) return true;
  return [...choice.ids].some(
    (id) => id === record.id || record.id.includes(id) || id.includes(record.id),
  );
}

/**
 * Drops models the policy forbids outright, and every cloud model the owner
 * has not manually chosen. Never empties a local-only list.
 */
export function allowedByPolicy(
  records: ModelCapabilityRecord[],
  policy: UsagePolicy = currentPolicy(),
  free: Set<string> = freeProviders(),
  choice: CloudChoice = manualCloudChoice(),
): ModelCapabilityRecord[] {
  const optedIn = records.filter((record) => cloudPermitted(record, choice));
  if (policy === "free-only") return optedIn.filter((record) => isFree(record, free));
  if (policy === "paid-only")
    return optedIn.filter((record) => record.kind === "cloud" && !isFree(record, free));
  return optedIn;
}

/**
 * Orders candidates under the policy: free choices first when free is
 * preferred, original (measured) order kept inside each group.
 */
export function orderByPolicy(
  records: ModelCapabilityRecord[],
  policy: UsagePolicy = currentPolicy(),
  free: Set<string> = freeProviders(),
  choice: CloudChoice = manualCloudChoice(),
): ModelCapabilityRecord[] {
  const allowed = allowedByPolicy(records, policy, free, choice);
  if (policy === "allow-paid" || policy === "paid-only") return allowed;
  const cheap = allowed.filter((record) => isFree(record, free));
  const paid = allowed.filter((record) => !isFree(record, free));
  return [...cheap, ...paid];
}

/**
 * The real local-vs-external decision. Cost is still a hard floor — a
 * free-only policy never lets a paid model through, whatever the confidence —
 * but WITHIN what the policy allows the order now depends on whether FRIDAY
 * actually trusts herself to finish this task locally:
 *
 *   confident  → local/free first (the historical behaviour)
 *   not confident → the strongest allowed cloud model first, because doing the
 *                   job badly for free is not the cheaper outcome.
 *
 * This replaces the static rule inside the existing planner; there is still
 * exactly one router.
 */
export function orderByConfidence(
  records: ModelCapabilityRecord[],
  confidence: { local: boolean },
  policy: UsagePolicy = currentPolicy(),
  free: Set<string> = freeProviders(),
  choice: CloudChoice = manualCloudChoice(),
): ModelCapabilityRecord[] {
  // `allowedByPolicy` has already removed every cloud model the owner did not
  // manually choose, so low confidence can only reorder models he opted into —
  // it can never introduce a cloud provider by itself.
  const allowed = allowedByPolicy(records, policy, free, choice);
  if (confidence.local || policy === "free-only" || policy === "paid-only")
    return orderByPolicy(allowed, policy, free, choice);

  const cloud = allowed.filter((record) => record.kind === "cloud");
  if (!cloud.length) return orderByPolicy(allowed, policy, free, choice);
  const rest = allowed.filter((record) => record.kind !== "cloud");
  // Under free-preferred a free cloud model still outranks a paid one.
  const ordered =
    policy === "allow-paid"
      ? cloud
      : [...cloud.filter((r) => isFree(r, free)), ...cloud.filter((r) => !isFree(r, free))];
  return [...ordered, ...rest];
}

/** One short line explaining the policy, for the pipeline notes. */
export function describePolicy(policy: UsagePolicy = currentPolicy()): string {
  switch (policy) {
    case "free-only":
      return "paid models are excluded — usage policy is free only";
    case "free-preferred":
      return "free models are preferred; a paid model is used only when nothing free fits";
    case "paid-only":
      return "only paid models are eligible — free and local models are excluded";
    default:
      return "paid models are allowed for this owner";
  }
}

/**
 * The same rule applied to a list of model ids, for the routers that work
 * with ids rather than capability records (runtime turn routing, pinned
 * routing, fallback lists). An id the capability registry does not know is
 * kept only when it does not look like a paid cloud model: under free-only,
 * `gpt-4o` / `openai/...` must not slip through just because the catalog
 * has not indexed them yet. Generic local names (`mystery`, `llama-local`)
 * stay, and the main-process router plus the billing firewall still gate
 * every request before any money can be spent.
 */
const PAID_UNKNOWN_ID =
  /^(gpt-|o1-|o3-|o4-|claude-|gemini-|command-r|mistral-large|openai\/|anthropic\/|google\/gemini)/i;

export function looksLikeUnknownPaidId(id: string): boolean {
  const value = String(id || "");
  if (PAID_UNKNOWN_ID.test(value)) return true;
  return /\/(gpt-|claude-|gemini-|o1-|o3-)/i.test(value);
}

export function allowedModelIds(
  ids: string[],
  policy: UsagePolicy = currentPolicy(),
  free: Set<string> = freeProviders(),
  lookup: (id: string) => ModelCapabilityRecord | null = (id) => modelRegistry.get(id),
  choice: CloudChoice = manualCloudChoice(),
): string[] {
  const known = new Map<string, ModelCapabilityRecord>();
  for (const id of ids) {
    const record = (() => {
      try {
        return lookup(id);
      } catch {
        return null;
      }
    })();
    if (record) known.set(id, record);
  }

  const permitted = new Set(
    allowedByPolicy(Array.from(known.values()), policy, free, choice).map((record) => record.id),
  );
  const kept = ids.filter((id) => {
    if (known.has(id)) return permitted.has(id);
    if (policy === "free-only" && looksLikeUnknownPaidId(id)) return false;
    if (policy === "paid-only") return false;
    return true;
  });
  if (policy === "allow-paid" || policy === "paid-only") return kept;

  // Free choices first under free-preferred, unknown ids keep their place
  // relative to the paid ones they were listed with.
  const cheap = kept.filter((id) => {
    const record = known.get(id);
    return record ? isFree(record, free) : false;
  });
  const rest = kept.filter((id) => !cheap.includes(id));
  return [...cheap, ...rest];
}
