import { describe, expect, it } from "vitest";
import {
  applyPronunciations,
  englishNumber,
  hindiNumber,
  prepareForSpeech,
  spellNumbers,
  stripMarkup,
} from "../../src/lib/friday/voice-engine/text-normalizer";

describe("number words", () => {
  it.each([
    [0, "zero"],
    [7, "seven"],
    [21, "twenty one"],
    [100, "one hundred"],
    [250, "two hundred fifty"],
    [1000, "one thousand"],
    [150000, "one lakh fifty thousand"],
    [2500000, "twenty five lakh"],
    [10000000, "one crore"],
    [123456789, "twelve crore thirty four lakh fifty six thousand seven hundred eighty nine"],
  ])("English %i", (n, words) => expect(englishNumber(n)).toBe(words));

  it.each([
    [0, "शून्य"],
    [5, "पाँच"],
    [25, "पच्चीस"],
    [99, "निन्यानवे"],
    [100, "एक सौ"],
    [350, "तीन सौ पचास"],
    [1000, "एक हज़ार"],
    [150000, "एक लाख पचास हज़ार"],
    [10000000, "एक करोड़"],
  ])("Hindi %i", (n, words) => expect(hindiNumber(n)).toBe(words));

  it("keeps digits it cannot say and rejects bad input", () => {
    expect(englishNumber(1e9)).toBe("1000000000");
    expect(englishNumber(-3)).toBe("-3");
    expect(hindiNumber(2.5)).toBe("2.5");
  });

  it("has a Hindi word for every number up to 99", () => {
    const words = Array.from({ length: 100 }, (_, i) => hindiNumber(i));
    expect(new Set(words).size).toBe(100);
    expect(words.every((w) => /^[ऀ-ॿ]+$/.test(w))).toBe(true);
  });
});

describe("spellNumbers", () => {
  it("says money, with Indian grouping, in each language", () => {
    expect(spellNumbers("₹1,50,000", "en")).toBe("one lakh fifty thousand rupees");
    expect(spellNumbers("Rs. 500", "en")).toBe("five hundred rupees");
    expect(spellNumbers("₹250", "hi")).toBe("दो सौ पचास रुपये");
    expect(spellNumbers("2500 INR", "en")).toBe("two thousand five hundred rupees");
  });

  it("says dates day first, times, percentages and decimals", () => {
    expect(spellNumbers("25/01/2026", "en")).toBe("twenty five January two thousand twenty six");
    expect(spellNumbers("25/01/2026", "hi")).toBe("पच्चीस जनवरी दो हज़ार छब्बीस");
    expect(spellNumbers("at 5:30 pm", "en")).toBe("at five thirty P M");
    expect(spellNumbers("at 7:00", "en")).toBe("at seven o'clock");
    expect(spellNumbers("18%", "en")).toBe("eighteen percent");
    expect(spellNumbers("3.14", "en")).toBe("three point one four");
    expect(spellNumbers("3.5", "hi")).toBe("तीन दशमलव पाँच");
  });

  it("leaves an overlong digit string alone", () => {
    expect(spellNumbers("1234567890123", "en")).toBe("1234567890123");
  });
});

describe("pronunciation dictionary", () => {
  it("replaces whole words only, longest first, and lets the owner win", () => {
    expect(applyPronunciations("Send the PDF to FRIDAY, OK?")).toBe(
      "Send the P D F to Friday, okay?",
    );
    expect(applyPronunciations("PDFs and OKAY stay")).toBe("PDFs and OKAY stay");
    expect(applyPronunciations("Meet Devendra", { Devendra: "Devendra Singh" })).toBe(
      "Meet Devendra Singh",
    );
    expect(applyPronunciations("GST", { GST: "jee es tee" })).toBe("jee es tee");
    expect(applyPronunciations("a.b", { "a.b": "ay dot bee" })).toBe("ay dot bee");
  });
});

describe("markup", () => {
  it("removes markdown, code, links and emoji but keeps the words", () => {
    const text =
      "## Result\n- **Total**: `42`\n[docs](https://x.y/z) 🎉 https://example.com/a\n```\nrm -rf /\n```";
    const out = stripMarkup(text);
    expect(out).not.toMatch(/[#*`[\]]|rm -rf|https/u);
    expect(out).not.toContain("🎉");
    expect(out).toContain("Result");
    expect(out).toContain("Total");
    expect(out).toContain("docs");
    expect(out).toContain("a link");
  });
});

describe("prepareForSpeech", () => {
  it("reads a mixed Hindi and English reply with numbers in the right language", () => {
    const out = prepareForSpeech("आपका बिल ₹1,200 है। Please pay by 25/01/2026.");
    expect(out).toContain("एक हज़ार दो सौ रुपये");
    expect(out).toContain("twenty five January two thousand twenty six");
    expect(out).not.toMatch(/\d/);
  });

  it("turns a list into separate sentences and keeps the order", () => {
    const out = prepareForSpeech("Steps:\n- open the file\n- read the PDF");
    expect(out).toBe("Steps: open the file. read the P D F.");
  });

  it("returns an empty string for markup-only text", () => {
    expect(prepareForSpeech("```\ncode only\n```")).toBe("");
  });
});

import { sanitizePronunciations } from "../../src/lib/friday/voice-engine/text-normalizer";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";
import { readFileSync } from "node:fs";

describe("pronunciation entries", () => {
  it("keeps short pairs and drops empty, identical, oversized and non-string entries", () => {
    expect(
      sanitizePronunciations({
        Devendra: "Dev-endra",
        "": "x",
        same: "same",
        long: "x".repeat(81),
        n: 5,
        ok: " okay ",
      }),
    ).toEqual({ Devendra: "Dev-endra", ok: "okay" });
    expect(sanitizePronunciations(null)).toEqual({});
    expect(sanitizePronunciations(["a"])).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`w${i}`, `v${i}`]));
    expect(Object.keys(sanitizePronunciations(many))).toHaveLength(100);
  });

  it("starts empty and is applied on the speak path", () => {
    expect(DEFAULT_PREFERENCES.voice.pronunciations).toEqual({});
    const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    expect(mode).toContain(
      "prepareForSpeech(spoken, preferences.getSnapshot().voice.pronunciations)",
    );
    expect(
      readFileSync("src/components/friday/settings/VoiceEngineSettings.tsx", "utf8"),
    ).toContain("<PronunciationSettings />");
  });
});
