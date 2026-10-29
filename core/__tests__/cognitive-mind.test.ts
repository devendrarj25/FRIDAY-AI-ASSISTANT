import { describe, expect, it } from "vitest";

import { finishCognitiveCycle } from "../../src/lib/friday/brain/cognitive-control";
import type { CognitiveRoute } from "../../src/lib/friday/brain/cognitive-route";
import {
  assembleCognitiveMind,
  attentionScore,
  competeForAttention,
  compileExperience,
  decayAttention,
  judgeSilence,
  judgeUncertainty,
  normalizeObservation,
  proposeCommitment,
  readSocialStance,
  regulateAffect,
  resetCognitiveMind,
  revisePlan,
  writeDecisionRecord,
  type AttentionCandidate,
} from "../../src/lib/friday/brain/cognitive-mind";

const stakes: CognitiveRoute = {
  klass: "high-stakes",
  action: "multi-verify",
  reason: "test",
};

function item(
  partial: Partial<AttentionCandidate> & Pick<AttentionCandidate, "id" | "label">,
): AttentionCandidate {
  return {
    goalRelevance: 0,
    urgency: 0,
    novelty: 0,
    risk: 0,
    dependency: 0,
    userSalience: 0,
    freshness: 0,
    uncertainty: 0,
    infoValue: 0,
    noise: 0,
    cost: 0,
    ...partial,
  };
}

