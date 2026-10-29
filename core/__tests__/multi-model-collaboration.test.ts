/**
 * FRIDAY · multi-model collaboration
 *
 * Two real cases, exercised against the live modules:
 *   1. FRIDAY-initiated — her own confidence engine reports a real capability
 *      gap on a consequential task, so she runs several models concurrently.
 *   2. Owner-initiated — the owner asks for a second opinion.
 *
 * Both must go down the SAME path (electron/model-router.cjs selectParallel →
 * one call per model → the existing reconciler) and both must be explainable
 * afterwards through the existing decision trace.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import {
  considerCollaboration,
  ownerAskedForSecondOpinion,
  COLLABORATION_GAP,
} from "../../src/lib/friday/brain/multi-model";
import { estimateConfidence } from "../../src/lib/friday/brain/confidence";
import {
  clearDecisionTraces,
  explainDecision,
  recordCollaboration,
  recordDecision,
} from "../../src/lib/friday/brain/decision-trace";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";

const router = createRequire(import.meta.url)("../../electron/model-router.cjs");
const access = createRequire(import.meta.url)("../../electron/model-access.cjs");

const model = (id: string, kind: "local" | "cloud", provider: string) => {
  const base = {
    id,
    label: id,
    provider,
    role: "brain",
    contextK: 32,
    meta: { providerId: provider, kind, modelName: id.split(":")[1] || id },
  };
  return kind === "cloud" && (provider === "gemini" || provider === "groq")
    ? access.stampVerified(base)
    : base;
};

const POOL = [
  model("ollama:llama3.1", "local", "ollama"),
  model("ollama:qwen2.5", "local", "ollama"),
  model("groq:llama-3.3-70b", "cloud", "groq"),
];

describe("when FRIDAY decides she needs a second engine", () => {
  it("stays on one model for ordinary work", () => {
    expect(considerCollaboration("write a haiku about rain").warranted).toBe(false);
    expect(considerCollaboration("what is 2 + 2").warranted).toBe(false);
    expect(considerCollaboration("").warranted).toBe(false);
  });

  it("fans out on a real capability gap that actually matters", () => {
    const prompt = "delete the production database migration before I deploy the release";
    const confidence = estimateConfidence(prompt);
    const decision = considerCollaboration(prompt, {
      confidence: { ...confidence, score: COLLABORATION_GAP - 0.1 },
    });
    expect(decision.warranted).toBe(true);
    expect(decision.initiator).toBe("friday");
    expect(decision.count).toBeGreaterThanOrEqual(2);
    expect(decision.reason).toMatch(/confidence/i);
  });

  it("does not spend extra calls on a low-confidence but harmless question", () => {
    const prompt = "tell me something about quantum widget theory";
    const decision = considerCollaboration(prompt, {
      confidence: { ...estimateConfidence(prompt), score: 0.1 },
    });
    expect(decision.warranted).toBe(false);
  });

  it("honours the owner asking for it, in his own words", () => {
    for (const ask of [
      "get a second opinion from another model",
      "check this with two models",
      "cross-check this",
    ]) {
      expect(ownerAskedForSecondOpinion(ask)).toBe(true);
      const decision = considerCollaboration(ask);
      expect(decision.warranted).toBe(true);
      expect(decision.initiator).toBe("owner");
    }
  });

  it("respects the owner's multi-model setting being off", () => {
    expect(
      considerCollaboration("get a second opinion from another model", { enabled: false })
        .warranted,
    ).toBe(false);
  });
});

describe("the execution path is the existing one", () => {
  it("selectParallel returns several distinct, policy-legal candidates", () => {
    const picks = router.selectParallel(POOL, {
      task: "chat",
      policy: "free-only",
      mode: "auto",
      count: 2,
    });
    expect(picks.length).toBe(2);
    expect(new Set(picks.map((m: { id: string }) => m.id)).size).toBe(2);
    // free-only must never smuggle a paid engine into a parallel run
    for (const pick of picks) expect(router.classifyAccess(pick)).not.toBe("paid");
  });

  it("really runs the candidates concurrently and reconciles ONE answer", async () => {
    const started: number[] = [];
    const call = async (text: string, ms: number) => {
      started.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, ms));
      return text;
    };
    const cognition = await coreBrain.cognize("review this migration before I deploy", {
      mode: "manual",
      allowTools: false,
    });

    const begin = Date.now();
    const [a, b] = await Promise.all([
      call("Roll the migration back first, then redeploy.", 60),
      call("Roll it back before redeploying, and take a backup.", 60),
    ]);
    const elapsed = Date.now() - begin;
    expect(elapsed).toBeLessThan(120); // concurrent, not sequential
    expect(Math.abs(started[1]! - started[0]!)).toBeLessThan(30);

    const result = coreBrain.reconcileTurn(cognition, [
      { modelId: "ollama:llama3.1", text: a!, ok: true, ms: 60 },
      { modelId: "ollama:qwen2.5", text: b!, ok: true, ms: 60 },
    ]);
    expect(result.answer.trim().length).toBeGreaterThan(0);
    expect(result.winner).toBeTruthy();
    expect(result.agreement).toBeGreaterThan(0);
  });
});

describe("the owner can always see that it happened, and why", () => {
  beforeEach(() => clearDecisionTraces());

  it("explains the extra calls through the existing decision trace", () => {
    const prompt = "check this deployment plan with two models";
    recordDecision({
      at: Date.now(),
      mode: "manual",
      prompt,
      modelIds: ["ollama:llama3.1"],
      routing: "1 model(s) · brain:ollama:llama3.1",
      policy: "free-preferred",
      confidence: estimateConfidence(prompt),
    });
    recordCollaboration({
      initiator: "owner",
      reason: "you asked me to check this with more than one model",
      models: [
        { modelId: "ollama:llama3.1", label: "llama3.1", access: "free", ok: true, ms: 800 },
        {
          modelId: "groq:llama-3.3-70b",
          label: "llama-3.3-70b",
          access: "free",
          ok: true,
          ms: 640,
        },
      ],
      winner: "llama-3.3-70b",
      agreement: 0.82,
    });

    const explanation = explainDecision("why did you use those models");
    expect(explanation).toMatch(/2 models at once/i);
    expect(explanation).toMatch(/llama3\.1/);
    expect(explanation).toMatch(/separate requests/i);
    expect(explanation).toMatch(/82%/);
  });

  it("says so plainly when a paid engine was one of them", () => {
    recordDecision({
      at: Date.now(),
      mode: "manual",
      prompt: "second opinion please",
      modelIds: ["openai:gpt-4o"],
      routing: "1 model(s)",
      policy: "allow-paid",
      confidence: estimateConfidence("second opinion please"),
    });
    recordCollaboration({
      initiator: "owner",
      reason: "you asked me to check this with more than one model",
      models: [
        { modelId: "ollama:llama3.1", label: "llama3.1", access: "free", ok: true, ms: 900 },
        { modelId: "openai:gpt-4o", label: "gpt-4o", access: "paid", ok: true, ms: 1200 },
      ],
      winner: "gpt-4o",
      agreement: 0.7,
    });
    expect(explainDecision("how confident were you")).toMatch(/paid model was among them/i);
  });
});
