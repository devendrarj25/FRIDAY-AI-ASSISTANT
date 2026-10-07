/** Voice stays short. Chat may take more steps. The clock is injected. */

export function thinkBudget(surface: "voice" | "chat"): { steps: number; ms: number } {
  if (surface === "voice") return { steps: 2, ms: 800 };
  return { steps: 6, ms: 8000 };
}

export function withinBudget(usedMs: number, surface: "voice" | "chat"): boolean {
  return usedMs <= thinkBudget(surface).ms;
}

export type DecisionTrace = { step: string; uncertain: string | null };

export function tracePlan(parts: string[], surface: "voice" | "chat"): DecisionTrace[] {
  const cap = thinkBudget(surface).steps;
  return parts.slice(0, cap).map((step, index) => ({
    step,
    uncertain:
      index === cap - 1 && parts.length > cap ? "more steps were cut for this surface" : null,
  }));
}
