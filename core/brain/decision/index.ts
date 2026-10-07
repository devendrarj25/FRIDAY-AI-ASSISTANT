/**
 * FRIDAY · core/brain/decision
 *
 * The gate between "planned" and "executed". Decides for each step whether it
 * runs, needs consent, or is refused — and verifies the result afterwards.
 */
import type { FridayModule, ModuleContext } from "../../types";
import type { PlanStep } from "../planner";
import { permissions } from "../../permissions";
import { bus } from "../../event-bus";

export type Verdict = "run" | "approved" | "refused";

export interface DecisionResult {
  verdict: Verdict;
  reason?: string;
}

export async function decideStep(step: PlanStep, requester: string): Promise<DecisionResult> {
  if (!step.capability) return { verdict: "run" };
  const target =
    (step.input?.["paths"] as string[] | undefined)?.[0] ??
    (step.input?.["apps"] as string[] | undefined)?.[0] ??
    step.target;
  const result = await permissions.request({
    capability: step.capability,
    target,
    requester,
    reason: step.description,
  });
  bus.emit("decision:made", { stepId: step.id, granted: result.granted });
  if (!result.granted) {
    return { verdict: "refused", ...(result.reason ? { reason: result.reason } : {}) };
  }
  return { verdict: "approved" };
}

export interface Verification {
  ok: boolean;
  detail: string;
}

/** Result verification: an action is only reported as done when it produced something. */
export function verifyResult(step: PlanStep, result: unknown, error?: unknown): Verification {
  if (error) return { ok: false, detail: String(error) };
  if (result === undefined || result === null) {
    return { ok: false, detail: `${step.target} returned nothing` };
  }
  if (typeof result === "string" && result.trim() === "") {
    return { ok: false, detail: `${step.target} returned an empty response` };
  }
  return { ok: true, detail: "verified" };
}

export type DecisionModule = FridayModule;

export const decisionModule: DecisionModule = {
  id: "core/brain/decision",
  init(_ctx: ModuleContext) {},
};

export default decisionModule;
