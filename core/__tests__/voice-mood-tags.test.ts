import { describe, expect, it } from "vitest";
import type { Feeling, FeelingLabel } from "../../src/lib/friday/brain/affect";
import {
  applyMoodTag,
  isDeliveryTag,
  moodToDeliveryTag,
  newMoodTagState,
  type DeliveryOrigin,
} from "../../src/lib/friday/voice-engine/delivery-tags";

const LABELS: FeelingLabel[] = [
  "neutral",
  "anger",
  "anxiety",
  "sadness",
  "excitement",
  "gratitude",
  "confusion",
  "hurry",
  "distress",
  "sarcasm",
  "tiredness",
  "overwhelm",
  "disappointment",
  "relief",
];
const feel = (label: FeelingLabel, over: Partial<Feeling> = {}): Feeling => ({
  label,
  valence: 0,
  arousal: 0.5,
  intensity: 0.8,
  confidence: 0.9,
  ...over,
});
const own: DeliveryOrigin = { author: "assistant", voiceMode: true };

describe("mood to delivery tag", () => {
  it("maps every label to null or an allow-listed word", () => {
    for (const label of LABELS) {
      const tag = moodToDeliveryTag(feel(label));
      if (tag !== null) expect(isDeliveryTag(`[${tag}]`)).toBe(true);
    }
    expect(moodToDeliveryTag(feel("anger"))).toBe("calm");
    expect(moodToDeliveryTag(feel("sadness"))).toBe("soft");
    expect(moodToDeliveryTag(feel("hurry"))).toBe("fast");
    expect(moodToDeliveryTag(feel("confusion"))).toBe("slow");
    expect(moodToDeliveryTag(feel("excitement"))).toBe("excited");
    expect(moodToDeliveryTag(feel("relief"))).toBe("warm");
    expect(moodToDeliveryTag(feel("neutral"))).toBeNull();
    expect(moodToDeliveryTag(feel("sarcasm"))).toBeNull();
  });
  it("needs confidence 0.60 and intensity 0.40", () => {
    expect(moodToDeliveryTag(feel("anger", { confidence: 0.59 }))).toBeNull();
    expect(moodToDeliveryTag(feel("anger", { intensity: 0.39 }))).toBeNull();
    expect(moodToDeliveryTag(feel("anger", { confidence: 0.6, intensity: 0.4 }))).toBe("calm");
  });
});

describe("apply mood tag", () => {
  it("tags the first sentence of FRIDAY's own voice reply", () => {
    expect(applyMoodTag("Sure. Done.", "calm", own)).toBe("[calm] Sure. Done.");
  });
  it("adds nothing for web, tool, file, user or text mode and strips their tags", () => {
    for (const author of ["web", "tool", "file", "user", "other"] as const) {
      expect(applyMoodTag("[warm] Hello there.", "calm", { author, voiceMode: true })).toBe(
        "Hello there.",
      );
    }
    expect(applyMoodTag("[warm] Hi.", "calm", { author: "assistant", voiceMode: false })).toBe(
      "Hi.",
    );
  });
  it("adds nothing at a code fence or URL start, or when the sentence already has a tag", () => {
    expect(applyMoodTag("```js\nx\n```", "calm", own)).toBe("```js\nx\n```");
    expect(applyMoodTag("https://a.example/x is up.", "calm", own)).toBe(
      "https://a.example/x is up.",
    );
    expect(applyMoodTag("[soft] Okay.", "calm", own)).toBe("[soft] Okay.");
    expect(applyMoodTag("Okay.", null, own)).toBe("Okay.");
  });
  it("never uses the same tag on a third reply in a row", () => {
    const state = newMoodTagState();
    expect(applyMoodTag("One.", "soft", own, state)).toBe("[soft] One.");
    expect(applyMoodTag("Two.", "soft", own, state)).toBe("[soft] Two.");
    expect(applyMoodTag("Three.", "soft", own, state)).toBe("Three.");
    expect(applyMoodTag("Four.", "soft", own, state)).toBe("[soft] Four.");
  });
});
