/**
 * Task 22 — targeted intelligence quality scenarios on existing stores.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { brainKnowledge } from "../../src/lib/friday/brain/knowledge-base";
import { understandTurn } from "../../src/lib/friday/brain/intent-engine";
import { reviewAssumptions, evaluateAnswer } from "../../src/lib/friday/brain/meta-reasoner";
import { reasonAbout } from "../../src/lib/friday/brain/reasoning";
import { retrievalScore, rankByRetrieval } from "../../src/lib/friday/brain/retrieval";
import {
  COGNITIVE_BASELINE,
  installCognitiveBaseline,
} from "../../src/lib/friday/brain/cognitive-baseline";
import { chooseRecovery } from "../../src/lib/friday/brain/self-diagnosis";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import { memory } from "../../src/lib/friday/self/memory-engine";
import { learning } from "../../src/lib/friday/self/learning-engine";
import { experiences } from "../../src/lib/friday/self/task-ledger";
import {
  graphProgress,
  planNodes,
  stepPurpose,
  TaskGraphEngine,
} from "../../src/lib/friday/self/task-graph";
import { autonomousCore } from "../../src/lib/friday/self/autonomous-core";
import { capabilityRegistry } from "../../src/lib/friday/brain/capability-registry";

describe("intelligence quality bar", () => {
  beforeEach(() => {
    memory.resetForTests();
    brainKnowledge.resetForTests();
    experiences.clear();
  });

  it("Knowledge: known fact is recalled concisely without forcing research", () => {
    brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "Devendra Singh Meena",
      source: "identity",
      provenance: "user",
      confidence: 1,
    });
    const hits = brainKnowledge.recall("who owns FRIDAY Devendra", { k: 2 });
    expect(hits[0]?.object).toBe("Devendra Singh Meena");
    expect(hits.length).toBeLessThanOrEqual(2);
    const status = brainKnowledge.queryStatus("who owns FRIDAY Devendra");
    expect(status.status).toBe("known");
    expect(reviewAssumptions({ text: "who owns FRIDAY" }).action).not.toBe("research");
  });

  it("Memory: later recall finds what was stored earlier", () => {
    memory.remember({
      tier: "semantic",
      title: "office snack",
      text: "Dev prefers roasted almonds at the desk",
      kind: "preference",
      source: "user",
      confidence: 0.9,
      verified: true,
    });
    const hits = memory.retrieve("roasted almonds snack at the desk");
    expect(hits[0]?.item.text).toMatch(/almonds/);
  });

  it("Ambiguity: a bare pronoun asks instead of guessing and answering", () => {
    const understood = understandTurn({ text: "it" });
    const review = reviewAssumptions({ text: "it", intent: understood.resolvedIntent });
    expect(review.action).toBe("ask");
    expect(review.ask).toBeTruthy();
    const evalAsk = evaluateAnswer({
      prompt: "it",
      answer: "I need a clearer target before acting. What should I do?",
      meta: review,
    });
    expect(evalAsk.ok).toBe(true);
  });

  it("Reasoning: multi-step problem yields structured solution, alternatives, verification", () => {
    const trace = reasonAbout({
      prompt:
        "collect the invoices then reconcile them then write the summary. why might reconcile fail?",
      evidence: "- [knowledge] invoices live in the ledger (source: identity, verified)",
    });
    expect(trace.stages.length).toBe(9);
    expect(trace.alternatives.length).toBeGreaterThan(0);
    expect(trace.claims.some((row) => row.kind === "hypothesis")).toBe(true);
    expect(trace.verified).toBe(true);
    expect(trace.publicNote).toMatch(/reasoning:/);
  });

  it("Contradiction: both facts stay and status is contradicted", () => {
    brainKnowledge.assertBelief({
      subject: "office",
      predicate: "timezone",
      object: "IST",
      source: "unverified-chat",
      provenance: "observed",
      confidence: 0.5,
    });
    brainKnowledge.assertBelief({
      subject: "office",
      predicate: "timezone",
      object: "UTC",
      source: "unverified-chat",
      provenance: "observed",
      confidence: 0.5,
    });
    const status = brainKnowledge.queryStatus("office timezone");
    expect(status.status).toBe("contradicted");
    expect(brainKnowledge.entries().filter((entry) => entry.predicate === "timezone")).toHaveLength(
      2,
    );
    expect(chooseRecovery({ failure: "timezone clash", contradicted: true }).kind).toBe("ask");
  });

  it("Research: changing/live fact is recognised as research, not a remembered guess", () => {
    const review = reviewAssumptions({ text: "what is the latest ollama version today" });
    expect(review.action).toBe("research");
    expect(brainKnowledge.queryStatus("latest ollama version").status).toBe("unknown");
  });

  it("Planning: multi-step objective decomposes with dependencies and outcome vs action", () => {
    const steps = planNodes(
      "1. collect invoices\n2. reconcile them so that the books match\n3. write the summary",
    );
    expect(steps.length).toBe(3);
    expect(stepPurpose(steps[1]!.instruction)).toBe("outcome");
    expect(stepPurpose(steps[0]!.instruction)).toBe("action");
    const engine = new TaskGraphEngine();
    engine.registerRunner("goal", async ({ node }) => ({ result: node.title }));
    const { id } = engine.submit("plan", { nodes: steps });
    const graph = engine.get(id)!;
    expect(graph.nodes[0]?.dependsOn).toEqual([]);
    expect(graph.nodes[1]?.dependsOn.length).toBe(1);
    const progress = graphProgress(graph);
    expect(progress.total).toBe(3);
    expect(progress.ratio).toBeGreaterThanOrEqual(0);
  });

  it("Failure: dangerous failure stops; transient may retry once; never a false success", () => {
    expect(chooseRecovery({ failure: "delete failed", dangerous: true }).kind).toBe("stop");
    expect(chooseRecovery({ failure: "HTTP 429 timeout", attempts: 0 }).kind).toBe("retry");
    expect(chooseRecovery({ failure: "HTTP 429 timeout", attempts: 2 }).kind).toBe("fallback");
    const failed = evaluateAnswer({
      prompt: "delete the temp folder on C",
      answer: "The folder was deleted successfully.",
      toolsFailed: true,
    });
    expect(failed.ok).toBe(false);
    expect(autonomousCore.appliesDirectly()).toBe(false);
  });

  it("Learning: a correction is stored; a pattern waits for a repeated verified outcome", () => {
    const first = learning.evaluate({
      taskId: "t1",
      kind: "report",
      title: "weekly report",
      success: true,
      verified: true,
      ms: 1200,
      strategy: "use the ledger export",
    });
    expect(first.learned).toBe(false);
    const second = learning.evaluate({
      taskId: "t2",
      kind: "report",
      title: "weekly report",
      success: true,
      verified: true,
      ms: 1100,
      strategy: "use the ledger export",
    });
    expect(second.learned).toBe(true);
    learning.evaluate({
      taskId: "t3",
      kind: "report",
      title: "weekly report",
      success: false,
      verified: false,
      ms: 50,
      correction: "always include GST in the weekly report",
    });
    const prefs = memory.getSnapshot().items.filter((item) => /GST/.test(item.text));
    expect(prefs.length).toBeGreaterThan(0);
  });

  it("Install baseline matches shipped JSON and seeds the existing knowledge store", () => {
    const shipped = JSON.parse(
      readFileSync(resolve("config/cognitive-baseline.json"), "utf8"),
    ) as typeof COGNITIVE_BASELINE;
    expect(shipped).toEqual(COGNITIVE_BASELINE);
    const result = installCognitiveBaseline();
    expect(result.installed).toBe(true);
    expect(result.count).toBeGreaterThan(4);
    expect(brainKnowledge.queryStatus("FRIDAY owned-by Devendra").status).toBe("known");
    expect(installCognitiveBaseline().installed).toBe(false);
  });

  it("Performance: retrieval ranking stays cheap on a small store", () => {
    const items = Array.from({ length: 80 }, (_, index) => ({
      title: index === 7 ? "alpha project deadline" : `noise ${index}`,
      text: index === 7 ? "alpha project deadline is Friday" : `unrelated teapot ${index}`,
      source: index === 7 ? "identity" : "chat",
      confidence: index === 7 ? 0.95 : 0.2,
      updatedAt: Date.now(),
    }));
    const t0 = performance.now();
    const ranked = rankByRetrieval(items, "alpha project Friday", (row) => row, {
      k: 4,
      minScore: 0.22,
    });
    const ms = performance.now() - t0;
    expect(ranked[0]?.item.title).toMatch(/deadline/);
    expect(ms).toBeLessThan(50);
    expect(retrievalScore(items[7]!, "alpha project Friday")).toBeGreaterThan(0.22);
  });

  it("Self-knowledge digest comes from the live capability registry", () => {
    const snap = capabilityRegistry.selfKnowledge();
    expect(snap.digest).toMatch(/enabled/);
    expect(snap.digest).toMatch(/unverified/);
  });
});

describe("connected cognize flow", () => {
  it("one deep request notes understanding → knowledge → world → meta → reasoning → route", async () => {
    const cognition = await coreBrain.cognize(
      "If I compare local vs cloud routing, what is the latest ollama version",
      { mode: "manual", allowTools: false },
    );
    const joined = cognition.notes.join("\n");
    const order = [/understood as/, /world state:/, /meta:/, /knowledge status:/, /reasoning:/];
    let cursor = -1;
    for (const pattern of order) {
      const at = cognition.notes.findIndex((note) => pattern.test(note));
      expect(at, `${pattern} missing in:\n${joined}`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(cognition.routing.length).toBeGreaterThan(0);
  });
});
