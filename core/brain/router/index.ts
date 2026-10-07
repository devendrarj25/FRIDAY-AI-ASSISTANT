/**
 * FRIDAY · core/brain/router
 *
 * The brain-side entry point: one request in, one ordered pipeline out. This
 * is what wires intent → context → reasoning → plan → decision together so
 * no caller reimplements the sequence.
 */
import type { FridayModule, ModuleContext } from "../../types";
import { classifyIntent, type Intent } from "../intent";
import { assess, type Assessment } from "../reasoning";
import { buildPlan, planWaves, type Plan, type PlanStep } from "../planner";
import { decideStep, verifyResult, type DecisionResult } from "../decision";
import { context } from "../../context";
import { bus } from "../../event-bus";

export interface BrainRequest {
  text: string;
  sessionId?: string;
  requester?: string;
}

export interface BrainPlan {
  intent: Intent;
  assessment: Assessment;
  plan: Plan;
  waves: PlanStep[][];
}

/** Pure planning pass: classifies, assesses and plans without executing. */
export function prepare(request: BrainRequest): BrainPlan {
  if (request.sessionId) context.startSession(request.sessionId);
  context.addTurn({ role: "user", text: request.text, at: Date.now() });

  const intent = classifyIntent(request.text);
  const assessment = assess(intent);
  const plan = buildPlan(intent);
  bus.emit("brain:prepared", {
    intent: intent.kind,
    complexity: assessment.complexity,
    steps: plan.steps.length,
  });
  return { intent, assessment, plan, waves: planWaves(plan) };
}

/** Asks the permission broker about every step that touches the machine. */
export async function authorize(
  brainPlan: BrainPlan,
  requester = "core/brain",
): Promise<Map<string, DecisionResult>> {
  const decisions = new Map<string, DecisionResult>();
  for (const step of brainPlan.plan.steps) {
    decisions.set(step.id, await decideStep(step, requester));
  }
  return decisions;
}

export { verifyResult };

export type RouterModule = FridayModule;

export const routerModule: RouterModule = {
  id: "core/brain/router",
  init(_ctx: ModuleContext) {},
};

export default routerModule;
