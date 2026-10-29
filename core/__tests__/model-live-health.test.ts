/**
 * Live model health overlay: desktop router cooldowns reach the brain
 * orchestrator through the existing usage registry. Not a second health system.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  isRoutable,
  scoreForRole,
  withLiveHealth,
  type ModelCapabilityRecord,
} from "../../src/lib/friday/brain/model-registry";
import {
  dispatchRole,
  pickHealthyModelId,
  planPipeline,
} from "../../src/lib/friday/brain/orchestrator";
import { problemsFromCoolingModels } from "../../src/lib/friday/brain/self-diagnosis";
import { experiences, ledger } from "../../src/lib/friday/self/task-ledger";

const record = (id: string, extra: Partial<ModelCapabilityRecord> = {}): ModelCapabilityRecord =>
  ({
    id,
    name: id,
    version: "1",
    provider: "ollama",
    kind: "local",
    roles: ["fast", "planner"],
    contextK: 32,
    vision: false,
    audio: false,
    tools: false,
    speed: null,
    vramGb: 0,
    ramGb: 0,
    sizeGb: 1,
    cost: "free",
    available: true,
    availability: "installed",
    reliability: 0.9,
    performance: null,
    ...extra,
  }) as ModelCapabilityRecord;

describe("withLiveHealth overlays desktop cooldowns onto catalog ids", () => {
  it("matches a catalog id to an engine tag and marks it unroutable", () => {
    const overlaid = withLiveHealth(
      [record("qwen2.5-32b", { name: "Qwen 2.5 32B" })],
      [
        {
          id: "ollama:qwen2.5:32b",
          modelName: "qwen2.5:32b",
          coolingDown: true,
          health: "rate_limited",
          healthCategory: "rate_limited",
        },
      ],
    );
    expect(overlaid[0]?.coolingDown).toBe(true);
    expect(overlaid[0]?.availability).toMatch(/cooling down/);
    expect(overlaid[0]?.healthCategory).toBe("rate_limited");
    expect(isRoutable(overlaid[0]!)).toBe(false);
  });

  it("leaves records unchanged when the usage registry has no live rows", () => {
    const base = [record("llama3.2-3b")];
    expect(withLiveHealth(base, [])).toEqual(base);
    expect(isRoutable(base[0]!)).toBe(true);
  });

  it("down-ranks a cooling model so it cannot win on catalog score alone", () => {
    const hot = record("local-hot", { coolingDown: false, reliability: 0.5 });
    const cold = record("local-cold", { coolingDown: true, reliability: 0.99 });
    expect(scoreForRole(hot, "planner")).toBeGreaterThan(scoreForRole(cold, "planner"));
  });
});

describe("orchestrator skips failed and cooling models without inventing success", () => {
  beforeEach(() => {
    experiences.clear();
    ledger.clearHistory();
  });

  it("notes excluded model ids on the pipeline even when the pool is empty", () => {
    const pipeline = planPipeline({
      prompt: "write a function",
      needsCode: true,
      excludeModelIds: ["failed-coder"],
    });
    expect(pipeline.notes.some((note) => /excluded failed model/.test(note))).toBe(true);
    expect(pipeline.notes.some((note) => note.includes("failed-coder"))).toBe(true);
  });

  it("does not record selection-only dispatch as a successful model run", async () => {
    const before = experiences.getSnapshot().calls.length;
    await dispatchRole({
      role: "fast",
      prompt: "orchestrator.route fast: hello",
      allowReuse: false,
      measure: false,
      run: async () => ({ modelId: "llama-local", result: "llama-local", success: true }),
    });
    expect(experiences.getSnapshot().calls.length).toBe(before);
  });

  it("still records a real role execution", async () => {
    const before = experiences.getSnapshot().calls.length;
    await dispatchRole({
      role: "planner",
      prompt: "summarize the report",
      allowReuse: false,
      run: async () => ({
        modelId: "llama-local",
        result: "Revenue was up.",
        success: true,
        latencyMs: 12,
      }),
    });
    expect(experiences.getSnapshot().calls.length).toBeGreaterThan(before);
  });

  it("keeps the planned id when nothing is cooling down", () => {
    const picked = pickHealthyModelId("fast", ["planned-local", "backup-local"]);
    expect(picked.modelId).toBe("planned-local");
    expect(picked.switched).toBe(false);
  });
});

describe("self-diagnosis names cooling models instead of hiding them", () => {
  it("reports cooldown as a warning with the real category", () => {
    const problems = problemsFromCoolingModels([
      { name: "Qwen 2.5 32B", coolingDown: true, healthCategory: "rate_limited" },
      { name: "Llama 3.2 3B", coolingDown: false, healthCategory: null },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.id).toBe("models:cooldown");
    expect(problems[0]?.severity).toBe("warning");
    expect(problems[0]?.detail).toMatch(/Qwen 2.5 32B \(rate_limited\)/);
    expect(problems[0]?.detail).not.toMatch(/Llama 3.2 3B/);
    expect(problems[0]?.fix).toMatch(/skip/i);
  });

  it("returns no problem when nothing is cooling", () => {
    expect(problemsFromCoolingModels([{ name: "Llama", coolingDown: false }])).toEqual([]);
  });
});
