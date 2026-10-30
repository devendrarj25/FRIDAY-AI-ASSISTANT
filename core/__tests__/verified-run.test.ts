/** The loop checks, fixes with the same model, then moves up, and says honestly when nothing passed. */
import { describe, expect, it } from "vitest";
import { retryPrompt, runVerified, type Rung } from "../../src/lib/friday/brain/verified-run";

const small: Rung = { id: "small", label: "small local", modelIds: ["local"] };
const big: Rung = { id: "big", label: "large cloud", modelIds: ["cloud"] };
const PROMPT = "Explain tides in at most 5 words, in lowercase";

describe("runVerified", () => {
  it("accepts a good first answer after one call", async () => {
    let calls = 0;
    const out = await runVerified({
      prompt: PROMPT,
      rungs: [small, big],
      ask: async () => {
        calls += 1;
        return "moon pulls the sea";
      },
    });
    expect(out).toMatchObject({ verified: true, rung: "small", escalated: false });
    expect(calls).toBe(1);
    expect(out.checked).toEqual(expect.arrayContaining(["max-words", "lowercase"]));
  });

  it("fixes a miss with the same model, using exactly what failed", async () => {
    const seen: string[] = [];
    const out = await runVerified({
      prompt: PROMPT,
      rungs: [small, big],
      ask: async (prompt) => {
        seen.push(prompt);
        return prompt.includes("did not meet") ? "moon pulls the sea" : "The Moon Pulls The Sea Up";
      },
    });
    expect(out).toMatchObject({ verified: true, rung: "small", escalated: false });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("at most 5 words");
    expect(seen[1]).toContain("lowercase");
    expect(seen[1]).toContain("The Moon Pulls The Sea Up");
  });

  it("moves to the next rung when the first cannot meet the ask", async () => {
    const used: string[] = [];
    const out = await runVerified({
      prompt: PROMPT,
      rungs: [small, big],
      ask: async (_prompt, rung) => {
        used.push(rung.id);
        return rung.id === "small" ? "Tides Happen Because The Moon" : "moon pulls the sea";
      },
    });
    expect(out).toMatchObject({ verified: true, rung: "big", escalated: true });
    expect(used).toEqual(["small", "small", "big"]);
    expect(out.attempts.map((a) => a.rung)).toEqual(["small", "small", "big"]);
  });

  it("goes to the next rung when one errors, without asking the failed one again", async () => {
    const used: string[] = [];
    const out = await runVerified({
      prompt: PROMPT,
      rungs: [small, big],
      ask: async (_prompt, rung) => {
        used.push(rung.id);
        if (rung.id === "small") throw new Error("model offline");
        return "moon pulls the sea";
      },
    });
    expect(used).toEqual(["small", "big"]);
    expect(out.verified).toBe(true);
    expect(out.attempts[0]?.error).toBe("model offline");
  });

  it("returns the closest answer and says it did not pass", async () => {
    const out = await runVerified({
      prompt: PROMPT,
      rungs: [small, big],
      retriesPerRung: 0,
      ask: async (_prompt, rung) =>
        rung.id === "small" ? "The Moon Pulls The Sea Up High" : "moon pulls the sea up high today",
    });
    expect(out.verified).toBe(false);
    expect(out.answer).toBe("moon pulls the sea up high today"); // one failure beats two
    expect(out.note).toContain("still failing");
    expect(out.note).toContain("at most 5 words");
  });

  it("asks once when nothing in the ask can be checked", async () => {
    let calls = 0;
    const out = await runVerified({
      prompt: "tell me about tides",
      rungs: [small, big],
      ask: async () => {
        calls += 1;
        return "Anything at all";
      },
    });
    expect(calls).toBe(1);
    expect(out).toMatchObject({ verified: false, checked: [], escalated: false });
    expect(out.note).toContain("nothing in the ask could be checked");
  });

  it("says no model answered when every rung errors", async () => {
    const out = await runVerified({
      prompt: PROMPT,
      rungs: [small, big],
      ask: async () => {
        throw new Error("offline");
      },
    });
    expect(out).toMatchObject({
      answer: "",
      rung: null,
      verified: false,
      note: "no model answered",
    });
    expect(out.attempts).toHaveLength(2);
  });

  it("uses a default rung when none is given", async () => {
    const out = await runVerified({ prompt: PROMPT, rungs: [], ask: async () => "moon pulls sea" });
    expect(out.rung).toBe("default");
  });

  it("keeps the retry prompt short and focused", () => {
    const text = retryPrompt("p", "x".repeat(5000), [{ id: "a", message: "Fix a." }]);
    expect(text.length).toBeLessThan(1800);
    expect(text).toContain("- Fix a.");
  });
});
