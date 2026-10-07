/**
 * Freshness, contradiction handling, and retrieval ranking on the existing
 * Memory + Knowledge stores — not a second retriever.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { brainKnowledge, currentBeliefAmong } from "../../src/lib/friday/brain/knowledge-base";
import {
  compareBeliefs,
  describeEvidence,
  formatEvidenceLine,
  rankByRetrieval,
  sourceReliability,
} from "../../src/lib/friday/brain/retrieval";
import { consolidateEvent } from "../../src/lib/friday/self/memory-consolidate";
import { meaningsDisagree, memory } from "../../src/lib/friday/self/memory-engine";
import { notifications } from "../../src/lib/friday/notifications";

describe("freshness, contradiction, retrieval", () => {
  beforeEach(() => {
    memory.resetForTests();
    brainKnowledge.resetForTests();
    notifications.setEnabled(true);
    notifications.clear();
  });

  it("answers where a knowledge fact came from, when, and whether newer evidence exists", () => {
    const first = brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "Devendra Singh Meena",
      source: "identity",
      provenance: "user",
      confidence: 1,
    });
    const card = describeEvidence(
      {
        title: first.title,
        text: first.body,
        source: first.source,
        provenance: first.provenance,
        confidence: first.confidence,
        updatedAt: first.updatedAt,
        verified: true,
        ...(first.freshnessAt !== undefined ? { freshnessAt: first.freshnessAt } : {}),
      },
      [],
    );
    expect(card.source).toBe("identity");
    expect(card.when).toBe(first.freshnessAt);
    expect(card.reliability).toBeGreaterThan(0.9);
    expect(card.verified).toBe(true);
    expect(card.newerEvidence).toBe(false);
    expect(formatEvidenceLine(card)).toMatch(/source: identity/);
    expect(brainKnowledge.evidenceLine(first)).toMatch(/source: identity/);
  });

  it("keeps both memory records on a real contradiction and notifies the owner", () => {
    const first = consolidateEvent({
      text: "Always use local models, not cloud",
      source: "unverified-chat",
      confidence: 0.5,
    });
    const second = consolidateEvent({
      text: "Always use cloud models, not local",
      source: "unverified-chat",
      confidence: 0.5,
    });
    expect(first.kept).toBe(true);
    expect(second.stage).toBe("conflict");
    expect(second.kept).toBe(true);
    const prefs = memory.getSnapshot().items.filter((item) => item.kind === "preference");
    expect(prefs.length).toBeGreaterThanOrEqual(2);
    expect(prefs.every((item) => item.contradiction)).toBe(true);
    expect(first.item?.text).toMatch(/local/);
    expect(
      memory.getSnapshot().items.some((item) => /cloud models, not local/.test(item.text)),
    ).toBe(true);
    expect(
      notifications.getSnapshot().items.some((item) => /Conflicting memory/.test(item.title)),
    ).toBe(true);
  });

  it("does not auto-resolve two observed knowledge facts; both stay and the owner is asked", () => {
    const first = brainKnowledge.assertBelief({
      subject: "office",
      predicate: "timezone",
      object: "IST",
      source: "unverified-chat",
      provenance: "observed",
      confidence: 0.5,
    });
    const rival = brainKnowledge.assertBelief({
      subject: "office",
      predicate: "timezone",
      object: "UTC",
      source: "unverified-chat",
      provenance: "observed",
      confidence: 0.5,
    });
    expect(first.object).toBe("IST");
    expect(rival.object).toBe("UTC");
    expect(first.contradiction).toBe(true);
    expect(rival.contradiction).toBe(true);
    expect(currentBeliefAmong([first, rival])).toBeNull();
    expect(brainKnowledge.pendingConsent().length).toBeGreaterThan(0);
    expect(
      notifications.getSnapshot().items.some((item) => /Conflicting knowledge/.test(item.title)),
    ).toBe(true);
  });

  it("treats owner/user evidence as sufficient current belief without deleting the rival", () => {
    const owner = brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "Devendra Singh Meena",
      source: "identity",
      provenance: "user",
      confidence: 1,
    });
    const guess = brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "someone else",
      source: "unverified-chat",
      provenance: "observed",
      confidence: 0.4,
    });
    const current = currentBeliefAmong([owner, guess]);
    expect(current?.id).toBe(owner.id);
    expect(guess.contradiction).toBe(true);
    expect(brainKnowledge.entries().some((entry) => entry.id === guess.id)).toBe(true);
  });

  it("ranks verified recent knowledge above stale low-confidence noise and caps the set", () => {
    const now = Date.now();
    brainKnowledge.remember({
      kind: "knowledge",
      title: "alpha project deadline",
      body: "alpha project deadline is Friday — verified by the owner",
      source: "identity",
      provenance: "user",
      confidence: 0.95,
    });
    brainKnowledge.remember({
      kind: "knowledge",
      title: "alpha project rumour",
      body: "alpha project maybe slips to next month according to a guess",
      source: "unverified-chat",
      provenance: "observed",
      confidence: 0.3,
    });
    const stale = brainKnowledge.entries().find((entry) => entry.title.includes("rumour"));
    expect(stale).toBeTruthy();
    brainKnowledge.reinforce(stale!.id, false);
    memory.remember({
      tier: "temporary",
      title: "alpha project deadline",
      text: "alpha project deadline is Friday — verified by the owner",
      source: "identity",
      confidence: 0.95,
      verified: true,
      kind: "project",
    });
    memory.remember({
      tier: "working",
      title: "alpha project rumour",
      text: "alpha project maybe slips according to a guess",
      source: "unverified-chat",
      confidence: 0.25,
      kind: "working",
    });
    const rumoured = memory.getSnapshot().items.find((item) => item.title.includes("rumour"));
    memory.update(rumoured!.id, { freshnessAt: now - 40 * 86_400_000, confidence: 0.25 });

    const knowledgeHits = brainKnowledge.recall("alpha project deadline", { k: 2 });
    expect(knowledgeHits[0]?.title).toMatch(/deadline/);
    expect(knowledgeHits.length).toBeLessThanOrEqual(2);

    const memoryHits = memory.retrieve("alpha project deadline", 2);
    expect(memoryHits.length).toBeLessThanOrEqual(2);
    expect(memoryHits[0]?.item.title).toMatch(/deadline/);
  });

  it("meaningsDisagree catches local vs cloud polarity that token Jaccard would merge", () => {
    expect(
      meaningsDisagree("Always use local models, not cloud", "Always use cloud models, not local"),
    ).toBe(true);
    expect(
      meaningsDisagree(
        "I prefer local models whenever possible",
        "Always use local models, not cloud",
      ),
    ).toBe(false);
    expect(sourceReliability("identity", "user")).toBeGreaterThan(
      sourceReliability("unverified-chat", "observed"),
    );
    const judgment = compareBeliefs(
      {
        source: "identity",
        provenance: "user",
        confidence: 1,
        updatedAt: 1,
        verified: true,
      },
      {
        source: "unverified-chat",
        provenance: "observed",
        confidence: 0.4,
        updatedAt: 2,
      },
    );
    expect(judgment.sufficient).toBe(true);
    expect(judgment.winner).toBe("existing");
  });

  it("rankByRetrieval drops scores below the usefulness floor", () => {
    const ranked = rankByRetrieval(
      [
        {
          title: "unrelated teapot",
          text: "the teapot is in space",
          source: "chat",
          confidence: 0.2,
          updatedAt: 1,
        },
        {
          title: "deadline",
          text: "ship the alpha project on Friday",
          source: "identity",
          confidence: 0.9,
          updatedAt: Date.now(),
        },
      ],
      "alpha project Friday",
      (row) => row,
      { k: 6, minScore: 0.22 },
    );
    expect(ranked.every((row) => row.score >= 0.22)).toBe(true);
    expect(ranked.some((row) => row.item.title === "deadline")).toBe(true);
    expect(ranked.some((row) => row.item.title === "unrelated teapot")).toBe(false);
  });
});
