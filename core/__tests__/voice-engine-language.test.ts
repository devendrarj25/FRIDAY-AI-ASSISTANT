import { describe, expect, it } from "vitest";
import {
  chunkForSpeech,
  dominantLang,
  MAX_SPANS,
  romanHindiRatio,
  segment,
} from "../../src/lib/friday/voice-engine/language-segmenter";

describe("language segmenter", () => {
  it("returns nothing for empty text", () => {
    expect(segment("  ")).toEqual([]);
  });

  it("keeps one script as one span", () => {
    expect(segment("मुझे आज का मौसम बताओ").map((s) => s.lang)).toEqual(["hi"]);
    expect(segment("Open the report and read it").map((s) => s.lang)).toEqual(["en"]);
  });

  it("never calls mixed Hindi and English unsupported and keeps the written order", () => {
    const text = "Please open Chrome now और फिर रिपोर्ट का सारांश बनाओ";
    const spans = segment(text);
    expect(spans.map((s) => s.lang)).toEqual(["en", "hi"]);
    expect(
      spans
        .map((s) => s.text)
        .join(" ")
        .split(/\s+/),
    ).toEqual(text.split(/\s+/));
  });

  it("does not make a lone English word its own request", () => {
    expect(segment("मेरी report का सारांश बनाओ")).toHaveLength(1);
    expect(segment("Friday मेरी बात सुनो").map((s) => s.lang)).toEqual(["hi"]);
  });

  it("bounds the span count and loses no text", () => {
    const text = Array.from({ length: 30 }, (_, i) =>
      i % 2 ? "one two काम करो" : "three four go now",
    ).join(" ");
    const spans = segment(text);
    expect(spans.length).toBeLessThanOrEqual(MAX_SPANS);
    expect(
      spans
        .map((s) => s.text)
        .join("")
        .replace(/\s/g, ""),
    ).toBe(text.replace(/\s/g, ""));
  });

  it("keeps digits and punctuation inside their span", () => {
    const spans = segment("आज 25 जनवरी है, call me at 5 pm");
    expect(spans.map((s) => s.lang)).toEqual(["hi", "en"]);
    expect(spans[0]?.text).toContain("25");
  });

  it("chooses the dominant language and the requested one for digits", () => {
    expect(dominantLang("open Chrome करो")).toBe("en");
    expect(dominantLang("क्रोम खोलो please")).toBe("hi");
    expect(dominantLang("2025", "hi-IN")).toBe("hi");
    expect(dominantLang("", "en-IN")).toBe("en");
  });

  it("scores Roman Hindi as a hint", () => {
    expect(romanHindiRatio("Aaj ka weather batao")).toBeGreaterThan(0.3);
    expect(romanHindiRatio("Open the file")).toBe(0);
    expect(romanHindiRatio("नमस्ते")).toBe(0);
  });
});

describe("speech chunker", () => {
  it("never makes one chunk per word", () => {
    const chunks = chunkForSpeech(
      "मैं आपकी मदद कर सकती हूँ। Let me check the report. फिर बताती हूँ।",
    );
    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(chunks.every((c) => c.text.split(/\s+/).length >= 3)).toBe(true);
  });

  it("keeps order and loses nothing", () => {
    const text = "पहला वाक्य यहाँ है। The second sentence is here. तीसरा वाक्य भी है।";
    expect(
      chunkForSpeech(text)
        .map((c) => c.text)
        .join(" "),
    ).toBe(text);
  });

  it("breaks a long sentence at a clause so the first audio starts early", () => {
    const text =
      "Dev, main tumhe is report ke baare mein bata rahi hoon, aur phir agle hisse par jaaungi jahan numbers hain";
    const chunks = chunkForSpeech(text);
    expect(chunks[0]?.text.endsWith(",")).toBe(true);
    expect(chunks.map((c) => c.text).join(" ")).toBe(text);
  });

  it("splits a very long run without a mark and respects the maximum", () => {
    const text = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkForSpeech(text, { maxChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 100)).toBe(true);
    expect(chunks.map((c) => c.text).join(" ")).toBe(text);
  });

  it("tags each chunk with its language and spans", () => {
    const [chunk] = chunkForSpeech("open Chrome करो");
    expect(chunk?.lang).toBe("en");
    expect(chunk?.spans.length).toBeGreaterThan(0);
  });
});

describe("splitLongSpeech", () => {
  it("leaves a short reply as one piece", async () => {
    const { splitLongSpeech } =
      await import("../../src/lib/friday/voice-engine/language-segmenter");
    expect(splitLongSpeech("Theek hai, kar diya.")).toEqual(["Theek hai, kar diya."]);
    expect(splitLongSpeech("   ")).toEqual([]);
  });

  it("speaks the end of a long reply instead of cutting it", async () => {
    const { splitLongSpeech } =
      await import("../../src/lib/friday/voice-engine/language-segmenter");
    const text = Array.from(
      { length: 40 },
      (_, i) => `Yeh vakya number ${i} hai aur poora sunna chahiye.`,
    ).join(" ");
    const parts = splitLongSpeech(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 400)).toBe(true);
    expect(parts.join(" ")).toBe(text);
  });
});
