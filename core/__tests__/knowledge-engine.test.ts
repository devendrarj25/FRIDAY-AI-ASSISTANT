/**
 * Knowledge engine: facts/entities/relations on the existing brain store.
 * Distinct from Memory — derived beliefs are different records.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  brainKnowledge,
  deriveKnowledgeFromMemory,
} from "../../src/lib/friday/brain/knowledge-base";
import {
  dependentsOf,
  GRAPH_CHAIN,
  walkOpsChain,
} from "../../src/lib/friday/brain/knowledge-graph";
import { memory } from "../../src/lib/friday/self/memory-engine";
import { consolidateEvent } from "../../src/lib/friday/self/memory-consolidate";

describe("knowledge engine", () => {
  beforeEach(() => {
    brainKnowledge.resetForTests();
    memory.resetForTests();
  });

  it("stores a FRIDAY-owned-by-Dev fact with source, confidence, freshness", () => {
    const fact = brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "Devendra Singh Meena",
      source: "identity",
      provenance: "user",
      confidence: 1,
      shape: "fact",
    });
    expect(fact.subject).toBe("FRIDAY");
    expect(fact.predicate).toBe("owned-by");
    expect(fact.object).toBe("Devendra Singh Meena");
    expect(fact.source).toBe("identity");
    expect(fact.confidence).toBe(1);
    expect(fact.freshnessAt).toBeTruthy();
    expect(fact.contradiction).toBe(false);
    expect(fact.id).not.toMatch(/^mem-/);
  });

  it("keeps entity and relation shapes on the same store", () => {
    const entity = brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "is",
      object: "personal-assistant",
      source: "identity",
      shape: "entity",
    });
    const relation = brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "serves",
      object: "Devendra Singh Meena",
      source: "identity",
      shape: "relation",
    });
    expect(entity.shape).toBe("entity");
    expect(relation.shape).toBe("relation");
    expect(brainKnowledge.entries("knowledge").length).toBeGreaterThanOrEqual(2);
  });

  it("reinforces the same fact instead of duplicating it", () => {
    brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "Devendra Singh Meena",
      source: "identity",
    });
    brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "Devendra Singh Meena",
      source: "identity",
    });
    const owned = brainKnowledge
      .entries()
      .filter((entry) => entry.predicate === "owned-by" && entry.object === "Devendra Singh Meena");
    expect(owned).toHaveLength(1);
    expect(owned[0]?.uses).toBeGreaterThanOrEqual(1);
  });

  it("flags a contradiction and preserves both beliefs", () => {
    const first = brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "Devendra Singh Meena",
      source: "identity",
      provenance: "user",
      confidence: 1,
    });
    const rival = brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "someone else",
      source: "unverified-chat",
      provenance: "observed",
      confidence: 0.4,
    });
    expect(rival.id).not.toBe(first.id);
    expect(first.object).toBe("Devendra Singh Meena");
    expect(rival.object).toBe("someone else");
    expect(first.contradiction).toBe(true);
    expect(rival.contradiction).toBe(true);
    expect(first.contradictedBy).toContain(rival.id);
  });

  it("derives knowledge from consolidated memory without duplicating the memory record", () => {
    const phrases = [
      "I prefer local models whenever possible",
      "Always use local models, not cloud",
      "Please prefer local over paid cloud models",
    ];
    phrases.forEach((text, index) =>
      consolidateEvent({ text, source: `conversation-${index + 1}`, verified: true }),
    );
    const mem = memory.getSnapshot().items.filter((item) => item.kind === "preference");
    expect(mem).toHaveLength(1);
    const derived = brainKnowledge
      .entries()
      .filter((entry) => entry.derivedFromMemoryId === mem[0]?.id);
    expect(derived).toHaveLength(1);
    expect(derived[0]?.id).not.toBe(mem[0]?.id);
    expect(derived[0]?.source).toMatch(/^memory\//);
  });

  it("does not copy unverified low-confidence memory into knowledge", () => {
    const skipped = deriveKnowledgeFromMemory({
      id: "mem-test",
      title: "guess",
      text: "maybe the teapot is in space",
      confidence: 0.3,
      verified: false,
      updatedAt: Date.now(),
      tier: "working",
    });
    expect(skipped).toBeNull();
  });

  it("walks FRIDAY → owner → project → component → dependency → commit as queryable edges", () => {
    brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned_by",
      object: "Owner",
      source: "identity",
      provenance: "user",
      confidence: 1,
      shape: "relation",
    });
    brainKnowledge.assertBelief({
      subject: "Owner",
      predicate: "works-on",
      object: "Project",
      source: "identity",
      shape: "relation",
    });
    brainKnowledge.assertBelief({
      subject: "Project",
      predicate: "contains",
      object: "Component",
      source: "codebase",
      shape: "relation",
    });
    brainKnowledge.assertBelief({
      subject: "Component",
      predicate: "depends-on",
      object: "Dependency",
      source: "codebase",
      shape: "relation",
    });
    brainKnowledge.assertBelief({
      subject: "Dependency",
      predicate: "changed-by",
      object: "Commit",
      source: "codebase",
      shape: "relation",
    });
    const hops = walkOpsChain("FRIDAY");
    expect(hops.map((hop) => hop.to)).toEqual([
      "Owner",
      "Project",
      "Component",
      "Dependency",
      "Commit",
    ]);
    expect(hops).toHaveLength(GRAPH_CHAIN.length);
    expect(dependentsOf("Dependency").some((hop) => hop.from === "Component")).toBe(true);
    const incomplete = brainKnowledge.walk("FRIDAY", ["owned-by", "missing-edge"]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.object).toBe("Owner");
  });
});
