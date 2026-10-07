/**
 * Super-intelligence closeout: one connected Core Brain turn, honest gaps.
 * Causal analysis lives on inspectSelf (own failures), not every chat turn.
 */
import { describe, expect, it } from "vitest";

import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import { lastDecision } from "../../src/lib/friday/brain/decision-trace";
import { inspectSelf } from "../../src/lib/friday/brain/self-diagnosis";
import { runIntelligenceBenchmark } from "../../src/lib/friday/self/intelligence-benchmark";

const PROMPT =
  "If I route to llama3.2 instead of qwen, what does history say? Also what is the latest ollama version";

function indexOf(notes: string[], pattern: RegExp): number {
  return notes.findIndex((note) => pattern.test(note));
}

describe("super-intelligence closeout", () => {
  it("traces one complex cognize through the connected fabric in order", async () => {
    const cognition = await coreBrain.cognize(PROMPT, { mode: "manual", allowTools: false });
    const notes = cognition.notes;
    const joined = notes.join("\n");

    const order = [
      /understood as/,
      /goal:/,
      /modality:/,
      /cognitive:/,
      /fabric: deep/,
      /world state:/,
      /meta:/,
      /ops what-if:/,
      /freshness:/,
    ];
    let cursor = -1;
    for (const pattern of order) {
      const at = indexOf(notes, pattern);
      expect(at, `${pattern} missing or out of order in:\n${joined}`).toBeGreaterThan(cursor);
      cursor = at;
    }

    expect(cognition.understanding).toBeTruthy();
    expect(cognition.routing.length).toBeGreaterThan(0);
    expect(lastDecision()?.understanding).toBeTruthy();
    expect(joined).toMatch(/research/);

    const verification = coreBrain.reflect({
      cognition,
      answer:
        "Historical routing for llama3.2 vs qwen is whatever the model registry recorded; I could not reach the live web here, so I do not have a current Ollama version number.",
      ok: true,
      ms: 12,
    });
    expect(verification.ok).toBe(true);
    expect(verification.detail).toMatch(/verified/i);
  });

  it("keeps causal analysis on inspectSelf and the benchmark bypass-free", () => {
    const report = inspectSelf();
    expect(report.causal).toBeTruthy();
    expect(report.causal?.safest).toMatch(/governance/i);
    const bench = runIntelligenceBenchmark();
    expect(bench.safetyBypassDetected).toBe(false);
    expect(bench.failed).toBe(0);
  });
});
