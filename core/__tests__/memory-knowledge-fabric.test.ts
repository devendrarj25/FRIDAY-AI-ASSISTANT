/**
 * Memory fabric governance on the existing memory and knowledge stores.
 * Supersession, deletion, scope, evidence, and replay are checked here.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { brainKnowledge } from "../../src/lib/friday/brain/knowledge-base";
import { ingestKnowledge } from "../../src/lib/friday/brain/knowledge-ingest";
import {
  admitMemory,
  applyOwnerCorrection,
  claimIngestFingerprint,
  classifyMemoryQuery,
  contractFor,
  exportFabricBundle,
  forgetEverywhere,
  gateEvidence,
  governRecall,
  MEMORY_CONTRACTS,
  MEMORY_FABRIC_SCHEMA,
  memoryCacheEpoch,
  migrateFabricBundle,
  projectLifecycle,
  promoteIfEvidenced,
  rebuildProjection,
  resetMemoryFabric,
  resolveStrategy,
  restoreFabricBundle,
  setMemoryFabricEnabled,
  takeCompiledMemory,
} from "../../src/lib/friday/brain/memory-fabric";
import { dependentsOf } from "../../src/lib/friday/brain/knowledge-graph";
import { prepareTurn } from "../../src/lib/friday/runtime";
import { consolidateEvent } from "../../src/lib/friday/self/memory-consolidate";
import { memory } from "../../src/lib/friday/self/memory-engine";

describe("memory knowledge fabric", () => {
  beforeEach(() => {
    memory.resetForTests();
    brainKnowledge.resetForTests();
    resetMemoryFabric();
  });

  it("names a contract for every durable kind, including the identity boundary", () => {
    expect(MEMORY_CONTRACTS.map((row) => row.id)).toEqual([
      "working",
      "episodic",
      "semantic",
      "procedural",
      "experience",
      "preference",
      "identity-boundary",
    ]);
    expect(contractFor("procedural").requiresEvidence).toBe(true);
    expect(contractFor("identity-boundary").inferSensitive).toBe(false);
    expect(MEMORY_FABRIC_SCHEMA).toBe(1);
  });

  it("keeps an unverified durable contract episodic until evidence exists", () => {
    const row = admitMemory({
      contract: "procedural",
      title: "Restart kernel",
      text: "Restart the kernel only after the owner asks and the health check passes.",
      source: "conversation",
    });
    expect(row.stored).toBe(true);
    expect(row.item?.tier).toBe("episodic");
    expect(row.item?.kind).toBe("procedural");
    const again = admitMemory({
      contract: "procedural",
      title: "Restart kernel",
      text: "Restart the kernel only after the owner asks and the health check passes.",
      source: "conversation",
    });
    expect(again.duplicate).toBe(true);
    expect(again.stored).toBe(false);
    expect(
      memory.getSnapshot().items.filter((item) => item.title === "Restart kernel"),
    ).toHaveLength(1);
  });

  it("does not infer a sensitive attribute or an identity", () => {
    const guessed = admitMemory({
      title: "Private trait",
      text: "The owner religion is guessed from the last few chats and should be stored.",
      source: "conversation",
      inferred: true,
    });
    expect(guessed.stored).toBe(false);
    expect(guessed.reason).toMatch(/not inferred/);
    const identity = admitMemory({
      contract: "identity-boundary",
      title: "Publisher guess",
      text: "A model guessed that somebody else publishes this FRIDAY desk.",
      source: "conversation",
      inferred: true,
    });
    expect(identity.stored).toBe(false);
    expect(identity.reason).toMatch(/identity is not inferred/);
    const skipped = consolidateEvent({
      text: "The owner religion is guessed from the last few chats and should be stored.",
      source: "conversation",
    });
    expect(skipped.kept).toBe(false);
    expect(skipped.reason).toMatch(/not inferred/);
  });

  it("lets an explicit correction replace the current answer and keep the old one for history", () => {
    const now = Date.now();
    memory.remember({
      tier: "permanent",
      title: "Editor theme",
      text: "The editor theme stays dark at night for this desk.",
      source: "friday",
      kind: "preference",
      confidence: 0.7,
    });
    const corrected = applyOwnerCorrection({
      title: "Editor theme",
      text: "The editor theme stays light during the day for this desk.",
    });
    expect(corrected.supersededId).toBeTruthy();
    expect(corrected.reason).toMatch(/superseded/);
    const archive = memory.getSnapshot().items;
    const current = governRecall({
      prompt: "what editor theme do I prefer",
      hits: memory.retrieve("editor theme", 6),
      archive,
      now,
    });
    expect(current.admitted.some((hit) => /light/.test(hit.item.text))).toBe(true);
    expect(current.admitted.some((hit) => /dark/.test(hit.item.text))).toBe(false);
    const historical = governRecall({
      prompt: "what editor theme did I prefer previously",
      hits: memory.retrieve("editor theme", 6),
      archive,
      now,
    });
    expect(historical.plan.historical).toBe(true);
    expect(historical.admitted.some((hit) => /dark/.test(hit.item.text))).toBe(true);
    expect(historical.admitted.find((hit) => /dark/.test(hit.item.text))?.evidence).toBe("stale");
    expect(
      projectLifecycle(archive).some(
        (link) => link.link === "supersession" && link.to === corrected.item.id,
      ),
    ).toBe(true);
  });

  it("keeps two scopes instead of letting the newest write win", () => {
    memory.remember({
      tier: "permanent",
      title: "Notify sound",
      text: "Notify sound is chime for the owner desk.",
      source: "user",
      kind: "preference",
      verified: true,
      confidence: 0.9,
      projectId: "desk",
    });
    const result = applyOwnerCorrection({
      title: "Notify sound",
      text: "Notify sound is silent in the lab.",
      projectId: "lab",
    });
    expect(result.supersededId).toBeNull();
    expect(result.reason).toMatch(/both records/);
    const live = memory
      .getSnapshot()
      .items.filter((item) => item.title === "Notify sound" && !item.supersededAt);
    expect(live).toHaveLength(2);
  });

  it("does not overwrite the first-run identity boundary", () => {
    const owner = memory.getSnapshot().items.find((item) => item.title === "Owner");
    expect(owner?.source).toBe("first-run");
    const result = applyOwnerCorrection({
      title: "Owner",
      text: "A different person publishes FRIDAY now and the old owner is gone.",
    });
    expect(result.supersededId).toBeNull();
    expect(result.reason).toMatch(/identity boundary/);
    expect(memory.getSnapshot().items.find((item) => item.id === owner?.id)?.text).toMatch(
      /Devendra/,
    );
  });

  it("withholds deleted, expired, weak, contradicted, and out-of-scope rows", () => {
    const now = 5_000;
    const lamp = memory.remember({
      tier: "permanent",
      title: "Desk lamp",
      text: "The desk lamp stays warm white in the studio.",
      source: "user",
      kind: "preference",
      verified: true,
      confidence: 0.9,
      scope: "project",
      projectId: "studio",
    });
    const scoped = governRecall({
      prompt: "desk lamp warm white",
      hits: [{ item: lamp, score: 0.9 }],
      now,
      scope: "session",
    });
    expect(scoped.admitted).toHaveLength(0);
    expect(scoped.withheld[0]?.reason).toBe("out of scope");

    const rumor = memory.remember({
      tier: "working",
      title: "Blue lamp rumor",
      text: "Someone guessed the lamp was blue without checking the room.",
      confidence: 0.2,
      verified: false,
    });
    const weak = governRecall({
      prompt: "blue lamp rumor",
      hits: [{ item: rumor, score: 0.9 }],
      now,
    });
    expect(weak.admitted).toHaveLength(0);
    expect(weak.withheld.some((row) => row.reason === "weak")).toBe(true);

    memory.update(lamp.id, { contradiction: true });
    const contradicted = memory.getSnapshot().items.find((item) => item.id === lamp.id)!;
    expect(gateEvidence(contradicted, now).klass).toBe("contradicted");
    expect(gateEvidence(contradicted, now).mayInfluence).toBe(false);

    memory.update(lamp.id, { contradiction: false });
    const cleared = memory.getSnapshot().items.find((item) => item.id === lamp.id)!;
    const expired = { ...cleared, expiresAt: 1_000 };
    const stale = governRecall({
      prompt: "desk lamp warm white",
      hits: [{ item: expired, score: 0.9 }],
      now,
      scope: "project",
      projectId: "studio",
    });
    expect(stale.withheld.some((row) => row.reason === "stale")).toBe(true);
  });

  it("deletes a record from authority, projection, export, and the compiled packet", () => {
    const epoch = memoryCacheEpoch();
    const admitted = admitMemory({
      title: "Pack rule",
      text: "FRIDAY keeps the full chat on this PC and sends only the ranked lines.",
      source: "user",
      verified: true,
    });
    const id = admitted.item?.id ?? "";
    expect(id).toBeTruthy();
    expect(
      brainKnowledge.getSnapshot().entries.some((entry) => entry.derivedFromMemoryId === id),
    ).toBe(true);
    const backup = exportFabricBundle();
    const removed = forgetEverywhere(id);
    expect(removed.removed).toBe(true);
    expect(removed.knowledgeIds.length).toBeGreaterThan(0);
    expect(memory.getSnapshot().items.some((item) => item.id === id)).toBe(false);
    expect(
      brainKnowledge.getSnapshot().entries.some((entry) => entry.derivedFromMemoryId === id),
    ).toBe(false);
    const rebuilt = rebuildProjection(JSON.parse(backup).memory.items as never, Date.now());
    expect(rebuilt.records.some((row) => row.id === id)).toBe(false);
    expect(rebuilt.omitted).toContain(id);
    const after = JSON.parse(exportFabricBundle()) as {
      tombstones: string[];
      memory: { items: { id: string }[] };
    };
    expect(after.tombstones).toContain(id);
    expect(after.memory.items.some((item) => item.id === id)).toBe(false);
    const hidden = governRecall({
      prompt: "ranked lines on this PC",
      hits: [{ item: admitted.item!, score: 1 }],
      now: Date.now(),
    });
    expect(hidden.admitted).toHaveLength(0);
    expect(hidden.withheld[0]?.reason).toBe("deleted");
    expect(memoryCacheEpoch()).toBeGreaterThan(epoch);
    const compiled = takeCompiledMemory(`pack:${id}`, () => ["gone"]);
    expect(compiled.reused).toBe(false);

    restoreFabricBundle(backup);
    expect(memory.getSnapshot().items.some((item) => item.title === "Pack rule")).toBe(true);
    restoreFabricBundle(exportFabricBundle());
    const wiped = exportFabricBundle();
    forgetEverywhere(
      memory.getSnapshot().items.find((item) => item.title === "Pack rule")?.id ?? id,
    );
    const tombstoneBackup = exportFabricBundle();
    restoreFabricBundle(wiped);
    restoreFabricBundle(tombstoneBackup);
    expect(memory.getSnapshot().items.some((item) => item.title === "Pack rule")).toBe(false);
  });

  it("migrates an unversioned backup and refuses a newer schema", () => {
    const migrated = migrateFabricBundle({
      version: 1,
      exportedAt: 5,
      items: [{ id: "mem-old", title: "Old", text: "An older backup row." }],
    });
    expect(migrated.schema).toBe(MEMORY_FABRIC_SCHEMA);
    expect(migrated.memory.items).toHaveLength(1);
    expect(migrated.tombstones).toEqual([]);
    expect(() => migrateFabricBundle({ schema: 9, memory: { items: [] } })).toThrow(/newer/);
    expect(() => migrateFabricBundle(null)).toThrow(/not an object/);
  });

  it("classifies retrieval and falls back to lexical recall when no vectors exist", () => {
    const hybrid = classifyMemoryQuery("who owns the kernel and what is current");
    expect(hybrid.strategy).toBe("hybrid");
    expect(hybrid.currentness).toBe(true);
    const fallback = resolveStrategy(hybrid, false);
    expect(fallback.degraded).toBe(true);
    expect(fallback.strategy).toBe("lexical");
    const governed = governRecall({
      prompt: "who owns the kernel and what is current",
      hits: [],
      vectorsAvailable: false,
      now: Date.now(),
    });
    expect(governed.degraded).toBe(true);
    expect(governed.strategy).toBe("lexical");
    expect(classifyMemoryQuery("what editor theme did I prefer previously").strategy).toBe(
      "temporal",
    );
    expect(classifyMemoryQuery("a".repeat(150)).strategy).toBe("vector");
  });

  it("promotes a verified episode and replays an identical ingest without a second belief", () => {
    const episode = memory.remember({
      tier: "episodic",
      title: "Pack step",
      text: "FRIDAY packs a cognitive context packet by ranking the lines this turn needs.",
      kind: "experience",
      verified: true,
      confidence: 0.8,
    });
    expect(promoteIfEvidenced({ ...episode, verified: false, confidence: 0.2 }).promoted).toBe(
      false,
    );
    expect(promoteIfEvidenced(episode).promoted).toBe(true);
    expect(memory.getSnapshot().items.find((item) => item.id === episode.id)?.tier).toBe(
      "semantic",
    );

    expect(claimIngestFingerprint("docs.extract", "Widget depends on libbar.")).toBe(true);
    resetMemoryFabric();
    const once = ingestKnowledge({
      kind: "document",
      source: "docs.extract",
      text: "Widget depends on libbar.",
    });
    const twice = ingestKnowledge({
      kind: "document",
      source: "docs.extract",
      text: "Widget depends on libbar.",
    });
    expect(once.skipped).toBeNull();
    expect(once.stages.map((stage) => stage.id)).toEqual([
      "source",
      "ingest",
      "parse",
      "extract",
      "verify",
      "link",
      "update",
      "freshness",
    ]);
    expect(twice.skipped).toMatch(/duplicate source replay/);
    expect(dependentsOf("libbar").filter((hop) => hop.from === "Widget")).toHaveLength(1);
  });

  it("keeps a contradicted row out of the turn packet unless governance is rolled back", () => {
    const item = memory.remember({
      tier: "semantic",
      title: "Blue lamp rumor",
      text: "The blue lamp rumor is contradicted by the owner and must not be stated as fact.",
      confidence: 0.9,
      verified: true,
    });
    memory.update(item.id, { contradiction: true });
    const prompt = "blue lamp rumor contradicted by the owner";
    setMemoryFabricEnabled(false);
    const open = prepareTurn(prompt, { depth: 6, multiModel: false });
    setMemoryFabricEnabled(true);
    const closed = prepareTurn(prompt, { depth: 6, multiModel: false });
    expect(open.context.join(" ")).toMatch(/blue lamp rumor/i);
    expect(closed.context.join(" ")).not.toMatch(/blue lamp rumor/i);
    const first = takeCompiledMemory("stable-line", () => ["one"]);
    const second = takeCompiledMemory("stable-line", () => ["two"]);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.lines).toEqual(["one"]);
  });
});