describe("cognitive mind", () => {
  it("gives the foreground to the ask and suppresses chatter", () => {
    resetCognitiveMind();
    const board = competeForAttention([
      item({
        id: "ask",
        label: "restore the kernel",
        goalRelevance: 0.9,
        userSalience: 0.9,
        freshness: 1,
      }),
      item({ id: "status-chatter", label: "unsolicited status", noise: 0.95, cost: 0.8 }),
    ]);
    expect(board.foreground?.id).toBe("ask");
    expect(board.suppressed.map((row) => row.id)).toContain("status-chatter");
    expect(attentionScore(item({ id: "x", label: "x", noise: 1, cost: 1 }))).toBe(0);

    const faded = decayAttention(0.8, 4);
    expect(faded.score).toBeLessThan(0.8);
    expect(faded.retained).toBe(true);
  });

  it("stores a notice and never delivers an interruption", () => {
    const quiet = judgeSilence({
      importance: 0.2,
      urgency: 0.2,
      actionability: 0.2,
      relevance: 0.2,
      deadlinePressure: 0.2,
      interruptionCost: 0.5,
      ownerWaiting: false,
    });
    expect(quiet.deservesNotice).toBe(false);
    expect(quiet.delivered).toBe(false);
    expect(quiet.stored).toBe(false);

    const loud = judgeSilence({
      importance: 1,
      urgency: 1,
      actionability: 1,
      relevance: 1,
      deadlinePressure: 1,
      interruptionCost: 0,
      ownerWaiting: false,
    });
    expect(loud.deservesNotice).toBe(true);
    expect(loud.delivered).toBe(false);
    expect(loud.stored).toBe(true);

    const waiting = judgeSilence({
      importance: 1,
      urgency: 1,
      actionability: 1,
      relevance: 1,
      deadlinePressure: 1,
      interruptionCost: 0,
      ownerWaiting: true,
    });
    expect(waiting.delivered).toBe(false);
    expect(waiting.stored).toBe(false);
    expect(waiting.reason).toMatch(/owner is waiting/);
  });

  it("refuses to assert when evidence is missing, stale, or contradicted", () => {
    expect(
      judgeUncertainty({
        confidence: 0.9,
        evidenceCount: 2,
        evidenceQuality: 0.8,
        freshness: 1,
        contradictionCount: 1,
        modelAgreement: 1,
        ambiguous: false,
        liveFact: false,
        hasEvidence: true,
      }).behavior,
    ).toBe("withhold");

    const live = judgeUncertainty({
      confidence: 0.8,
      evidenceCount: 0,
      evidenceQuality: 0.2,
      freshness: 1,
      contradictionCount: 0,
      modelAgreement: null,
      ambiguous: false,
      liveFact: true,
      hasEvidence: false,
    });
    expect(live.kind).toBe("unavailable");
    expect(live.assertFact).toBe(false);

    expect(
      judgeUncertainty({
        confidence: 0.4,
        evidenceCount: 0,
        evidenceQuality: 0.2,
        freshness: 1,
        contradictionCount: 0,
        modelAgreement: null,
        ambiguous: true,
        liveFact: false,
        hasEvidence: false,
      }).behavior,
    ).toBe("clarify");

    expect(
      judgeUncertainty({
        confidence: 0.8,
        evidenceCount: 1,
        evidenceQuality: 0.8,
        freshness: 0.1,
        contradictionCount: 0,
        modelAgreement: 0.9,
        ambiguous: false,
        liveFact: false,
        hasEvidence: true,
      }).kind,
    ).toBe("stale");

    const ready = judgeUncertainty({
      confidence: 0.8,
      evidenceCount: 2,
      evidenceQuality: 0.8,
      freshness: 1,
      contradictionCount: 0,
      modelAgreement: 0.9,
      ambiguous: false,
      liveFact: false,
      hasEvidence: true,
    });
    expect(ready.behavior).toBe("proceed");
    expect(ready.assertFact).toBe(true);
  });

  it("keeps an irreversible option out of the chosen decision", () => {
    const record = writeDecisionRecord({
      objective: "delete the project files",
      constraints: ["cognition does not execute"],
      options: [
        {
          id: "execute",
          summary: "run the side effect from cognition",
          expected: "a machine change",
          risk: "high",
          reversible: false,
          score: 0.99,
        },
        {
          id: "handoff",
          summary: "hand the side effect to authority",
          expected: "the desktop decides",
          risk: "high",
          reversible: true,
          score: 0.4,
        },
      ],
      confidence: 0.8,
      authority: "handoff",
      verificationRequired: true,
      invalidatesWhen: "the owner cancels",
    });
    expect(record.chosen.id).toBe("handoff");
    expect(record.rejected.find((row) => row.id === "execute")?.rationale).toMatch(/does not run/);
    expect(record.exposesChainOfThought).toBe(false);
    expect(record.publicSummary.length).toBeLessThanOrEqual(180);
    expect(record.publicSummary).not.toMatch(/chain of thought/i);
  });

  it("uses affect for tone only and does not infer a private trait", () => {
    const rushed = regulateAffect({
      urgency: 0.9,
      frustration: 0.8,
      confusion: 0.2,
      excitement: 0,
      consequential: true,
      ambiguous: false,
    });
    expect(rushed.reassurance).toBe(true);
    expect(rushed.pacing).toBe("careful");
    expect(rushed.changesPermissions).toBe(false);
    expect(rushed.changesTruth).toBe(false);
    expect(rushed.changesPolicy).toBe(false);

    const stance = readSocialStance({
      prompt: "I am anxious about the deadline, keep it brief",
      verifiedSuccesses: 2,
      corrections: 2,
    });
    expect(stance.preferredStyle).toBe("concise");
    expect(stance.posture).toBe("repair");
    expect(stance.inferredSensitiveAttributes).toEqual([]);
    expect(stance.manipulatesDependency).toBe(false);
    expect(stance.unresolved).toEqual(["a correction is still open"]);
  });

  it("commits only on an explicit ask, replans without erasing history, and does not apply a lesson", () => {
    resetCognitiveMind();
    const hinted = proposeCommitment({
      text: "we could clean the downloads folder later",
      explicitAsk: false,
      authorizedPolicy: false,
    });
    expect(hinted.commitment).toBeNull();
    expect(hinted.reason).toMatch(/not a commitment/);

    const asked = proposeCommitment({
      text: "remind me to check the kernel",
      explicitAsk: true,
      authorizedPolicy: false,
      scope: "check the kernel",
      completion: "the owner saw the reminder",
    });
    expect(asked.commitment?.owner).toBe("owner");
    expect(asked.commitment?.createdFrom).toBe("explicit-ask");
    const again = proposeCommitment({
      text: "remind me to check the kernel",
      explicitAsk: true,
      authorizedPolicy: false,
      scope: "check the kernel",
    });
    expect(again.commitment?.commitment_id).toBe(asked.commitment?.commitment_id);

    const revision = revisePlan({
      triggers: { "tool-failure": true },
      completedEffects: ["the file was already copied"],
      nextStep: "try a different tool",
    });
    expect(revision.needsReplan).toBe(true);
    expect(revision.historyKept).toBe(true);
    expect(revision.completedEffects).toEqual(["the file was already copied"]);
    expect(revision.nextStep.startsWith("replan:")).toBe(true);

    const first = compileExperience({
      situation: "a tool failed",
      outcome: "failure",
      hypothesis: "the same call will fail again",
      lesson: "name the failure",
      boundary: "this task only",
      confidence: 0.6,
    });
    expect(first.applied).toBe(false);
    expect(first.evaluationGated).toBe(true);
    expect(first.stored).toBe(true);
    const second = compileExperience({
      situation: "a tool failed",
      outcome: "failure",
      hypothesis: "the same call will fail again",
      lesson: "name the failure",
      boundary: "this task only",
      confidence: 0.9,
    });
    expect(second.stored).toBe(false);
    expect(second.applied).toBe(false);
    expect(second.experience_id).toBe(first.experience_id);
  });

  it("normalizes an observation and keeps provider state out of identity", () => {
    const observation = normalizeObservation({
      source: "  ",
      confidence: 4,
      payload: "kernel health",
      now: 1_700_000_000_000,
    });
    expect(observation.source).toBe("unspecified");
    expect(observation.confidence).toBe(1);
    expect(observation.normalized).toBe(true);
    expect(observation.observed_at).toMatch(/T.*Z$/);

    resetCognitiveMind();
    const mind = assembleCognitiveMind({
      prompt: "write a haiku about rain",
      depth: "fast",
      mode: "direct",
      confidence: 0.9,
      verification: "none",
      ownerWaiting: true,
      now: 1_700_000_000_000,
    });
    expect(mind.line).toBe("");
    expect(mind.working.identity).toBe("FRIDAY");
    expect(mind.working.consciousnessClaim).toBe(false);
    expect(mind.decision.chosen.id).not.toBe("execute");
    expect(mind.silence.delivered).toBe(false);
    expect(mind.commitment.commitment).toBeNull();
    expect(mind.modelRequest.identity).toBe("FRIDAY");
    expect(mind.modelRequest.providerStateDurable).toBe(false);
    expect(mind.modelRequest.consciousnessClaim).toBe(false);
    expect(mind.attention.foreground?.id).toBe("ask");
    expect(mind.attention.suppressed.map((row) => row.id)).toContain("status-chatter");

    const risky = assembleCognitiveMind({
      prompt: "delete the project files",
      goal: "delete the project files safely",
      depth: "metacognitive",
      mode: "verification-first",
      confidence: 0.8,
      consequential: true,
      verification: "strict",
      explicitCommitment: false,
      now: 1_700_000_000_000,
    });
    expect(risky.decision.chosen.id).toBe("handoff");
    expect(risky.decision.authority).toBe("handoff");
    expect(risky.affect.changesPermissions).toBe(false);
    expect(risky.commitment.commitment).toBeNull();
    expect(risky.modelRequest.capabilities).toContain("handoff");
    expect(risky.line).toMatch(/model identity FRIDAY/);
    expect(risky.line).not.toMatch(/world state:|meta:|reasoning:/);
  });

  it("attaches the mind to a cognitive cycle", () => {
    resetCognitiveMind();
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
    expect(cycle.mind.working.identity).toBe("FRIDAY");
    expect(cycle.mind.decision.chosen.id).not.toBe("execute");
    expect(cycle.mind.silence.delivered).toBe(false);
    expect(cycle.mind.modelRequest.providerStateDurable).toBe(false);
    expect(cycle.intent.executes).toBe(false);
    expect(cycle.runtime.mayExecute).toBe(false);
  });
});
