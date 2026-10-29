import { describe, expect, it } from "vitest";

import { compileContextPacket } from "../../src/lib/friday/brain/context-engine";
import {
  finishCognitiveCycle,
  planCognitiveDepth,
} from "../../src/lib/friday/brain/cognitive-control";
import type { CognitiveRoute } from "../../src/lib/friday/brain/cognitive-route";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import { deliberateModes, selectReasoningMode } from "../../src/lib/friday/brain/reasoning";
import { reconcileTemporalBeliefs } from "../../src/lib/friday/brain/world-model";
import { learning, resetAntiAnchorLedger } from "../../src/lib/friday/self/learning-engine";

const fastRoute: CognitiveRoute = {
  klass: "simple",
  action: "fast-path",
  reason: "test",
};

const stakesRoute: CognitiveRoute = {
  klass: "high-stakes",
  action: "multi-verify",
  reason: "test",
};

describe("cognitive control", () => {
  it("drops stale low-value context and keeps a contradiction inside the budget", () => {
    const packet = compileContextPacket(
      [
        {
          id: "stale",
          role: "fact",
          text: "old weather from last month that is no longer useful here",
          source: "memory",
          at: new Date(0).toISOString(),
          confidence: 0.2,
          stale: true,
        },
        {
          id: "clash",
          role: "belief",
          text: "kernel is down",
          source: "observe",
          at: new Date(1_700_000_000_000).toISOString(),
          confidence: 0.4,
          conflict: true,
        },
        {
          id: "goal",
          role: "goal",
          text: "restart the kernel safely",
          source: "intent",
          at: new Date(1_700_000_000_000).toISOString(),
          confidence: 0.9,
        },
        {
          id: "dump",
          role: "memory",
          text: "x".repeat(200),
          source: "memory",
          at: new Date(1_700_000_000_000).toISOString(),
          confidence: 0.55,
        },
      ],
      80,
    );

    expect(packet.included.map((item) => item.id)).toContain("clash");
    expect(packet.included.map((item) => item.id)).not.toContain("stale");
    expect(packet.dropped.find((item) => item.id === "stale")?.reason).toMatch(/stale/);
    expect(packet.dropped.find((item) => item.id === "dump")?.reason).toMatch(/budget/);
    expect(packet.included.find((item) => item.id === "clash")?.reason).toMatch(/contradiction/);
    expect(packet.used).toBeLessThanOrEqual(80);
  });

  it("does not let a newer model write replace an earlier observed fact", () => {
    const marks = reconcileTemporalBeliefs(
      [
        {
          key: "Kernel",
          value: "up",
          source: "doctor",
          at: 1_000,
          confidence: 0.8,
          provenance: "observed",
        },
        {
          key: "kernel",
          value: "down",
          source: "model",
          at: 9_000,
          confidence: 0.95,
          provenance: "model",
        },
      ],
      10_000,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]?.status).toBe("contradicted");
    expect(marks[0]?.value).toBe("up");
    expect(marks[0]?.challenger).toMatch(/down/);
    expect(marks[0]?.confidence).toBeLessThanOrEqual(1);
    expect(marks[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const tied = reconcileTemporalBeliefs(
      [
        {
          key: "route",
          value: "alpha",
          source: "a",
          at: 100,
          confidence: 0.8,
          provenance: "model",
        },
        {
          key: "route",
          value: "beta",
          source: "b",
          at: 500,
          confidence: 0.8,
          provenance: "model",
        },
      ],
      1_000,
    );
    expect(tied[0]?.value).toBe("alpha");

    const empty = reconcileTemporalBeliefs(
      [
        {
          key: "desk",
          value: "  ",
          source: "none",
          at: 10,
          confidence: 0.9,
          provenance: "model",
        },
      ],
      20,
    );
    expect(empty[0]?.status).toBe("unknown");
    expect(empty[0]?.confidence).toBe(0);
  });

  it("selects a mode and keeps exactly one deliberative path", () => {
    expect(selectReasoningMode({ prompt: "why did the kernel stop responding" })).toBe("causal");
    expect(selectReasoningMode({ prompt: "what if the route changes" })).toBe("simulation");
    expect(selectReasoningMode({ prompt: "hello there" })).toBe("direct");

    const fast = deliberateModes({ primary: "direct", depth: "fast" });
    expect(fast).toHaveLength(1);
    expect(fast.filter((row) => row.kept)).toHaveLength(1);

    const searched = deliberateModes({
      primary: "direct",
      depth: "metacognitive",
      consequential: true,
      hasEvidence: false,
    });
    expect(searched.length).toBeGreaterThan(1);
    expect(searched.length).toBeLessThanOrEqual(3);
    expect(searched.filter((row) => row.kept)).toHaveLength(1);
    expect(searched.find((row) => row.kept)?.mode).not.toBe("direct");
  });

  it("keeps a fast path light and hands high-stakes work to authority", () => {
    const light = planCognitiveDepth({
      prompt: "write a haiku about rain",
      kind: "chat",
      route: fastRoute,
      confidence: 0.9,
      ambiguous: false,
    });
    expect(light.depth).toBe("fast");
    expect(light.mode).toBe("direct");
    expect(light.forceDeep).toBe(false);

    const stakes = planCognitiveDepth({
      prompt: "delete the project files",
      kind: "system",
      route: stakesRoute,
      confidence: 0.8,
      ambiguous: false,
    });
    expect(stakes.depth).toBe("metacognitive");
    expect(stakes.forceDeep).toBe(true);

    const cycle = finishCognitiveCycle({
      prompt: "delete the project files",
      plan: stakes,
      route: stakesRoute,
      confidence: 0.8,
      ambiguous: false,
      consequential: true,
      toolFailed: true,
      now: 1_700_000_000_000,
    });
    expect(cycle.intent.executes).toBe(false);
    expect(cycle.intent.authority).toBe("handoff");
    expect(cycle.interrupt.user).toBe(false);
    expect(cycle.interrupt.reason).toBe("proactive silence");
    expect(cycle.experience?.applied).toBe(false);
    expect(cycle.experience?.alternative).not.toBe(cycle.experience?.failedStrategy);
    expect(cycle.candidates.filter((row) => row.kept)).toHaveLength(1);
    expect(cycle.debts.length).toBeGreaterThan(0);
    expect(cycle.at).toMatch(/T.*Z$/);
  });

  it("files an anti-anchor candidate once and does not apply it", () => {
    resetAntiAnchorLedger();
    const first = learning.fileAntiAnchor({
      taskId: "cognitive-control-task",
      failedStrategy: "direct",
      alternative: "retrieval",
      whyDifferent: "retrieval is a different strategy",
    });
    expect(first.stored).toBe(true);
    expect(first.applied).toBe(false);
    const second = learning.fileAntiAnchor({
      taskId: "cognitive-control-task",
      failedStrategy: "direct",
      alternative: "decomposition",
      whyDifferent: "should not replace the first candidate",
    });
    expect(second.stored).toBe(false);
    expect(second.applied).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("attaches the same control record on a light turn and a high-stakes turn", async () => {
    const haiku = await coreBrain.cognize("write a haiku about rain", {
      mode: "manual",
      allowTools: false,
    });
    expect(haiku.notes.join(" ")).toMatch(/fabric: light/);
    expect(haiku.notes.join(" ")).not.toMatch(/world state:/);
    expect(haiku.control?.depth).toBe("fast");
    expect(haiku.control?.intent.executes).toBe(false);
    expect(haiku.control?.interrupt.user).toBe(false);

    const risky = await coreBrain.cognize("delete the project files", {
      mode: "manual",
      allowTools: false,
    });
    expect(risky.control?.intent.authority).toBe("handoff");
    expect(risky.control?.intent.executes).toBe(false);
    expect(risky.notes.join(" ")).toMatch(/executive:/);
    expect(risky.notes.join(" ")).toMatch(/executes: false/);

    const causal = await coreBrain.cognize("why did the kernel stop responding", {
      mode: "manual",
      allowTools: false,
    });
    expect(["causal", "verification-first", "hypothesis", "recovery"]).toContain(
      causal.control?.mode,
    );
    expect(causal.control?.intent.executes).toBe(false);
  });
});
