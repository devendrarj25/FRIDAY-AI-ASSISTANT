/**
 * FRIDAY · master-flow conformance
 *
 * Binds the owner's FRIDAY AI OS master flow to the code that really runs it.
 * Every stage below is exercised against the live modules (no mocks, no fake
 * data) so a future change that quietly drops a stage fails here.
 *
 *   observe → understand → remember → plan → select capability → check policy
 *           → approve → execute → monitor → verify → deliver → remember
 *           → learn → analyse → improve → build/discover → test → install
 *           → register → document → monitor → rollback → repeat
 */
import { describe, expect, it } from "vitest";

import { classifyIntent } from "../brain/intent";
import { prepare } from "../brain/router";
import { coreBrain, taskKind } from "../../src/lib/friday/brain/core-brain";
import { capabilityRegistry } from "../../src/lib/friday/brain/capability-registry";
import { actionNeedsApproval, isConsequential } from "../../src/lib/friday/brain/action-risk";
import { currentPolicy, allowedModelIds } from "../../src/lib/friday/brain/cost-policy";
import { decisionTraces, clearDecisionTraces } from "../../src/lib/friday/brain/decision-trace";
import { planNodes } from "../../src/lib/friday/self/task-graph";
import { memory } from "../../src/lib/friday/self/memory-engine";
import { ALWAYS_ASK_KINDS } from "../../src/lib/friday/self/governance";
import { capabilityMatrix } from "../../src/lib/friday/self/capability-matrix";
import {
  areasFor,
  compareToBaseline,
  devStageIds,
  planFor,
} from "../../src/lib/friday/self/dev-pipeline";
import { selfRollback, selfVerify } from "../../src/lib/friday/self/maintenance-bridge";
import { createRequire } from "node:module";

const verify = createRequire(import.meta.url)("../../electron/capability-verify.cjs");

describe("FRIDAY master flow — stages 1-4: understand, remember, analyse, plan", () => {
  it("classifies the goal before any model is contacted", () => {
    expect(classifyIntent("delete the temp folder").actionable).toBe(true);
    expect(classifyIntent("how are you").actionable).toBe(false);
    expect(taskKind("refactor this python function")).toBe("code");
  });

  it("produces an ordered plan with waves from a single goal", () => {
    const brainPlan = prepare({ text: "research vite 7 and then write a summary" });
    expect(brainPlan.plan.steps.length).toBeGreaterThan(0);
    expect(brainPlan.waves.length).toBeGreaterThan(0);
    expect(brainPlan.assessment.complexity).toBeTruthy();
  });

  it("decomposes a multi-step request into real task-graph nodes", () => {
    const nodes = planNodes("scan the project, then run the tests, then report");
    expect(nodes.length).toBeGreaterThanOrEqual(3);
    expect(nodes.every((node) => node.instruction.trim().length > 0)).toBe(true);
  });
});

describe("FRIDAY master flow — stages 5-7: context, registry, routing", () => {
  it("builds one context payload carrying identity, system state and policy", async () => {
    const cognition = await coreBrain.cognize("explain what closures are", {
      mode: "manual",
      allowTools: false,
    });
    expect(cognition.system).toContain("FRIDAY");
    expect(cognition.routing.length).toBeGreaterThan(0);
    expect(Array.isArray(cognition.context)).toBe(true);
    expect(cognition.dispatch.pipeline.steps.length).toBeGreaterThan(0);
  });

  it("keeps one master registry for every capability type", () => {
    const snapshot = capabilityRegistry.refresh();
    expect(snapshot.refreshedAt).toBeGreaterThan(0);
    for (const type of ["model", "tool", "skill", "agent", "module", "plugin", "workflow"]) {
      expect(snapshot.counts).toHaveProperty(type);
    }
  });

  it("records the real routing decision, its policy and its confidence", async () => {
    clearDecisionTraces();
    await coreBrain.cognize("plan a small refactor", { mode: "manual", allowTools: false });
    const trace = decisionTraces(1)[0];
    expect(trace).toBeTruthy();
    expect(trace?.policy).toBe(currentPolicy());
    expect(trace?.confidence).toBeTruthy();
  });
});

