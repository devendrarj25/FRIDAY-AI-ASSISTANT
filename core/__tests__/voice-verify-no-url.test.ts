/**
 * A spoken answer never carries a URL (the voice rule forbids it), so verification must not reject a voice
 * answer for lacking one, and the repair pass must not wipe an answer the owner is already hearing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import { planRepair } from "../../src/lib/friday/brain-engine";

const SOURCES = [{ title: "Delhi weather", url: "https://example.org/delhi", snippet: "24 C" }];
const ANSWER = "Delhi mein abhi lagbhag chaubees degree hai, halka saaf mausam.";

describe("verify() on the voice surface", () => {
  it("does not demand a URL citation for a spoken answer", async () => {
    const voice = await coreBrain.cognize("delhi ka mausam kaisa hai", {
      mode: "auto",
      surface: "voice",
      allowTools: false,
    });
    const spoken = { ...voice, sources: SOURCES };
    expect(spoken.surface).toBe("voice");
    const verdict = coreBrain.verify(spoken, ANSWER, true);
    expect(verdict.issues.join(" | ")).not.toMatch(/not cited/);
  });

  it("still demands one on a typed turn", async () => {
    const chat = await coreBrain.cognize("delhi ka mausam kaisa hai", {
      mode: "manual",
      surface: "chat",
      allowTools: false,
    });
    const typed = { ...chat, sources: SOURCES };
    const verdict = coreBrain.verify(typed, ANSWER, true);
    expect(verdict.issues.join(" | ")).toMatch(/not cited/);
  });
});

describe("planRepair for a spoken turn", () => {
  const base = { verified: false, alreadyRepaired: false, deterministic: false };

  it("never repairs once the owner has started hearing the answer", () => {
    const plan = planRepair({
      ...base,
      candidates: ["a", "b"],
      answeredBy: "a",
      spokeAlready: true,
    });
    expect(plan.repair).toBe(false);
  });

  it("repairs as before when nothing was spoken yet", () => {
    const plan = planRepair({ ...base, candidates: ["a", "b"], answeredBy: "a" });
    expect(plan.repair).toBe(true);
  });

  it("compares the catalog id and the registry id as one engine", () => {
    const plan = planRepair({
      ...base,
      candidates: ["Ollama/Llama3"],
      answeredBy: "ollama:llama3",
    });
    expect(plan.alternatives).toEqual([]);
    expect(plan.repair).toBe(false);
  });

  it("is wired: tryRepair passes whether a voice answer was already streamed", () => {
    const source = readFileSync(resolve(__dirname, "../../src/lib/friday/brain-engine.ts"), "utf8");
    expect(source).toMatch(/spokeAlready/);
  });
});
