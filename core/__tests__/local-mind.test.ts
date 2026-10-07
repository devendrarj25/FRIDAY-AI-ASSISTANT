import { describe, expect, it } from "vitest";

import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import {
  boundLines,
  commitLocalAnswer,
  consultLocalMind,
  distillLocalAnswer,
  localMindGrowth,
  packHistory,
  resetLocalMind,
} from "../../src/lib/friday/brain/local-mind";

const PROMPT = "how does friday pack a cognitive context packet for a turn";
const ANSWER =
  "FRIDAY keeps the full chat on this PC and sends the model only the ranked lines this turn needs.";

describe("local mind", () => {
  it("learns a stable answer once and then leaves the model idle", () => {
    resetLocalMind();
    const taught = distillLocalAnswer({
      prompt: PROMPT,
      answer: ANSWER,
      now: 1_700_000_000_000,
    });
    expect(taught.stored).toBe(true);
    expect(taught.card?.teacher).toBe("model");
    expect(taught.card?.appliedToPolicy).toBe(false);

    const again = distillLocalAnswer({
      prompt: PROMPT,
      answer: ANSWER,
      now: 1_700_000_000_000,
    });
    expect(again.stored).toBe(false);
    expect(again.reinforced).toBe(true);

    const hit = consultLocalMind({ prompt: PROMPT });
    expect(hit.skipModel).toBe(true);
    expect(hit.reply).toBe(ANSWER);
    expect(hit.appliedToPolicy).toBe(false);
    commitLocalAnswer(hit.cardId || "", 1200);
    const growth = localMindGrowth();
    expect(growth.localAnswers).toBe(1);
    expect(growth.charsKeptOffModel).toBe(1200);
    expect(growth.cards).toBe(1);
  });

  it("refuses to reuse live, private, creative, or machine-changing answers", () => {
    resetLocalMind();
    expect(
      distillLocalAnswer({
        prompt: "what is the latest ollama version number today",
        answer: ANSWER,
        blocked: true,
      }).stored,
    ).toBe(false);
    expect(
      distillLocalAnswer({
        prompt: "the kernel pack uses a local card",
        answer: "my password is swordfish and it stays on this machine always",
        sensitive: true,
      }).stored,
    ).toBe(false);

    distillLocalAnswer({ prompt: PROMPT, answer: ANSWER, now: 1_700_000_000_000 });
    const risky = consultLocalMind({
      prompt: "delete the project files and pack a cognitive context packet",
      blocked: true,
    });
    expect(risky.skipModel).toBe(false);
    expect(risky.reply).toBeNull();

    const other = consultLocalMind({
      prompt: "what color is the kitchen window frame in the hall",
    });
    expect(other.skipModel).toBe(false);
    expect(other.reason).toMatch(/do not cover/);
  });

  it("keeps older turns on this PC and bounds the lines a model receives", () => {
    const filler = "a".repeat(100);
    const packed = packHistory([
      { role: "user", text: `${filler} ALPHAUNIQUE` },
      { role: "friday", text: filler },
      { role: "user", text: "third line of the chat" },
      { role: "friday", text: "fourth line of the chat" },
      { role: "user", text: "fifth stays" },
      { role: "friday", text: "sixth stays" },
    ]);
    expect(packed.omittedChars).toBeGreaterThan(0);
    expect(packed.packet).toContain("fifth stays");
    expect(packed.packet).not.toContain("ALPHAUNIQUE");

    const bounded = boundLines(["keep this line", "drop this very long extra line"], 20);
    expect(bounded.lines).toEqual(["keep this line"]);
    expect(bounded.omittedChars).toBeGreaterThan(0);
  });

  it("answers the second cognize from the card after a verified model lesson", async () => {
    resetLocalMind();
    const first = await coreBrain.cognize(PROMPT, { mode: "manual", allowTools: false });
    expect(first.localMind?.skipModel).toBe(false);
    expect(first.notes.join(" ")).toMatch(/local mind:/);

    const verification = coreBrain.reflect({
      cognition: first,
      answer: ANSWER,
      ok: true,
      ms: 5,
      learn: true,
    });
    expect(verification.ok).toBe(true);

    const second = await coreBrain.cognize(PROMPT, { mode: "manual", allowTools: false });
    expect(second.localMind?.skipModel).toBe(true);
    expect(second.localMind?.reply).toContain("ranked lines");
    expect(second.localMind?.appliedToPolicy).toBe(false);
    expect(second.routing).toMatch(/model stayed idle/);
    expect(second.notes.join(" ")).toMatch(/model stays idle/);
    expect(localMindGrowth().localAnswers).toBe(1);
  });
});
