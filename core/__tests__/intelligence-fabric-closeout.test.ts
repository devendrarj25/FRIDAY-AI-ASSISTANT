/**
 * Intelligence-fabric closeout: one Core Brain flow, live self-knowledge,
 * and a real timing check that simple chat does not take the deep path.
 */
import { describe, expect, it } from "vitest";

import { describeLiveSelf } from "../../src/lib/friday/brain/app-guide";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { coreBrain, needsDeepFabric } from "../../src/lib/friday/brain/core-brain";
import { lastDecision } from "../../src/lib/friday/brain/decision-trace";
import { understandTurn } from "../../src/lib/friday/brain/intent-engine";

function median(samples: number[]): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

describe("intelligence fabric closeout", () => {
  it("keeps simple greetings on the existing baseline path (never cognize)", () => {
    const reply = baselineRespond("hello");
    expect(reply.handled).toBe(true);
    expect(needsDeepFabric("hello", understandTurn({ text: "hello" }))).toBe(false);
  });

  it("traces one deep chat turn Understand → Knowledge → World → Meta → Route → Verify → Learn", async () => {
    const cognition = await coreBrain.cognize("what is the latest ollama version", {
      mode: "manual",
      allowTools: false,
    });
    const notes = cognition.notes.join(" ");
    expect(notes).toMatch(/fabric: deep/);
    expect(notes).toMatch(/understood as/);
    expect(notes).toMatch(/goal:/);
    expect(notes).toMatch(/world state:/);
    expect(notes).toMatch(/meta:/);
    expect(notes).toMatch(/freshness:/);
    expect(cognition.understanding).toBeTruthy();
    expect(lastDecision()?.understanding).toBeTruthy();

    const verification = coreBrain.reflect({
      cognition,
      answer:
        "I could not reach the live web in this environment, so I do not have a current Ollama version number.",
      ok: true,
      ms: 8,
    });
    expect(verification.ok).toBe(true);
    expect(verification.detail).toMatch(/verified/i);
  });

  it("skips world/meta on a simple haiku turn and stays faster than a deep turn", async () => {
    await coreBrain.cognize("write a haiku about rain", { mode: "manual", allowTools: false });
    await coreBrain.cognize("what is the latest ollama version", {
      mode: "manual",
      allowTools: false,
    });

    const lightSamples: number[] = [];
    let lightNotes = "";
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      const cognition = await coreBrain.cognize("write a haiku about rain", {
        mode: "manual",
        allowTools: false,
      });
      lightSamples.push(performance.now() - started);
      lightNotes = cognition.notes.join(" ");
    }
    expect(lightNotes).toMatch(/fabric: light/);
    expect(lightNotes).not.toMatch(/world state:/);
    expect(lightNotes).not.toMatch(/meta:/);

    const deepSamples: number[] = [];
    let deepNotes = "";
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      const cognition = await coreBrain.cognize("what is the latest ollama version", {
        mode: "manual",
        allowTools: false,
      });
      deepSamples.push(performance.now() - started);
      deepNotes = cognition.notes.join(" ");
    }
    expect(deepNotes).toMatch(/fabric: deep/);
    expect(deepNotes).toMatch(/world state:/);

    const helloSamples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const started = performance.now();
      baselineRespond("hello");
      helloSamples.push(performance.now() - started);
    }
    const helloMs = median(helloSamples);
    const lightMs = median(lightSamples);
    const deepMs = median(deepSamples);
    expect(helloMs).toBeLessThan(15);
    expect(lightMs).toBeLessThan(500);
    expect(lightMs).toBeLessThanOrEqual(deepMs + 25);
  });

  it("extends describeLiveSelf with live governance, memory, knowledge, and world signals", () => {
    const text = describeLiveSelf("what can you do");
    expect(text).toMatch(/Pending owner approvals/);
    expect(text).toMatch(/Known failure memories/);
    expect(text).toMatch(/Unresolved knowledge contradictions/);
    expect(text).toMatch(/Recent verified strategies/);
    expect(text).toMatch(/World state snapshot/);
    expect(text).toMatch(/capability matrix/i);
    expect(text).not.toMatch(/\bOpenAI\b|\bAnthropic\b|\bGemini\b/i);
  });
});
