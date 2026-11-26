import { describe, expect, it } from "vitest";
import {
  checkScriptPolicy,
  expectedLang,
  scriptViolationReport,
  summariseScriptChecks,
  VIOLATION_KINDS,
  type ViolationKind,
} from "../../src/lib/friday/voice-engine/script-policy";

const kinds = (text: string, lang: string): ViolationKind[] =>
  checkScriptPolicy(text, lang).violations.map((v) => v.kind);

describe("expectedLang", () => {
  it.each([
    ["hi", "hi"],
    ["hi-IN", "hi"],
    ["hi_IN", "hi"],
    ["hi-Latn", "hinglish"],
    ["hinglish", "hinglish"],
    ["mixed", "hinglish"],
    ["en", "en"],
    ["en-US", "en"],
    ["", "en"],
    [undefined, "en"],
    ["xx", "en"],
  ])("%s -> %s", (input, out) => {
    expect(expectedLang(input as string | undefined)).toBe(out);
  });
});

describe("checkScriptPolicy: clean text", () => {
  it.each([
    ["आज मौसम अच्छा है।", "hi"],
    ["Chrome खोलो और report भेजो", "hinglish"],
    ["Chrome खोलो और report भेजो", "hi"],
    ["What time is it?", "en"],
    ["Open the main file, do it to me", "en"],
    ["मुझे कल meeting में जाना है", "hi"],
    ["mujhe chai chahiye", "en"], // English speech: Latin is never a script violation
    ["", "hi"],
    ["   ", "en"],
    ["12345 ₹500 50%", "hi"],
    ["do main to me", "hinglish"], // words English shares are never called Roman Hindi
    ["कट मेल दिन", "hi"], // real Hindi words that the lexicon also pairs with an English look
    ["don't won't I'm", "en"],
  ])("%s (%s) has no violations", (text, lang) => {
    const check = checkScriptPolicy(text, lang);
    expect(check.violations, text).toEqual([]);
    expect(check.clean).toBe(true);
  });
});

describe("checkScriptPolicy: violations", () => {
  it("flags sure Roman Hindi in Hindi and Hinglish speech", () => {
    expect(kinds("mujhe kal chai chahiye", "hi")).toEqual(Array(4).fill("roman-hindi-in-latin"));
    const check = checkScriptPolicy("aaj mausam accha hai", "hinglish");
    expect(check.violations.map((v) => v.word)).toContain("aaj");
    expect(check.counts["roman-hindi-in-latin"]).toBeGreaterThan(0);
  });

  it("flags an English word written in Devanagari, ignoring nukta and chandrabindu spelling", () => {
    expect(kinds("कल मीटिंग है", "hi")).toEqual(["english-in-devanagari"]);
    expect(kinds("मुझे रिपोर्ट भेजो", "hinglish")).toEqual(["english-in-devanagari"]);
    expect(kinds("फाइल खोलो", "hi")).toEqual(["english-in-devanagari"]); // without the nukta
    expect(kinds("फ़ाइल खोलो", "hi")).toEqual(["english-in-devanagari"]); // with it
  });

  it("flags any Devanagari in English speech", () => {
    expect(kinds("open the फाइल now", "en")).toEqual(["devanagari-in-english"]);
    expect(kinds("नमस्ते friday", "en-US")).toEqual(["devanagari-in-english"]);
  });

  it("flags a word with both scripts once, and not its parts", () => {
    const check = checkScriptPolicy("meetingको खोलो", "hinglish");
    expect(check.violations).toEqual([{ kind: "mixed-script-word", word: "meetingको", index: 1 }]);
    expect(check.words).toBe(2);
  });

  it("reports the word position (1-based) and the offending word", () => {
    const check = checkScriptPolicy("आज मीटिंग है", "hi");
    expect(check.violations).toEqual([{ kind: "english-in-devanagari", word: "मीटिंग", index: 2 }]);
  });

  it("a Roman Hindi word with an apostrophe suffix is still recognised; English apostrophes are not", () => {
    expect(kinds("aaj’s plan", "hinglish")).toEqual(["roman-hindi-in-latin"]);
    expect(kinds("it's the plan", "hinglish")).toEqual([]);
  });

  it("is case-blind for Latin words", () => {
    expect(kinds("AAJ Kal", "hi")).toEqual(["roman-hindi-in-latin", "roman-hindi-in-latin"]);
  });

  it("never rewrites or throws on odd input", () => {
    expect(() => checkScriptPolicy(undefined as unknown as string, "hi")).not.toThrow();
    expect(checkScriptPolicy("x".repeat(100_000), "hi").words).toBe(1);
    expect(checkScriptPolicy("😀 ।।", "hi").words).toBe(0);
  });
});

describe("summaries for the bench", () => {
  it("totals samples, words, violations and the rate per kind", () => {
    const report = scriptViolationReport([
      { expected: "hi", text: "आज मौसम अच्छा है" },
      { expected: "hi", text: "कल मीटिंग है" },
      { expected: "en", text: "open the फाइल" },
      { expected: "hinglish", text: "aaj meeting hai" },
    ]);
    expect(report.samples).toBe(4);
    expect(report.violating).toBe(3);
    expect(report.counts["english-in-devanagari"]).toBe(1);
    expect(report.counts["devanagari-in-english"]).toBe(1);
    expect(report.counts["roman-hindi-in-latin"]).toBe(2); // "aaj" and "hai"; "meeting" stays Latin
    expect(report.violations).toBe(4);
  });

  it("counts exactly: one of each kind", () => {
    const checks = [
      checkScriptPolicy("कल मीटिंग है", "hi"),
      checkScriptPolicy("open फाइल", "en"),
      checkScriptPolicy("mujhe kal", "hi"),
      checkScriptPolicy("meetingको", "hi"),
    ];
    const total = summariseScriptChecks(checks);
    expect(total.counts).toEqual({
      "roman-hindi-in-latin": 2,
      "english-in-devanagari": 1,
      "devanagari-in-english": 1,
      "mixed-script-word": 1,
    });
    expect(total.violations).toBe(5);
    expect(total.samples).toBe(4);
    expect(total.violating).toBe(4);
    expect(total.words).toBe(3 + 2 + 2 + 1);
    expect(total.rate).toBeCloseTo(5 / 8, 10);
    expect(VIOLATION_KINDS).toHaveLength(4);
  });

  it("an empty bench is all zeros", () => {
    const total = summariseScriptChecks([]);
    expect(total).toEqual({
      samples: 0,
      violating: 0,
      words: 0,
      violations: 0,
      rate: 0,
      counts: {
        "roman-hindi-in-latin": 0,
        "english-in-devanagari": 0,
        "devanagari-in-english": 0,
        "mixed-script-word": 0,
      },
    });
  });
});
