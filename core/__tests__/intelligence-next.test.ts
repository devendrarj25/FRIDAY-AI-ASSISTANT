/**
 * Next-level intelligence on the existing Core Brain specialists — not a
 * second brain, graph DB, or Wikipedia dump.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { brainKnowledge } from "../../src/lib/friday/brain/knowledge-base";
import { ingestKnowledge } from "../../src/lib/friday/brain/knowledge-ingest";
import { inferMultiHop, shortestPath } from "../../src/lib/friday/brain/knowledge-graph";
import {
  expandQuery,
  lateInteraction,
  rankByRetrieval,
} from "../../src/lib/friday/brain/retrieval";
import { knowledgeStrips, evaluateSources } from "../../src/lib/friday/brain/research";
import { classifyCognitiveRoute } from "../../src/lib/friday/brain/cognitive-route";
import { reasonAbout, clearReasoningCache } from "../../src/lib/friday/brain/reasoning";
import { evaluateAnswer } from "../../src/lib/friday/brain/meta-reasoner";
import {
  readWorldInsight,
  resetWorldInsightForTests,
} from "../../src/lib/friday/brain/world-model";
import {
  COGNITIVE_BASELINE,
  installCognitiveBaseline,
} from "../../src/lib/friday/brain/cognitive-baseline";
import { learning } from "../../src/lib/friday/self/learning-engine";
import { memory } from "../../src/lib/friday/self/memory-engine";
import { experiences } from "../../src/lib/friday/self/task-ledger";
import { STRATEGY_SAMPLE_MIN } from "../../src/lib/friday/self/task-ledger";
import { baselineMethodSteps } from "../../src/lib/friday/self/task-graph";

describe("intelligence next level", () => {
  beforeEach(() => {
    memory.resetForTests();
    brainKnowledge.resetForTests();
    experiences.clear();
    clearReasoningCache();
    resetWorldInsightForTests();
  });

  it("1. deep reasoning: must-include is an assumption; conflict still backtracks", () => {
    const criteria = reasonAbout({
      prompt: "delete the temp folder and you must include rollback",
      evidence: "- [knowledge] temp folder path is C:\\Temp (source: identity, verified)",
    });
    expect(criteria.claims.some((row) => /Success criterion/i.test(row.text))).toBe(true);
    const clash = reasonAbout({
      prompt: "which timezone is the office",
      evidence: "- office timezone is IST\n- office timezone is not IST — it is UTC",
      contradictions: ["IST vs UTC"],
    });
    expect(clash.conclusions.some((row) => row.kind === "uncertainty")).toBe(true);
    expect(clash.preferredPath || clash.alternatives[0]).toBeTruthy();
  });

  it("2. semantic memory: late interaction and how-to expandQuery", () => {
    expect(lateInteraction(["owned", "friday"], ["friday", "owned", "desk"])).toBeGreaterThan(0.5);
    const variants = expandQuery("how to recover when the kernel is down");
    expect(variants.some((row) => /steps|method/i.test(row))).toBe(true);
  });

  it("3. canonical vector ids join memory rows before title overlap", () => {
    const items = [
      { id: "mem-keep", title: "noise title", text: "alpha project deadline is Friday" },
      { id: "mem-skip", title: "alpha project deadline", text: "unrelated teapot" },
    ];
    const ranked = rankByRetrieval(
      items,
      "alpha project Friday",
      (item) => ({
        id: item.id,
        title: item.title,
        text: item.text,
        source: "memory",
        confidence: 0.9,
        updatedAt: Date.now(),
      }),
      {
        k: 2,
        minScore: 0.9,
        vectorHits: [{ id: "mem-keep", title: "x", snippet: "y", score: 0.99 }],
      },
    );
    expect(ranked.some((hit) => hit.item.id === "mem-keep")).toBe(true);
  });

  it("4. knowledge extraction: enables triples on the Brain store", () => {
    const result = ingestKnowledge({
      kind: "document",
      source: "docs.extract",
      text: "Sandbox enables isolation. Kernel prevents unsigned-exec.",
    });
    expect(result.skipped).toBeNull();
    expect(result.entries.some((row) => row.predicate === "enables")).toBe(true);
  });

  it("5. graph multi-hop inference is labeled inference, not a new fact", () => {
    brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "Devendra",
      source: "test",
      provenance: "user",
    });
    brainKnowledge.assertBelief({
      subject: "Devendra",
      predicate: "works-on",
      object: "FRIDAY-desk",
      source: "test",
      provenance: "user",
    });
    expect(shortestPath("FRIDAY", "FRIDAY-desk").length).toBeGreaterThanOrEqual(2);
    const inferred = inferMultiHop("how is FRIDAY related to FRIDAY-desk");
    expect(inferred?.hops.length).toBeGreaterThanOrEqual(2);
    expect(inferred?.note).toMatch(/inference/i);
  });

  it("6. predictive world model reports likely-next ops only", () => {
    const insight = readWorldInsight();
    expect(Array.isArray(insight.likelyNext)).toBe(true);
  });

  it("7. research synthesis strips filler sentences", () => {
    const stripped = knowledgeStrips(
      "FRIDAY is owned by Devendra. The weather in Paris is sunny today. FRIDAY prefers local models.",
      "who owns FRIDAY",
    );
    expect(stripped).toMatch(/owned|Devendra|local/i);
    expect(stripped).not.toMatch(/Paris/);
    const judged = evaluateSources(
      [
        {
          title: "FRIDAY owner",
          url: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT",
          snippet: "FRIDAY owned-by Devendra. Buy cheap shoes now.",
          verified: false,
          score: 0.9,
        },
      ],
      "who owns FRIDAY",
    );
    expect(judged.usable[0]?.snippet).not.toMatch(/shoes/i);
  });

  it("8. cognitive task profiling: related-entity chat is deep-reasoning; haiku stays fast", () => {
    expect(
      classifyCognitiveRoute({ prompt: "how is FRIDAY related to Devendra", kind: "chat" }).action,
    ).toBe("deep-reasoning");
    expect(
      classifyCognitiveRoute({ prompt: "write a haiku about rain", kind: "chat" }).action,
    ).toBe("fast-path");
  });

  it("9. goal success-criteria: consequential must-include fails when omitted", () => {
    const judged = evaluateAnswer({
      prompt: "delete the temp folder and you must include rollback",
      answer: "The folder is gone.",
    });
    expect(judged.ran).toBe(true);
    expect(judged.ok).toBe(false);
    expect(judged.issues.join(" ")).toMatch(/must-include/i);
  });

  it("10. experience specialization returns the verified strategy text", () => {
    for (let i = 0; i < STRATEGY_SAMPLE_MIN; i += 1) {
      learning.evaluate({
        taskId: `spec-${i}`,
        kind: "report",
        title: "weekly report",
        success: true,
        verified: true,
        ms: 100,
        strategy: "use the ledger export",
      });
    }
    expect(learning.specializationFor("report")).toMatch(/ledger export/i);
  });

  it("11. install-time baseline v4 JSON locksteps TS and seeds unique beliefs", () => {
    const shipped = JSON.parse(
      readFileSync(resolve("config/cognitive-baseline.json"), "utf8"),
    ) as typeof COGNITIVE_BASELINE;
    expect(shipped).toEqual(COGNITIVE_BASELINE);
    expect(COGNITIVE_BASELINE.id).toBe("friday-cognitive-baseline-v4");
    const result = installCognitiveBaseline();
    expect(result.installed).toBe(true);
    expect(brainKnowledge.queryStatus("vector-hit joins-by canonical-row-id").status).toBe("known");
    expect(baselineMethodSteps("how is FRIDAY related to Devendra")?.length).toBeGreaterThanOrEqual(
      3,
    );
    expect(
      baselineMethodSteps(
        "Continue: finish the bid. Remaining after blocker (missing BOQ):\nattach the BOQ",
      ),
    ).toBeNull();
  });
});