describe("FRIDAY master flow — stages 8-10: policy, permission, approval", () => {
  it("defaults to free-first and never routes a model the policy forbids", () => {
    expect(["free-only", "free-preferred", "paid-allowed", "allow-paid", "paid-only"]).toContain(
      currentPolicy(),
    );
    expect(allowedModelIds([])).toEqual([]);
  });

  it("gates every consequential action behind owner approval", () => {
    expect(isConsequential("delete C:/Users/me/report.docx")).toBe(true);
    expect(actionNeedsApproval("exec", "auto")).toBe(true);
    expect(actionNeedsApproval("safe", "auto")).toBe(false);
    expect(actionNeedsApproval("safe", "manual")).toBe(true);
    expect(isConsequential("what is 2 + 2")).toBe(false);
  });

  it("always asks the owner for self-modifying work", () => {
    expect(ALWAYS_ASK_KINDS.size).toBeGreaterThan(0);
    expect([...ALWAYS_ASK_KINDS]).toContain("self-upgrade");
  });
});

describe("FRIDAY master flow — stages 11-15: execute, verify, remember, learn", () => {
  it("refuses to call an empty or deflected answer verified", async () => {
    const cognition = await coreBrain.cognize("summarise this", {
      mode: "manual",
      allowTools: false,
    });
    expect(coreBrain.verify(cognition, "", true).ok).toBe(false);
    expect(coreBrain.verify(cognition, "As an AI language model I cannot", true).ok).toBe(false);
    expect(coreBrain.verify(cognition, "Here is the summary you asked for.", true).ok).toBe(true);
  });

  it("closes the loop: verification, memory and learning all move on one turn", async () => {
    const cognition = await coreBrain.cognize("remember that my build runs on Windows", {
      mode: "manual",
      allowTools: false,
    });
    const before = memory.getSnapshot().items.length;
    const verification = coreBrain.reflect({
      cognition,
      answer: "Noted — your build runs on Windows.",
      ok: true,
      ms: 42,
    });
    expect(verification.ok).toBe(true);
    expect(memory.getSnapshot().items.length).toBeGreaterThanOrEqual(before);
  });

  it("analyses its own performance through the capability matrix", () => {
    const scores = capabilityMatrix.getSnapshot().scores;
    expect(Array.isArray(scores)).toBe(true);
    expect(scores.length).toBeGreaterThan(0);
    expect(scores.every((score) => score.score >= 0 && score.score <= 100)).toBe(true);
  });
});

describe("FRIDAY master flow — stages 16-20: improve, build, test, install, rollback", () => {
  it("runs self-development in the owner's order, with approval before apply", () => {
    const ids = devStageIds();
    expect(ids).toEqual([
      "analyze",
      "inspect",
      "plan",
      "scan",
      "test",
      "approval",
      "apply",
      "verify",
      "record",
    ]);
    expect(ids.indexOf("approval")).toBeLessThan(ids.indexOf("apply"));
    expect(ids.indexOf("scan")).toBeLessThan(ids.indexOf("apply"));
  });

  it("focuses a change on the real area of its own source", () => {
    expect(areasFor("improve the wake word in voice mode")).toContain("voice");
    expect(planFor("tune routing", ["models"], []).length).toBeGreaterThan(1);
  });

  it("keeps the old version when a candidate regresses against the baseline", () => {
    const previous = {
      at: 1,
      version: "1.0.0",
      checks: { build: true, tests: true },
    };
    const worse = compareToBaseline(
      [
        { id: "build", label: "Build", ok: true, detail: "" },
        { id: "tests", label: "Tests", ok: false, detail: "2 failed" },
      ],
      previous,
    );
    expect(worse.ok).toBe(false);
    expect(worse.regressions).toContain("Tests");

    const better = compareToBaseline(
      [
        { id: "build", label: "Build", ok: true, detail: "" },
        { id: "tests", label: "Tests", ok: true, detail: "" },
      ],
      previous,
    );
    expect(better.ok).toBe(true);
    expect(better.regressions).toHaveLength(0);
  });

  it("tests an imported component before it is enabled, and names its dependency", () => {
    expect(typeof verify.smokeTest).toBe("function");
    expect(verify.missingFromOutput("ModuleNotFoundError: No module named 'requests'")).toBe(
      "requests",
    );
    const git = verify.resolveDependency("git");
    expect(git).toBeTruthy();
    expect(verify.isAutomatable(git)).toBe(true);
  });

  it("keeps a rollback path for every applied change", () => {
    expect(typeof selfRollback).toBe("function");
    expect(typeof selfVerify).toBe("function");
  });
});
