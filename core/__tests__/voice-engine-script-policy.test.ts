/** Transcript script policy: the TypeScript policy matches the shared Hinglish fixtures (the Python test reads the same file). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  endsInOpenDot,
  scriptPolicy,
  splitSentences,
} from "../../src/lib/friday/voice-engine/language-segmenter";

type Fixture = {
  requested: string;
  cases: Array<{ input: string; expected: unknown }>;
  sentences: Array<{ input: string; expected: string[] }>;
  openDot: Array<{ input: string; expected: boolean }>;
};
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/voice-hinglish-script.json"), "utf8"),
) as Fixture;

describe("script policy", () => {
  it("covers at least 40 Hinglish fixtures", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
  });

  it("matches the shared fixture for every sentence", () => {
    for (const c of fixture.cases) {
      expect(scriptPolicy(c.input, fixture.requested), c.input).toEqual(c.expected);
    }
  });

  it("keeps the text as spoken and tags Hindi, English and mixed", () => {
    const mixed = scriptPolicy("Chrome खोलो और report भेजो");
    expect(mixed.text).toBe("Chrome खोलो और report भेजो");
    expect(mixed.lang).toBe("mixed");
    expect(scriptPolicy("आज मौसम अच्छा है।").lang).toBe("hi");
    expect(scriptPolicy("What time is it?").lang).toBe("en");
  });

  it("reports Roman Hindi and never rewrites it into Devanagari", () => {
    const p = scriptPolicy("mujhe chai chahiye");
    expect(p.romanHindi).toBe(true);
    expect(p.segments[0]?.script).toBe("roman-hindi");
    expect(p.text).toBe("mujhe chai chahiye");
    expect(/[ऀ-ॿ]/.test(JSON.stringify(p))).toBe(false);
  });

  it("does not call ordinary English Roman Hindi", () => {
    expect(scriptPolicy("The main thing is to do it").romanHindi).toBe(false);
  });

  it("keeps apostrophes, numbers and Devanagari digits whole, and empty text empty", () => {
    expect(scriptPolicy("don't go").segments[0]?.words.map((w) => w.text)).toEqual(["don't", "go"]);
    expect(scriptPolicy("मुझे ३ बजे").segments[0]?.words.map((w) => w.kind)).toEqual([
      "hi",
      "number",
      "hi",
    ]);
    expect(scriptPolicy("   ").segments).toEqual([]);
    expect(scriptPolicy("", "hi-IN").lang).toBe("hi");
  });
});

describe("sentence cuts (shared with the Python mirror)", () => {
  it("covers a spread of abbreviations, initials, times, URLs, decimals and lists", () => {
    expect(fixture.sentences.length).toBeGreaterThanOrEqual(20);
    expect(fixture.openDot.length).toBeGreaterThanOrEqual(12);
  });

  it("splitSentences matches the shared fixture", () => {
    for (const c of fixture.sentences) expect(splitSentences(c.input), c.input).toEqual(c.expected);
  });

  it("endsInOpenDot matches the shared fixture", () => {
    for (const c of fixture.openDot) expect(endsInOpenDot(c.input), c.input).toBe(c.expected);
  });

  it("the transcript policy never cuts a sentence inside a name, an amount or a time", () => {
    const p = scriptPolicy("Please ask Dr. Singh about it. Pay Rs. 500 at 5 p.m. today. Done.");
    expect(p.segments.map((s) => s.text)).toEqual([
      "Please ask Dr. Singh about it.",
      "Pay Rs. 500 at 5 p.m. today.",
      "Done.",
    ]);
    expect(scriptPolicy("डॉ. शर्मा आए। वे बैठे।").segments).toHaveLength(2);
    expect(scriptPolicy("First point.\nSecond point.").segments).toHaveLength(2);
  });

  it("is linear: a long run of abbreviations stays fast", () => {
    const text = "Dr. A. K. Singh met Mr. Rao, e.g. at 5 p.m. etc. ".repeat(4000);
    const started = performance.now();
    splitSentences(text);
    scriptPolicy(text.slice(0, 20000));
    expect(performance.now() - started).toBeLessThan(800);
  });
});
