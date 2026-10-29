/**
 * Orchestrator efficiency: duplicate-work reuse via the existing task ledger
 * / experience store, and local-first ordering when a local model's measured
 * reliability already beats CONFIDENT_THRESHOLD. Not a second router.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { CONFIDENT_THRESHOLD } from "../../src/lib/friday/brain/confidence";
import { orderByConfidence } from "../../src/lib/friday/brain/cost-policy";
import { COLLABORATION_GAP, considerCollaboration } from "../../src/lib/friday/brain/multi-model";
import {
  PROVEN_LOCAL_BOOST,
  scoreForRole,
  type ModelCapabilityRecord,
} from "../../src/lib/friday/brain/model-registry";
import {
  dispatchRole,
  hasProvenLocal,
  orderCandidatesForRole,
  planPipeline,
  rolesForTask,
} from "../../src/lib/friday/brain/orchestrator";
import {
  experiences,
  findRecentSubTask,
  ledger,
  rememberSubTask,
} from "../../src/lib/friday/self/task-ledger";

const record = (
  id: string,
  kind: "local" | "cloud",
  extra: Partial<ModelCapabilityRecord> = {},
): ModelCapabilityRecord =>
  ({
    id,
    name: id,
    version: "1",
    provider: kind === "local" ? "ollama" : "openai",
    kind,
    roles: ["planner"],
    contextK: 32,
    vision: false,
    audio: false,
    tools: false,
    speed: null,
    vramGb: 0,
    ramGb: 0,
    sizeGb: 0,
    cost: kind === "local" ? "free" : "metered",
    available: true,
    availability: "ready",
    reliability: null,
    performance: null,
    ...extra,
  }) as ModelCapabilityRecord;

const cloudChoice = { allowed: true, ids: new Set(["cloud-a"]) };

describe("rolesForTask stays lean", () => {
  it("does not invent extra roles for a greeting", () => {
    expect(rolesForTask({ prompt: "hello" })).toEqual(["fast"]);
  });

  it("plans code work as planner → coder → reviewer", () => {
    expect(rolesForTask({ prompt: "refactor this python function" })).toEqual([
      "planner",
      "coder",
      "reviewer",
    ]);
  });
});

describe("duplicate-work guard reuses the ledger instead of re-asking", () => {
  beforeEach(() => {
    experiences.clear();
    ledger.clearHistory();
  });

  it("finds an equivalent sub-task already answered this turn", () => {
    rememberSubTask({
      taskId: "turn-1",
      role: "planner",
      prompt: "summarize the quarterly sales report",
      result: "Revenue was up 12 percent.",
      modelId: "llama-local",
    });
    const hit = findRecentSubTask("planner", "summarize the quarterly sales report", {
      taskId: "turn-1",
    });
    expect(hit).not.toBeNull();
    expect(hit?.result).toMatch(/12 percent/);
    expect(hit?.sameTurn).toBe(true);
  });

  it("reduces model-call counts on a repeated sub-task (before / after)", async () => {
    const prompt = "summarize the quarterly sales report for the owner";
    let modelCalls = 0;
    const run = async () => {
      modelCalls += 1;
      return { modelId: "llama-local", result: "Revenue was up 12 percent.", latencyMs: 12 };
    };

    const first = await dispatchRole({ taskId: "turn-1", role: "planner", prompt, run });
    const afterFirst = modelCalls;
    const callsAfterFirst = experiences.getSnapshot().calls.length;

    const second = await dispatchRole({
      taskId: "turn-1",
      role: "planner",
      prompt: "summarize the quarterly sales report for the owner again",
      run,
    });
    const afterSecond = modelCalls;
    const callsAfterSecond = experiences.getSnapshot().calls.length;

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.result).toMatch(/12 percent/);
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
    expect(callsAfterFirst).toBe(1);
    expect(callsAfterSecond).toBe(1);

    // Evidence the guard actually saved a call: without it both dispatches run.
    expect(afterSecond).toBeLessThan(2);
    console.log(
      [
        "duplicate-work guard model-call counts",
        `  without guard (two equivalent planner asks): 2`,
        `  after first dispatch: modelCalls=${afterFirst} ledgerCalls=${callsAfterFirst} reused=${first.reused}`,
        `  after second equivalent dispatch: modelCalls=${afterSecond} ledgerCalls=${callsAfterSecond} reused=${second.reused}`,
        `  saved model calls: ${2 - afterSecond}`,
      ].join("\n"),
    );
  });

  it("does not reuse a different role on the same prompt", async () => {
    let modelCalls = 0;
    const run = async () => {
      modelCalls += 1;
      return { modelId: "llama-local", result: `call-${modelCalls}`, latencyMs: 5 };
    };
    const prompt = "refactor this typescript function to be safer";
    await dispatchRole({ taskId: "turn-2", role: "planner", prompt, run });
    await dispatchRole({ taskId: "turn-2", role: "coder", prompt, run });
    expect(modelCalls).toBe(2);
  });

  it("marks a planned step reused when the ledger already has the answer", async () => {
    await dispatchRole({
      taskId: "turn-3",
      role: "fast",
      prompt: "hello",
      run: async () => ({ modelId: "llama-local", result: "Hi — what do you need?", latencyMs: 4 }),
    });
    const pipeline = planPipeline({ prompt: "hello", taskId: "turn-3" });
    const fast = pipeline.steps.find((step) => step.role === "fast");
    expect(fast?.reused).toBe(true);
    expect(fast?.modelId).toBe("llama-local");
  });
});

describe("local-first economics consults measured reliability", () => {
  const lowConfidence = {
    score: 0.2,
    domains: ["coding" as const],
    local: false,
    rationale: "coding is still unproven",
  };

  it("keeps historical cloud-first order when local reliability is unproven", () => {
    const pool = [record("local-a", "local"), record("cloud-a", "cloud")];
    expect(hasProvenLocal(pool)).toBe(false);
    const viaPolicy = orderByConfidence(pool, lowConfidence, "allow-paid", new Set(), cloudChoice);
    const viaRole = orderCandidatesForRole(
      pool,
      lowConfidence,
      "allow-paid",
      new Set(),
      cloudChoice,
    );
    expect(viaPolicy.map((row) => row.id)).toEqual(["cloud-a", "local-a"]);
    expect(viaRole.map((row) => row.id)).toEqual(["cloud-a", "local-a"]);
  });

  it("prefers a proven local model over cloud even when domain confidence is low", () => {
    const pool = [
      record("local-a", "local", {
        reliability: 0.9,
        performance: {
          modelId: "local-a",
          runs: 12,
          successes: 11,
          failures: 1,
          avgMs: 40,
          avgTokensPerSec: 20,
          lastUsedAt: 1,
          lastError: null,
        },
      }),
      record("cloud-a", "cloud", { reliability: 0.95 }),
    ];
    expect(hasProvenLocal(pool)).toBe(true);
    expect(pool[0]!.reliability! >= CONFIDENT_THRESHOLD).toBe(true);
    const ordered = orderCandidatesForRole(
      pool,
      lowConfidence,
      "allow-paid",
      new Set(),
      cloudChoice,
    );
    expect(ordered.map((row) => row.id)).toEqual(["local-a", "cloud-a"]);
  });

  it("still honours free-only — proven local does not invent a paid bypass", () => {
    const pool = [
      record("local-a", "local", { reliability: 0.9 }),
      record("cloud-a", "cloud", { reliability: 0.99 }),
    ];
    const ordered = orderCandidatesForRole(
      pool,
      lowConfidence,
      "free-only",
      new Set(),
      cloudChoice,
    );
    expect(ordered.map((row) => row.id)).toEqual(["local-a"]);
  });

  it("scores a proven local model above cloud in the registry ranking", () => {
    const local = record("local-a", "local", { reliability: 0.9, roles: ["planner"] });
    const cloud = record("cloud-a", "cloud", { reliability: 0.95, roles: ["planner"] });
    expect(scoreForRole(local, "planner")).toBeGreaterThan(scoreForRole(cloud, "planner"));
    expect(scoreForRole(local, "planner")).toBeGreaterThan(PROVEN_LOCAL_BOOST);
  });
});

describe("collaboration matching is unchanged", () => {
  it("still stays on one model for ordinary work", () => {
    expect(considerCollaboration("write a haiku about rain").warranted).toBe(false);
  });

  it("still fans out on a real capability gap that actually matters", () => {
    const prompt = "delete the production database migration before I deploy the release";
    const decision = considerCollaboration(prompt, {
      confidence: {
        score: COLLABORATION_GAP - 0.1,
        domains: ["coding"],
        local: false,
        rationale: "gap",
      },
    });
    expect(decision.warranted).toBe(true);
    expect(decision.initiator).toBe("friday");
    expect(decision.count).toBeGreaterThanOrEqual(2);
  });

  it("does not reuse when a second opinion must actually run", async () => {
    experiences.clear();
    ledger.clearHistory();
    let modelCalls = 0;
    const run = async () => {
      modelCalls += 1;
      return { modelId: `model-${modelCalls}`, result: `opinion-${modelCalls}`, latencyMs: 3 };
    };
    const prompt = "check this with two models before I ship";
    await dispatchRole({ taskId: "collab", role: "planner", prompt, run, allowReuse: false });
    await dispatchRole({ taskId: "collab", role: "planner", prompt, run, allowReuse: false });
    expect(modelCalls).toBe(2);
  });
});
