/**
 * FRIDAY · core/brain/reasoning
 *
 * Estimates how hard a request is and how much context it deserves. The router
 * uses this instead of sending everything to the largest model.
 */
import type { FridayModule, ModuleContext } from "../../types";
import type { Intent } from "../intent";

export type Complexity = "low" | "medium" | "high";

export interface Assessment {
  complexity: Complexity;
  /** How many memory snippets are worth recalling for this request. */
  memoryDepth: number;
  /** Whether step-by-step reasoning should be requested from the model. */
  deliberate: boolean;
  reason: string;
}

export function assess(intent: Intent): Assessment {
  const words = intent.text.split(/\s+/).filter(Boolean).length;
  const multiPart = /\band then\b|;|\d\.\s|\bafter that\b/i.test(intent.text);
  const heavyKind = intent.kind === "code" || intent.kind === "workflow";

  let complexity: Complexity = "low";
  let reason = "short conversational request";
  if (heavyKind || multiPart || words > 60) {
    complexity = "high";
    reason = heavyKind ? `${intent.kind} request` : "multi-part or long request";
  } else if (words > 15 || intent.actionable) {
    complexity = "medium";
    reason = intent.actionable ? "request touches the machine" : "medium-length request";
  }

  return {
    complexity,
    memoryDepth: complexity === "high" ? 12 : complexity === "medium" ? 6 : 3,
    deliberate: complexity === "high",
    reason,
  };
}

export type ReasoningModule = FridayModule;

export const reasoningModule: ReasoningModule = {
  id: "core/brain/reasoning",
  init(_ctx: ModuleContext) {},
};

export default reasoningModule;
