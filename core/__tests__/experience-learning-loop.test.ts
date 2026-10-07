import { beforeEach, describe, expect, it } from "vitest";
import { experiences, approachSignature } from "../../src/lib/friday/self/task-ledger";
import { compareToBaseline } from "../../src/lib/friday/self/dev-pipeline";
import { learnedSkillCandidates } from "../../src/lib/friday/brain/skill-forge";
import { buildTrainingSet, MIN_EXAMPLES } from "../../src/lib/friday/self/finetune";
import { allowedByPolicy } from "../../src/lib/friday/brain/cost-policy";
import type { ModelCapabilityRecord } from "../../src/lib/friday/brain/model-registry";

const record = (id: string, kind: "local" | "cloud"): ModelCapabilityRecord =>
  ({
    id,
    kind,
    provider: kind === "local" ? "ollama" : "openai",
    label: id,
    capabilities: { chat: true },
    tier: "standard",
  }) as unknown as ModelCapabilityRecord;

const seed = (count: number, kind = "report", tools = ["browser"]) => {
  for (let i = 0; i < count; i += 1) {
    experiences.record({
      taskId: `task-${kind}-${i}`,
      kind,
      title: `Weekly ${kind}`,
      attempted: `Produce the weekly ${kind} number ${i}`,
      detail: `Collected the numbers and wrote the ${kind}.`,
      success: true,
      verified: true,
      tools,
      models: [{ id: "llama3.1:8b", kind: "local" }],
    });
  }
};

describe("experience store", () => {
  beforeEach(() => experiences.clear());

  it("records real outcomes and counts the local-vs-cloud mix from actual calls", () => {
    seed(3);
    experiences.record({
      taskId: "task-cloud",
      kind: "research",
      title: "Deep research",
      success: true,
      verified: true,
      models: [{ id: "gpt-4o", kind: "cloud" }],
    });
    const stats = experiences.routingStats(7);
    expect(stats.local).toBe(3);
    expect(stats.cloud).toBe(1);
    expect(stats.localShare).toBeCloseTo(0.75, 5);
  });

  it("treats an owner correction as a failure, not a success", () => {
    seed(1);
    experiences.feedback("task-report-0", "no, that is wrong — redo it");
    expect(experiences.list()[0]!.success).toBe(false);
  });

  it("notices an approach that keeps working", () => {
    seed(3);
    const habits = experiences.repeatedApproaches(3);
    expect(habits[0]!.count).toBe(3);
    expect(habits[0]!.approach).toBe(
      approachSignature({
        kind: "report",
        tools: ["browser"],
        models: [{ id: "llama3.1:8b", kind: "local" }],
      }),
    );
  });

  it("only verified successes move the preferred model for a kind", () => {
    for (let i = 0; i < 3; i += 1) {
      experiences.record({
        taskId: `guess-${i}`,
        kind: "coding",
        title: "guess",
        success: true,
        verified: false,
        models: [{ id: "guess-model", kind: "cloud" }],
      });
    }
    expect(experiences.preferredModelFor("coding")).toBeNull();
    for (let i = 0; i < 2; i += 1) {
      experiences.record({
        taskId: `ok-${i}`,
        kind: "coding",
        title: "ok",
        success: true,
        verified: true,
        models: [{ id: "proven-local", kind: "local" }],
      });
    }
    expect(experiences.preferredModelFor("coding")).toBeNull();
    for (let i = 2; i < 5; i += 1) {
      experiences.record({
        taskId: `ok-${i}`,
        kind: "coding",
        title: "ok",
        success: true,
        verified: true,
        models: [{ id: "proven-local", kind: "local" }],
      });
    }
    expect(experiences.preferredModelFor("coding")).toBe("proven-local");
  });
});

describe("skill learning loop", () => {
  beforeEach(() => experiences.clear());

  it("proposes a reusable skill only for repeated verified approaches", () => {
    seed(2);
    expect(learnedSkillCandidates([])).toHaveLength(0);
    seed(1, "report");
    const candidates = learnedSkillCandidates([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.goal).toContain("Reusable skill");
  });
});

describe("versioned self-improvement candidates", () => {
  it("blocks a candidate that regresses a check the baseline passed", () => {
    const baseline = {
      at: Date.now() - 1000,
      version: "1.5.0+dev.1",
      checks: { typecheck: true, lint: true },
    };
    const candidate = compareToBaseline(
      [
        { id: "typecheck", label: "Typecheck", ok: true, detail: "" },
        { id: "lint", label: "Lint", ok: false, detail: "2 errors" },
      ],
      baseline,
    );
    expect(candidate.ok).toBe(false);
    expect(candidate.regressions).toEqual(["Lint"]);
    expect(candidate.baselineVersion).toBe("1.5.0+dev.1");
  });

  it("accepts a clean candidate and versions it", () => {
    const candidate = compareToBaseline(
      [{ id: "typecheck", label: "Typecheck", ok: true, detail: "" }],
      { at: 1, version: "1.5.0+dev.1", checks: { typecheck: true } },
    );
    expect(candidate.ok).toBe(true);
    expect(candidate.version).not.toBe("1.5.0+dev.1");
  });
});

describe("local fine-tuning data", () => {
  beforeEach(() => experiences.clear());

  it("trains only on verified successes and needs a real amount of them", () => {
    seed(MIN_EXAMPLES + 2);
    experiences.record({
      taskId: "task-bad",
      kind: "report",
      title: "Broken attempt",
      attempted: "Produce a broken report",
      detail: "It failed.",
      success: false,
      verified: true,
      tools: ["browser"],
    });
    const rows = buildTrainingSet();
    expect(rows.length).toBeGreaterThanOrEqual(MIN_EXAMPLES);
    expect(rows.some((r) => r.prompt.includes("broken"))).toBe(false);
  });
});

describe("hard safety rule — cloud is manual only", () => {
  it("drops cloud models nobody picked, and keeps local ones", () => {
    const allowed = allowedByPolicy([record("llama3.1:8b", "local"), record("gpt-4o", "cloud")]);
    expect(allowed.map((m) => m.id)).toEqual(["llama3.1:8b"]);
  });
});

describe("personal context", () => {
  it("states that owner instructions outrank learned preferences", async () => {
    const { userProfile } = await import("../../src/lib/friday/brain/user-profile");
    userProfile.resetForTests();
    userProfile.update({ occupation: "civil engineer", location: "Jaipur" });
    const { learning } = await import("../../src/lib/friday/self/learning-engine");
    const ctx = learning.personalContext();
    expect(ctx.authority).toMatch(/highest authority/i);
    expect(ctx.owner).toMatch(/Devendra/i);
    expect(ctx.occupation).toMatch(/civil engineer/i);
    expect(ctx.location).toMatch(/Jaipur/i);
  });

  it("promotes a verified name correction onto the user profile", async () => {
    const { userProfile } = await import("../../src/lib/friday/brain/user-profile");
    const { learning } = await import("../../src/lib/friday/self/learning-engine");
    userProfile.resetForTests();
    const result = learning.evaluate({
      taskId: "corr-1",
      kind: "manual-turn",
      title: "name",
      success: true,
      verified: true,
      ms: 10,
      correction: "No, I meant my name is Amit",
    });
    expect(result.learned).toBe(true);
    expect(result.note).toMatch(/applied to your name/i);
    await new Promise((r) => setTimeout(r, 0));
    expect(userProfile.getSnapshot().preferredName).toBe("Amit");
  });
});
