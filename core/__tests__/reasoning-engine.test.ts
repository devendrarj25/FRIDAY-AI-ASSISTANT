/**
 * Structured reasoning on the existing reasoning.ts file — not a reasoning/ folder.
 */
import { describe, expect, it, beforeEach } from "vitest";

import {
  REASONING_STAGES,
  clearReasoningCache,
  decomposePrompt,
  publicReasoningNote,
  reasonAbout,
} from "../../src/lib/friday/brain/reasoning";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";

describe("structured reasoning", () => {
  beforeEach(() => clearReasoningCache());

  it("keeps the existing private stage list", () => {
    expect(REASONING_STAGES).toEqual([
      "understand",
      "decompose",
      "gather",
      "options",
      "evaluate",
      "decide",
      "execute",
      "verify",
      "reflect",
    ]);
  });

  it("decomposes a multi-step ask without inventing extra work", () => {
    const parts = decomposePrompt("collect invoices then reconcile them then write the summary");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.join(" ")).toMatch(/invoice/i);
  });

  it("labels evidence as fact and a why-ask as hypothesis, never as fact", () => {
    const trace = reasonAbout({
      prompt: "why did the install fail",
      evidence: "- [knowledge] FRIDAY owned-by Devendra Singh Meena (source: identity, verified)",
    });
    expect(trace.claims.some((row) => row.kind === "fact")).toBe(true);
    expect(trace.claims.some((row) => row.kind === "hypothesis")).toBe(true);
    expect(trace.conclusions.every((row) => row.kind !== "hypothesis")).toBe(true);
    expect(trace.stages.map((row) => row.id)).toEqual([...REASONING_STAGES]);
    expect(trace.publicNote).toMatch(/^reasoning:/);
    expect(trace.publicNote).not.toMatch(/chain-of-thought|let me think step by step/i);
  });

  it("keeps conflicting evidence as uncertainty instead of picking a side", () => {
    const trace = reasonAbout({
      prompt: "which timezone is the office",
      evidence: "- office timezone is IST\n- office timezone is not IST — it is UTC",
      contradictions: ["IST vs UTC"],
    });
    expect(trace.contradictions.length).toBeGreaterThan(0);
    expect(
      trace.conclusions.some((row) => row.kind === "uncertainty" || row.kind === "unknown"),
    ).toBe(true);
    expect(trace.verified).toBe(true);
  });

  it("treats what-if and trade-offs as hypotheses", () => {
    const trace = reasonAbout({
      prompt: "what if I use cloud vs local models",
    });
    expect(trace.claims.some((row) => row.kind === "hypothesis")).toBe(true);
    expect(trace.alternatives.length).toBeGreaterThan(0);
  });

  it("reuses an identical in-session result instead of recomputing", () => {
    const first = reasonAbout({ prompt: "compare two recovery options" });
    const second = reasonAbout({ prompt: "compare two recovery options" });
    expect(second).toBe(first);
  });

  it("public note never includes private claim text dumps", () => {
    const trace = reasonAbout({ prompt: "plan a safe retry" });
    expect(publicReasoningNote(trace)).not.toContain(trace.claims[0]?.text ?? "___none___");
  });

  it("deep cognize stamps a public reasoning note, not chain-of-thought", async () => {
    const cognition = await coreBrain.cognize("why did the latest ollama install fail", {
      mode: "manual",
      allowTools: false,
    });
    expect(cognition.notes.join(" ")).toMatch(/reasoning:/);
    expect(cognition.reasoning?.publicNote).toMatch(/^reasoning:/);
    expect(JSON.stringify(cognition.reasoning)).not.toMatch(/let me think/i);
  });
});
