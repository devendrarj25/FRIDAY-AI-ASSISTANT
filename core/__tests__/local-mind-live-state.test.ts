/**
 * A saved answer is never reused for a question about now, this machine or the owner's own state, nor learned
 * from a turn that read a tool, skill, connector or system context. Cards expire, Devanagari asks can match, and
 * Hinglish live-fact asks reach the web path.
 */
import { describe, expect, it } from "vitest";
import type { BrainToolUse } from "../../src/lib/friday/brain/core-brain";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import {
  consultLocalMind,
  distillLocalAnswer,
  localMindGrowth,
  resetLocalMind,
  LOCAL_CARD_TTL_MS,
} from "../../src/lib/friday/brain/local-mind";
import { looksLikeLiveFact, looksLikeLiveState } from "../../src/lib/friday/brain/research";

const T0 = 1_700_000_000_000;
const LONG_ANSWER =
  "Aapki battery abhi lagbhag pachaas pratishat hai aur charger laga hua nahi hai, isliye jaldi charge kar lijiye.";

describe("looksLikeLiveState", () => {
  it.each([
    "abhi mere laptop ki battery kitni bachi hai",
    "mera schedule kya hai aaj",
    "kaun kaun si apps khuli hain",
    "what is on my calendar tomorrow",
    "how much storage is free right now",
    "what time is it",
    "मेरा शेड्यूल क्या है आज",
    "अभी बैटरी कितनी बची है",
    "kitne baje meeting hai",
  ])("flags %s", (ask) => expect(looksLikeLiveState(ask)).toBe(true));

  it.each([
    "how does friday pack a cognitive context packet for a turn",
    "photosynthesis kya hota hai simple words mein samjhao",
    "explain how a hash map handles collisions",
  ])("leaves %s alone", (ask) => expect(looksLikeLiveState(ask)).toBe(false));
});

describe("LIVE_FACT carries Hinglish and Devanagari", () => {
  it.each([
    "delhi ka mausam kaisa hai",
    "aaj ki khabar batao",
    "sone ka bhav kya hai",
    "आज का मौसम कैसा है",
  ])("treats %s as a live fact", (ask) => expect(looksLikeLiveFact(ask)).toBe(true));
  it("still reads a plain concept ask as stable", () => {
    expect(looksLikeLiveFact("explain how a hash map handles collisions")).toBe(false);
  });
});

describe("a saved answer expires and reads Unicode", () => {
  it("is not reused after its time to live, and is before it", () => {
    resetLocalMind();
    const prompt = "how does friday pack a cognitive context packet for a turn";
    distillLocalAnswer({ prompt, answer: LONG_ANSWER, now: T0 });
    expect(consultLocalMind({ prompt, now: T0 + LOCAL_CARD_TTL_MS - 1 }).skipModel).toBe(true);
    const late = consultLocalMind({ prompt, now: T0 + LOCAL_CARD_TTL_MS + 1 });
    expect(late.skipModel).toBe(false);
    expect(late.reason).toMatch(/expired|old/i);
    // Reinforcing the lesson starts the clock again.
    distillLocalAnswer({ prompt, answer: LONG_ANSWER, now: T0 + LOCAL_CARD_TTL_MS });
    expect(consultLocalMind({ prompt, now: T0 + LOCAL_CARD_TTL_MS + 1 }).skipModel).toBe(true);
  });

  it("matches a Devanagari ask to its own card", () => {
    resetLocalMind();
    const prompt = "प्रकाश संश्लेषण क्या होता है आसान शब्दों में समझाओ";
    const answer = "पौधे सूरज की रोशनी, पानी और कार्बन डाइऑक्साइड से अपना भोजन और ऑक्सीजन बनाते हैं।";
    expect(distillLocalAnswer({ prompt, answer, now: T0 }).stored).toBe(true);
    expect(consultLocalMind({ prompt, now: T0 }).skipModel).toBe(true);
    expect(consultLocalMind({ prompt: "ऑक्सीजन कैसे बनती है", now: T0 }).skipModel).toBe(false);
  });
});

describe("learning from a finished turn", () => {
  it("learns nothing from a live-state ask or a turn that read a tool, and still learns a stable one", async () => {
    resetLocalMind();
    const live = await coreBrain.cognize("abhi mere laptop ki battery kitni bachi hai", {
      mode: "manual",
      allowTools: false,
    });
    coreBrain.reflect({ cognition: live, answer: LONG_ANSWER, ok: true });
    expect(localMindGrowth().cards).toBe(0);

    const stable = await coreBrain.cognize("explain how a hash map handles collisions in detail", {
      mode: "manual",
      allowTools: false,
    });
    const ran: BrainToolUse = { tool: "tool", query: "disk-usage", ok: true, detail: "ran" };
    const usedTool = { ...stable, tools: [ran] };
    coreBrain.reflect({
      cognition: usedTool,
      answer:
        "A hash map resolves collisions by chaining entries in a bucket or by probing for the next free slot.",
      ok: true,
    });
    expect(localMindGrowth().cards).toBe(0);

    coreBrain.reflect({
      cognition: stable,
      answer:
        "A hash map resolves collisions by chaining entries in a bucket or by probing for the next free slot.",
      ok: true,
    });
    expect(localMindGrowth().cards).toBe(1);
  });
});
