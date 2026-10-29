/**
 * Depth on the same memory and knowledge stores: temporal claims, text units,
 * poison resistance, graph ranking, and scope precedence.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { brainKnowledge, claimActive } from "../../src/lib/friday/brain/knowledge-base";
import {
  extractClaims,
  ingestKnowledge,
  splitTextUnits,
} from "../../src/lib/friday/brain/knowledge-ingest";
import {
  fuseChannels,
  governRecall,
  preferredByScope,
  resetMemoryFabric,
  sourceTrust,
} from "../../src/lib/friday/brain/memory-fabric";
import { prepareTurn } from "../../src/lib/friday/runtime";
import { consolidateEvent } from "../../src/lib/friday/self/memory-consolidate";
import { memory } from "../../src/lib/friday/self/memory-engine";

describe("memory knowledge depth", () => {
  beforeEach(() => {
    memory.resetForTests();
    brainKnowledge.resetForTests();
    resetMemoryFabric();
  });

  it("stores a dated claim and a text unit, then hides the claim after it ends", () => {
    const since = extractClaims("Owner has preferred local-models since January 2024.");
    expect(since[0]?.predicate).toBe("prefers");
    expect(since[0]?.validFrom).toBe(Date.UTC(2024, 0, 1));
    const span = extractClaims("Renderer used sandbox from 2020 to 2022.");
    expect(span[0]?.validFrom).toBe(Date.UTC(2020, 0, 1));
    expect(span[0]?.validUntil).toBe(Date.UTC(2022, 11, 31));
    expect(
      splitTextUnits("The kernel owns the scheduler. The kernel owns the scheduler."),
    ).toHaveLength(1);

    const current = ingestKnowledge({
      kind: "document",
      source: "docs.extract",
      text: "Owner has preferred local-models since January 2024.",
    });
    expect(current.skipped).toBeNull();
    const live = current.entries.find((entry) => entry.predicate === "prefers");
    expect(live?.validFrom).toBe(Date.UTC(2024, 0, 1));
    expect(current.entries.some((entry) => entry.tags.includes("text-unit"))).toBe(true);
    expect(claimActive(live ?? {}, Date.UTC(2024, 5, 1))).toBe(true);

    const expired = ingestKnowledge({
      kind: "document",
      source: "docs.extract",
      text: "Owner preferred cloud-models until January 2020.",
    });
    const old = expired.entries.find((entry) => entry.object === "cloud-models");
    expect(old?.validUntil).toBe(Date.UTC(2020, 0, 31));
    expect(claimActive(old ?? {}, Date.UTC(2024, 5, 1))).toBe(false);
    const turn = prepareTurn("where did cloud-models go", { depth: 6, multiModel: false });
    expect(turn.context.join(" ")).not.toMatch(/cloud-models/);
  });

  it("refuses a web rewrite of an owner preference and still merges equal-trust paraphrases", () => {
    expect(sourceTrust("user")).toBeGreaterThan(sourceTrust("web"));
    memory.remember({
      tier: "permanent",
      title: "Model policy",
      text: "I prefer local models whenever possible",
      source: "user",
      kind: "preference",
      verified: true,
      confidence: 0.95,
    });
    const attack = consolidateEvent({
      text: "I prefer paid cloud models whenever possible",
      source: "web",
    });
    expect(attack.kept).toBe(false);
    expect(attack.stage).toBe("conflict");
    expect(attack.reason).toMatch(/weaker source/);
    expect(
      memory
        .getSnapshot()
        .items.some((item) => /local models/.test(item.text) && !item.supersededAt),
    ).toBe(true);
    expect(memory.getSnapshot().items.some((item) => /paid cloud/.test(item.text))).toBe(false);

    const first = consolidateEvent({
      text: "I prefer quiet fans whenever possible",
      source: "conversation",
    });
    const second = consolidateEvent({
      text: "Always use quiet fans, not loud ones",
      source: "conversation",
    });
    expect(first.kept).toBe(true);
    expect(second.kept).toBe(true);
  });

  it("ranks a graph neighbor ahead of an equal lexical hit, and owner scope ahead of session", () => {
    const drawer = memory.remember({
      tier: "semantic",
      title: "Drawer note",
      text: "The spare cable sits in the drawer beside the desk.",
      source: "user",
      kind: "semantic",
      verified: true,
      confidence: 0.8,
    });
    const owner = memory.remember({
      tier: "semantic",
      title: "Kernel owner",
      text: "Devendra owns the kernel for this desk.",
      source: "user",
      kind: "semantic",
      verified: true,
      confidence: 0.8,
    });
    const governed = governRecall({
      prompt: "who owns the kernel",
      hits: [
        { item: drawer, score: 0.5 },
        { item: owner, score: 0.5 },
      ],
      hops: [{ from: "Devendra", to: "kernel" }],
      now: Date.now(),
    });
    expect(governed.strategy).toBe("graph");
    expect(governed.admitted[0]?.item.id).toBe(owner.id);
    expect(fuseChannels("graph", { lexical: 0.2, graph: 1, temporal: 0.2 })).toBeGreaterThan(
      fuseChannels("graph", { lexical: 0.2, graph: 0, temporal: 0.2 }),
    );

    const session = memory.remember({
      tier: "temporary",
      title: "Session lamp",
      text: "The session lamp stays dim for this hour.",
      source: "friday",
      kind: "preference",
      scope: "session",
      confidence: 0.7,
    });
    const ownerLamp = memory.remember({
      tier: "permanent",
      title: "Owner lamp",
      text: "The owner lamp stays warm white all year.",
      source: "user",
      kind: "preference",
      scope: "owner",
      verified: true,
      confidence: 1,
    });
    expect(preferredByScope([session, ownerLamp])?.id).toBe(ownerLamp.id);
  });
});
