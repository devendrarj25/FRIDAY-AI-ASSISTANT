import { describe, expect, it } from "vitest";

import { finishCognitiveCycle } from "../../src/lib/friday/brain/cognitive-control";
import type { CognitiveRoute } from "../../src/lib/friday/brain/cognitive-route";
import {
  applyTransition,
  decayRelevance,
  evaluateGates,
  noteCommittedAction,
  noteStrategyFailure,
  rememberGoal,
  replanGoal,
  resetCognitiveRuntime,
  resumeMark,
  runCognitiveRuntime,
  walkStates,
} from "../../src/lib/friday/brain/cognitive-runtime";

const stakes: CognitiveRoute = {
  klass: "high-stakes",
  action: "multi-verify",
  reason: "test",
};

describe("cognitive runtime", () => {
  it("rejects a jump that skips the allowed path and does not re-run a side effect", () => {
    resetCognitiveRuntime();
    const jumped = walkStates({
      turnId: "jump",
      states: ["RECEIVING", "EXECUTING", "COMPLETE"],
      reason: "skip",
      at: 1_700_000_000_000,
    });
    expect(jumped.state).toBe("BLOCKED");
    expect(jumped.trace.some((step) => step.accepted === false)).toBe(true);

    const blocked = applyTransition({
      from: "EXECUTING",
      to: "COMPLETE",
      reason: "skip verify",
      turnId: "jump-2",
      at: 1_700_000_000_000,
    });
    expect(blocked.accepted).toBe(false);
    expect(blocked.to).toBe("BLOCKED");

    const resumed = resumeMark({
      turnId: "done",
      state: "EXECUTING",
      sideEffectCommitted: true,
      at: "2026-01-01T00:00:00.000Z",
      version: 1,
    });
    expect(resumed.mayExecute).toBe(false);
    expect(resumed.state).toBe("OBSERVING");
    expect(resumed.reason).toMatch(/do not run it again/);
  });

  it("keeps pinned memory, closes a repeated strategy, and replans a contradicted goal", () => {
    resetCognitiveRuntime();
    const fresh = decayRelevance({
      ageMs: 0,
      uses: 0,
      confidence: 0.8,
      superseded: false,
      userPinned: false,
      sensitive: false,
    });
    const old = decayRelevance({
      ageMs: 28 * 86_400_000,
      uses: 0,
      confidence: 0.8,
      superseded: false,
      userPinned: false,
      sensitive: false,
    });
    const pinned = decayRelevance({
      ageMs: 28 * 86_400_000,
      uses: 0,
      confidence: 0.8,
      superseded: true,
      userPinned: true,
      sensitive: false,
    });
    expect(old.rank).toBeLessThan(fresh.rank);
    expect(old.retained).toBe(true);
    expect(pinned.rank).toBeGreaterThan(old.rank);

    noteStrategyFailure("direct");
    noteStrategyFailure("direct");
    noteCommittedAction("direct");
    const gates = evaluateGates({
      claimingFact: false,
      confidence: 0.9,
      hasEvidence: true,
      strategy: "direct",
      consequential: false,
      degraded: false,
      successMet: true,
      openDebt: false,
    });
    expect(gates.closed.map((row) => row.id)).toContain("novelty");

    const goal = rememberGoal({
      outcome: "restore the kernel",
      success: "health answers",
      priority: 0.8,
    });
    const revised = replanGoal(goal.goal_id, "the last observation contradicted the plan");
    expect(revised?.needsReplan).toBe(true);
    expect(revised?.status).toBe("active");
  });

  it("finishes a light pass, hands off risk, and never claims another identity", () => {
    resetCognitiveRuntime();
    const light = runCognitiveRuntime({
      prompt: "write a haiku about rain",
      mode: "direct",
      depth: "fast",
      confidence: 0.9,
      now: 1_700_000_000_000,
    });
    expect(light.state).toBe("COMPLETE");
    expect(light.outcome).toBe("answered");
    expect(light.mayExecute).toBe(false);
    expect(light.interrupt).toBe(false);
    expect(light.trace.some((step) => step.to === "EXECUTING")).toBe(false);
    expect(light.self.identity).toBe("FRIDAY");
    expect(light.self.consciousnessClaim).toBe(false);
    expect(light.experienceAdopted).toBe(false);

    const risky = runCognitiveRuntime({
      prompt: "delete the project files",
      goal: "delete the project files safely",
      mode: "verification-first",
      depth: "metacognitive",
      confidence: 0.8,
      consequential: true,
      now: 1_700_000_000_000,
    });
    expect(risky.state).toBe("AUTHORITY_WAIT");
    expect(risky.outcome).toBe("handoff");
    expect(risky.mayExecute).toBe(false);
    expect(risky.gates.closed.map((row) => row.id)).toEqual(
      expect.arrayContaining(["risk", "authority"]),
    );
    expect(risky.anticipate).toMatch(/delete the project files/);

    const cycle = finishCognitiveCycle({
      prompt: "delete the project files",
      plan: {
        depth: "metacognitive",
        mode: "verification-first",
        reason: "test",
        forceDeep: true,
      },
      route: stakes,
      goal: "delete the project files safely",
      confidence: 0.8,
      ambiguous: false,
      consequential: true,
      now: 1_700_000_000_000,
    });
    expect(cycle.runtime.mayExecute).toBe(false);
    expect(cycle.runtime.state).toBe("AUTHORITY_WAIT");
    expect(cycle.intent.executes).toBe(false);
  });
});
