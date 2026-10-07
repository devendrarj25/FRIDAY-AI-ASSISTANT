/**
 * Pre-intelligence: hybrid retrieval, research gating, graph neighborhood,
 * HTN methods, and a richer install-time baseline.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  bm25Lite,
  expandQuery,
  gradeRetrieval,
  mmrRerank,
  rankByRetrieval,
  reciprocalRankFusion,
} from "../../src/lib/friday/brain/retrieval";
import {
  shouldResearch,
  evaluateSources,
  formulateQueries,
  looksLikeLiveFact,
  looksLikeKnowledgeAsk,
} from "../../src/lib/friday/brain/research";
import { ingestKnowledge } from "../../src/lib/friday/brain/knowledge-ingest";
import { localNeighborhood, shortestPath } from "../../src/lib/friday/brain/knowledge-graph";
import { brainKnowledge } from "../../src/lib/friday/brain/knowledge-base";
import {
  COGNITIVE_BASELINE,
  installCognitiveBaseline,
} from "../../src/lib/friday/brain/cognitive-baseline";
import { planNodes, baselineMethodSteps } from "../../src/lib/friday/self/task-graph";
import { extractDeadline, looksLikeHorizonGoal } from "../../src/lib/friday/self/horizon-goals";
import { learning } from "../../src/lib/friday/self/learning-engine";
import { memory } from "../../src/lib/friday/self/memory-engine";
import { experiences } from "../../src/lib/friday/self/task-ledger";
import {
  reasonAbout,
  clearReasoningCache,
  leastToMostOrder,
} from "../../src/lib/friday/brain/reasoning";
import { reviewAssumptions, evaluateAnswer } from "../../src/lib/friday/brain/meta-reasoner";
import {
  readWorldInsight,
  resetWorldInsightForTests,
} from "../../src/lib/friday/brain/world-model";

describe("pre-intelligence", () => {
  beforeEach(() => {
    memory.resetForTests();
    brainKnowledge.resetForTests();
    experiences.clear();
    clearReasoningCache();
    resetWorldInsightForTests();
  });

  it("RRF prefers an id that ranks in both lists", () => {
    const fused = reciprocalRankFusion([
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ id: "c" }, { id: "a" }],
    ]);
    expect(fused[0]?.id).toBe("a");
  });

  it("BM25-lite scores a document that repeats the query term higher", () => {
    const query = ["almonds"];
    const weak = bm25Lite(query, ["desk", "owner"]);
    const strong = bm25Lite(query, ["almonds", "almonds", "snack"]);
    expect(strong).toBeGreaterThan(weak);
  });

  it("grades retrieval like CRAG: empty / weak / strong", () => {
    expect(gradeRetrieval([]).grade).toBe("incorrect");
    expect(gradeRetrieval([{ score: 0.25 }]).grade).toBe("ambiguous");
    expect(gradeRetrieval([{ score: 0.7 }]).grade).toBe("correct");
  });

  it("Self-RAG: live facts research; known+fresh do not", () => {
    expect(looksLikeLiveFact("what is the latest ollama release")).toBe(true);
    expect(shouldResearch({ status: "known", liveFact: false })).toBe(false);
    expect(shouldResearch({ status: "stale", liveFact: false })).toBe(true);
    expect(shouldResearch({ status: "unknown", liveFact: false })).toBe(false);
    expect(shouldResearch({ status: "known", liveFact: true })).toBe(true);
    expect(shouldResearch({ status: "unknown", liveFact: false, knowledgeAsk: true })).toBe(true);
    expect(looksLikeKnowledgeAsk("write a haiku about rain")).toBe(false);
    expect(looksLikeKnowledgeAsk("what is photosynthesis")).toBe(true);
  });

  it("discards weak web sources instead of promoting them to fact", () => {
    const judged = evaluateSources([
      { title: "x", url: "http://example.invalid", snippet: "hi", verified: false, score: 0.12 },
    ]);
    expect(judged.grade).toBe("incorrect");
    expect(judged.usable).toHaveLength(0);
  });

  it("ingests prefers/is-a relations onto the existing store", () => {
    const result = ingestKnowledge({
      text: "FRIDAY prefers local-first and Core-Brain is-a orchestrator",
      source: "test",
      kind: "conversation",
    });
    expect(result.skipped).toBeNull();
    expect(result.entries.some((row) => row.predicate === "prefers")).toBe(true);
    expect(result.entries.some((row) => row.predicate === "is-a")).toBe(true);
  });

  it("local neighborhood fans out from named entities including a 2-hop", () => {
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
    const hops = localNeighborhood("who owns FRIDAY");
    expect(hops.some((hop) => hop.to === "Devendra" || hop.from === "FRIDAY")).toBe(true);
    expect(hops.some((hop) => hop.to === "FRIDAY-desk" || hop.from === "Devendra")).toBe(true);
  });

  it("vector snippets can promote a lexical near-miss via fusion", () => {
    const items = [
      {
        id: "1",
        title: "office snack",
        text: "roasted almonds at the desk",
        source: "user",
        confidence: 0.9,
        updatedAt: Date.now(),
      },
      {
        id: "2",
        title: "identity",
        text: "Dev is the owner",
        source: "identity",
        confidence: 1,
        updatedAt: Date.now(),
      },
    ];
    const ranked = rankByRetrieval(items, "almonds snack", (row) => row, {
      k: 2,
      minScore: 0.22,
      vectorHits: [{ title: "office snack", snippet: "roasted almonds at the desk", score: 0.8 }],
    });
    expect(ranked[0]?.item.title).toBe("office snack");
  });

  it("HTN baseline method decomposes diagnose asks without rewriting listed steps", () => {
    const method = baselineMethodSteps("troubleshoot why the kernel is not working");
    expect(method?.length).toBeGreaterThanOrEqual(3);
    const listed = planNodes("1. collect invoices\n2. reconcile them");
    expect(listed.map((step) => step.instruction).join(" ")).toMatch(/invoice/i);
    expect(listed).toHaveLength(2);
    expect(baselineMethodSteps("import a pack from this zip")?.length).toBeGreaterThanOrEqual(3);
  });

  it("horizon goals reuse HTN methods on the existing task graph", () => {
    const request = "troubleshoot why the kernel is not working by friday";
    expect(looksLikeHorizonGoal(request)).toBe(true);
    expect(extractDeadline(request)).toMatch(/friday/i);
    expect(planNodes(request).length).toBeGreaterThanOrEqual(3);
  });

  it("shipped JSON matches TS baseline and seeds methods + beliefs", () => {
    const shipped = JSON.parse(
      readFileSync(resolve("config/cognitive-baseline.json"), "utf8"),
    ) as typeof COGNITIVE_BASELINE;
    expect(shipped).toEqual(COGNITIVE_BASELINE);
    expect(COGNITIVE_BASELINE.methods.length).toBeGreaterThanOrEqual(3);
    expect(COGNITIVE_BASELINE.beliefs.length).toBeGreaterThanOrEqual(8);
    const result = installCognitiveBaseline();
    expect(result.installed).toBe(true);
    expect(result.count).toBeGreaterThan(10);
    expect(brainKnowledge.queryStatus("FRIDAY renderer-is Electron").status).toBe("known");
    expect(installCognitiveBaseline().installed).toBe(false);
  });

  it("Reflexion writes an episodic reflection after a failed outcome", () => {
    learning.evaluate({
      taskId: "t-fail",
      kind: "report",
      title: "weekly report",
      success: false,
      verified: false,
      ms: 20,
      cause: "missing GST",
      lesson: "always include GST",
    });
    const hits = memory.getSnapshot().items.filter((item) => item.tags.includes("reflection"));
    expect(hits.some((item) => /GST/.test(item.text))).toBe(true);
    const ctx = learning.contextFor("weekly report GST");
    expect(ctx.text).toMatch(/GST/);
  });

  it("reasoning reports groundedness without dumping claim text", () => {
    const trace = reasonAbout({
      prompt: "who owns FRIDAY",
      evidence: "- [knowledge] FRIDAY owned-by Devendra Singh Meena (source: identity, verified)",
    });
    expect(trace.groundedness).toBeGreaterThan(0);
    expect(trace.publicNote).toMatch(/grounded/);
    expect(trace.publicNote).not.toContain("owned-by Devendra");
  });

  it("haiku still proceeds; latest-release still wants research", () => {
    expect(reviewAssumptions({ text: "write a haiku about rain" }).action).toBe("proceed");
    expect(reviewAssumptions({ text: "what is the latest ollama release" }).action).toBe(
      "research",
    );
    expect(reviewAssumptions({ text: "what is photosynthesis" }).action).toBe("research");
  });

  it("world insight records a value change across snapshots", () => {
    const first = readWorldInsight();
    expect(first.snapshot.facts.length).toBeGreaterThan(0);
    expect(Array.isArray(first.atRisk)).toBe(true);
    const second = readWorldInsight();
    expect(Array.isArray(second.changed)).toBe(true);
  });

  it("expands who-owns into a stored-belief phrase (HyDE-lite lexical)", () => {
    const variants = expandQuery("who owns FRIDAY");
    expect(variants.some((row) => /owned-by/i.test(row))).toBe(true);
    const queries = formulateQueries("who owns FRIDAY");
    expect(queries[0]).toMatch(/who owns/i);
    expect(queries.some((row) => /owned-by/i.test(row))).toBe(true);
  });

  it("MMR prefers a diverse second hit over a near-duplicate identity row", () => {
    const ranked = mmrRerank(
      [
        { item: "ident-a", score: 0.92 },
        { item: "ident-b", score: 0.9 },
        { item: "snack", score: 0.55 },
      ],
      (hit) =>
        hit.item === "snack"
          ? "roasted almonds at the office desk"
          : "FRIDAY owned-by Devendra identity owner",
      2,
      0.5,
    );
    expect(ranked.map((hit) => hit.item)).toContain("snack");
  });

  it("least-to-most gathers who/what before why without rewriting listed steps", () => {
    const ordered = leastToMostOrder(["why did the kernel fail", "who owns FRIDAY"]);
    expect(ordered[0]).toMatch(/who owns/i);
    const listed = planNodes("1. collect invoices\n2. reconcile them");
    expect(listed).toHaveLength(2);
    expect(listed.map((step) => step.instruction).join(" ")).toMatch(/invoice/i);
    expect(listed.map((step) => step.instruction).join(" ")).toMatch(/reconcil/i);
  });

  it("contradicting evidence yields only uncertainty conclusions", () => {
    const trace = reasonAbout({
      prompt: "which timezone is the office",
      evidence: "- office timezone is IST\n- office timezone is not IST — it is UTC",
      contradictions: ["IST vs UTC"],
    });
    expect(trace.consistency).toBe("single");
    expect(trace.conclusions.every((row) => row.kind === "uncertainty")).toBe(true);
    expect(trace.conclusions.some((row) => row.kind === "fact")).toBe(false);
    expect(trace.publicNote).not.toContain("office timezone is IST");
  });

  it("shortest path walks existing SPO edges", () => {
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
    const path = shortestPath("FRIDAY", "FRIDAY-desk");
    expect(path.length).toBeGreaterThanOrEqual(2);
  });

  it("ingests caused-by and normalizes friday to FRIDAY", () => {
    const result = ingestKnowledge({
      text: "friday failed because timeout and renderer belongs to electron",
      source: "test",
      kind: "conversation",
    });
    expect(result.skipped).toBeNull();
    expect(
      result.entries.some((row) => row.predicate === "caused-by" && row.subject === "FRIDAY"),
    ).toBe(true);
    expect(result.entries.some((row) => row.predicate === "part-of")).toBe(true);
  });

  it("kernel-down method does not steal Continue leftovers", () => {
    expect(baselineMethodSteps("python kernel is down")?.length).toBeGreaterThanOrEqual(3);
    expect(
      baselineMethodSteps(
        "Continue: finish the bid. Remaining after blocker (missing BOQ):\nattach the BOQ",
      ),
    ).toBeNull();
    expect(COGNITIVE_BASELINE.id).toBe("friday-cognitive-baseline-v4");
  });

  it("self-eval fails certainty on a weakly grounded consequential answer", () => {
    const judged = evaluateAnswer({
      prompt: "delete the temp folder on this machine",
      answer: "I am sure the folder is gone.",
      groundedness: 0.1,
    });
    expect(judged.ran).toBe(true);
    expect(judged.ok).toBe(false);
    expect(judged.issues.join(" ")).toMatch(/weakly grounded/i);
  });
});
