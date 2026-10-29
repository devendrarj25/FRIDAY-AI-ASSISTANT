/**
 * Knowledge ingestion: existing extractors only; privacy firewall unchanged.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { brainKnowledge } from "../../src/lib/friday/brain/knowledge-base";
import { ingestKnowledge } from "../../src/lib/friday/brain/knowledge-ingest";
import { dependentsOf } from "../../src/lib/friday/brain/knowledge-graph";

describe("knowledge ingestion", () => {
  beforeEach(() => {
    brainKnowledge.resetForTests();
  });

  it("runs SOURCE→…→FRESHNESS and links a depends-on edge", () => {
    const result = ingestKnowledge({
      kind: "document",
      source: "docs.extract",
      text: "Component depends on libfoo. Project contains Component.",
    });
    expect(result.skipped).toBeNull();
    expect(result.stages.map((stage) => stage.id)).toEqual([
      "source",
      "ingest",
      "parse",
      "extract",
      "verify",
      "link",
      "update",
      "freshness",
    ]);
    expect(dependentsOf("libfoo").some((hop) => hop.from === "Component")).toBe(true);
    expect(result.entries[0]?.freshnessAt).toBeTruthy();
  });

  it("refuses sensitive text instead of learning it", () => {
    const result = ingestKnowledge({
      kind: "conversation",
      source: "chat",
      text: "my password: hunter2 and Component depends on secretlib",
    });
    expect(result.skipped).toMatch(/sensitive/);
    expect(result.entries).toHaveLength(0);
    expect(dependentsOf("secretlib")).toHaveLength(0);
  });
});
