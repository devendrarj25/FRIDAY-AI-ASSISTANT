import { describe, expect, it } from "vitest";
import {
  enforceIdentity,
  leaksForeignIdentity,
  reconcile,
  similarity,
} from "../../src/lib/friday/brain/reconciler";

describe("FRIDAY multi-model reconciliation", () => {
  it("keeps FRIDAY as the only identity in an answer", () => {
    const scrubbed = enforceIdentity(
      "I am ChatGPT, a large language model trained by OpenAI. The disk is 82% full.",
    );
    expect(scrubbed).not.toMatch(/chatgpt|openai/i);
    expect(scrubbed).toContain("The disk is 82% full.");
    expect(leaksForeignIdentity(scrubbed)).toBe(false);
  });

  it("leaves a normal FRIDAY answer untouched", () => {
    const text = "Disk C is 82% full. I can clear the temp folder if you want.";
    expect(enforceIdentity(text)).toBe(text);
  });

  it("reports honestly when no engine answered", () => {
    const result = reconcile([{ modelId: "a", text: "", ok: false, error: "model offline" }]);
    expect(result.winner).toBeNull();
    expect(result.answer).toBe("");
    expect(result.detail).toMatch(/model offline/);
  });

  it("passes a single engine answer straight through", () => {
    const result = reconcile([{ modelId: "solo", text: "Ollama is running locally.", ok: true }]);
    expect(result.winner).toBe("solo");
    expect(result.answer).toBe("Ollama is running locally.");
    expect(result.conflicts).toHaveLength(0);
  });

  it("prefers the answer the brain verified highest", () => {
    const result = reconcile(
      [
        { modelId: "weak", text: "Not sure about that.", ok: true },
        {
          modelId: "strong",
          text: "Node 22.14 is installed and Python 3.12.10 is on PATH.",
          ok: true,
        },
      ],
      { scores: { weak: 0.2, strong: 0.95 } },
    );
    expect(result.winner).toBe("strong");
    expect(result.runnersUp).toEqual(["weak"]);
  });

  it("never lets a failed engine win", () => {
    const result = reconcile([
      { modelId: "dead", text: "", ok: false, error: "timeout" },
      { modelId: "live", text: "The build finished in 41 seconds.", ok: true },
    ]);
    expect(result.winner).toBe("live");
  });

  it("detects factual disagreement between engines", () => {
    const result = reconcile([
      { modelId: "a", text: "The build took 41 s and produced 3 warnings.", ok: true },
      { modelId: "b", text: "The build took 88 s and produced 9 warnings.", ok: true },
    ]);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts.join(" ")).toMatch(/disagree/);
  });

  it("penalises an answer that speaks as another assistant", () => {
    const result = reconcile([
      { modelId: "leaky", text: "I am Claude, made by Anthropic. The answer is 12.", ok: true },
      { modelId: "clean", text: "The answer is 12.", ok: true },
    ]);
    expect(result.winner).toBe("clean");
    expect(leaksForeignIdentity(result.answer)).toBe(false);
  });

  it("measures agreement between answers", () => {
    expect(similarity("the ollama service is running", "ollama service running")).toBeGreaterThan(
      0.5,
    );
    expect(similarity("disk usage report", "weather in Jaipur")).toBe(0);
  });
});
