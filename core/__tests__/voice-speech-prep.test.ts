import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENGLISH_IN_HINDI,
  ROMAN_HINDI_STRONG,
  ROMAN_HINDI_WEAK,
} from "../../src/lib/friday/voice-engine/speech-prep-lexicon";
import {
  maskInlineCode,
  prepareSpeechText,
  speechPrepTableSizes,
  usesHindiVoice,
} from "../../src/lib/friday/voice-engine/speech-prep";
import {
  prepareForSpeech,
  spellNumbers,
  spellOrdinals,
} from "../../src/lib/friday/voice-engine/text-normalizer";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

type Case = {
  kind: "prep" | "full";
  name: string;
  input: string;
  expected: string;
  options?: { enabled?: boolean; hindiVoice?: boolean };
  pronunciations?: Record<string, string>;
};
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/voice-speech-prep-cases.json"), "utf8"),
) as { cases: Case[] };

const run = (c: Case): string => {
  const options = { enabled: true, hindiVoice: true, ...c.options };
  return c.kind === "prep"
    ? prepareSpeechText(c.input, options)
    : prepareForSpeech(c.input, c.pronunciations ?? {}, options);
};

const pairs = (source: string): string[][] => {
  const words = source.split(/\s+/).filter(Boolean);
  const out: string[][] = [];
  for (let i = 0; i < words.length; i += 2) out.push([words[i] ?? "", words[i + 1] ?? ""]);
  return out;
};

describe("Speech Prep fixture cases", () => {
  it("has a spread of cases", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
  });
  it.each(fixture.cases.map((c) => [c.kind, c.name, c] as const))("%s: %s", (_k, _n, c) => {
    expect(run(c)).toBe(c.expected);
  });

  it("is idempotent: a prepared sentence is not changed again", () => {
    for (const c of fixture.cases.filter((x) => x.kind === "prep")) {
      const once = run(c);
      expect(prepareSpeechText(once, { enabled: true, hindiVoice: true, ...c.options })).toBe(once);
    }
  });

  it("never leaves a Devanagari digit for the voice", () => {
    for (const c of fixture.cases.filter((x) => x.kind === "full")) {
      expect(run(c)).not.toMatch(/[०-९]/);
    }
    expect(spellNumbers("१२३ और ५:३०", "hi")).not.toMatch(/[०-९]/);
  });
});

describe("Speech Prep boundaries", () => {
  it("leaves English sentences exactly as written, with or without the Hindi voice", () => {
    const english = [
      "Please do send the main report to me.",
      "I do not know what to do, main thing is fine.",
      "Open the meeting notes and check the file. Then reply to the email.",
      "kal is a name here and so is Hai Nguyen.",
    ];
    for (const line of english) {
      expect(prepareSpeechText(line, { enabled: true, hindiVoice: true })).toBe(line);
      expect(prepareSpeechText(line, { enabled: true, hindiVoice: false })).toBe(line);
    }
  });

  it("turns Roman Hindi into Devanagari only for the Hindi voice", () => {
    expect(prepareSpeechText("kal meeting hai", { hindiVoice: true })).toBe("कल मीटिंग है");
    expect(prepareSpeechText("kal meeting hai", { hindiVoice: false })).toBe("kal meeting hai");
    expect(prepareSpeechText("आज kal meeting hai", { hindiVoice: false })).toBe("आज kal मीटिंग hai");
  });

  it("needs two sure Roman Hindi words that are half of the Latin words", () => {
    expect(prepareSpeechText("kal send the report to the team today", {})).toBe(
      "kal send the report to the team today",
    );
    expect(prepareSpeechText("kal hai", {})).toBe("कल है");
  });

  it("does nothing when switched off or given nothing", () => {
    expect(prepareSpeechText("कल meeting है", { enabled: false })).toBe("कल meeting है");
    expect(prepareSpeechText("", {})).toBe("");
    expect(prepareForSpeech("कल meeting है", {})).toBe("कल meeting है.");
  });

  it("keeps inline code, links and quoted names out of the lexicon", () => {
    const masked = maskInlineCode("चलाओ `git push origin` अभी और `5` बार");
    expect(masked.text).not.toContain("git push");
    expect(masked.restore(masked.text)).toBe("चलाओ git push origin अभी और `5` बार");
    expect(prepareForSpeech("चलाओ `git push origin` अभी", {}, {})).toBe(
      "चलाओ git push origin अभी.",
    );
    expect(prepareForSpeech('मुझे "Open Drive" चाहिए', {}, {})).toBe('मुझे "Open Drive" चाहिए.');
  });

  it("reads a spelled acronym as letters and the article as one", () => {
    expect(prepareSpeechText("मेरा A P I ठीक है", {})).toBe("मेरा ए पी आई ठीक है");
    expect(prepareSpeechText("यह a link है", {})).toBe("यह एक लिंक है");
  });

  it("decides the Hindi voice from the speaking language", () => {
    expect(usesHindiVoice("hi-IN")).toBe(true);
    expect(usesHindiVoice("")).toBe(true);
    expect(usesHindiVoice("hinglish")).toBe(true);
    expect(usesHindiVoice("en-IN")).toBe(false);
    expect(usesHindiVoice("en_US")).toBe(false);
  });
});

describe("Speech Prep numbers (text-normalizer)", () => {
  it("keeps every old English number form", () => {
    expect(spellNumbers("at 5:30 pm", "en")).toBe("at five thirty P M");
    expect(spellNumbers("at 7:00", "en")).toBe("at seven o'clock");
    expect(spellNumbers("1234567890123", "en")).toBe("1234567890123");
  });

  it("says Hindi ordinals, negatives, rupee units and paise", () => {
    expect(spellOrdinals("1st 2nd 3rd 4th 5th 6th", "hi")).toBe("पहला दूसरा तीसरा चौथा पाँचवाँ छठा");
    expect(spellOrdinals("21st 100th", "en")).toBe("twenty first one hundredth");
    expect(spellNumbers("-5", "hi")).toBe("माइनस पाँच");
    expect(spellNumbers("5 - 3", "en")).toBe("five - three");
    expect(spellNumbers("₹5 lakh", "en")).toBe("five lakh rupees");
    expect(spellNumbers("₹99.50", "hi")).toBe("निन्यानवे रुपये पचास पैसे");
    expect(spellNumbers("₹0.50", "en")).toBe("fifty paise");
  });

  it("says Hindi clock times", () => {
    expect(spellNumbers("3:15", "hi")).toBe("सवा तीन बजे");
    expect(spellNumbers("3:30", "hi")).toBe("साढ़े तीन बजे");
    expect(spellNumbers("3:45", "hi")).toBe("पौने चार बजे");
    expect(spellNumbers("12:45", "hi")).toBe("पौने एक बजे");
    expect(spellNumbers("3:45 बजे", "hi")).toBe("पौने चार बजे");
    expect(spellNumbers("9:20 pm", "hi")).toBe("रात नौ बजकर बीस मिनट");
  });
});

describe("Speech Prep lexicon", () => {
  const english = pairs(ENGLISH_IN_HINDI);
  const strong = pairs(ROMAN_HINDI_STRONG);
  const weak = pairs(ROMAN_HINDI_WEAK);

  it("is well formed: lower-case ASCII keys, Devanagari values, no key twice", () => {
    for (const table of [english, strong, weak]) {
      const seen = new Set<string>();
      for (const [key = "", value = ""] of table) {
        expect(key, key).toMatch(/^[a-z]+$/);
        expect(value, `${key} -> ${value}`).toMatch(/^[ऀ-ॣॱ-ॿ]+$/);
        expect(seen.has(key), `${key} twice`).toBe(false);
        seen.add(key);
      }
    }
  });

  it("keeps sure Roman Hindi apart from English and from the ambiguous words", () => {
    const englishKeys = new Set(english.map(([k]) => k));
    const weakKeys = new Set(weak.map(([k]) => k));
    for (const [key = ""] of strong) {
      expect(englishKeys.has(key), `${key} is also English`).toBe(false);
      expect(weakKeys.has(key), `${key} is also ambiguous`).toBe(false);
    }
    for (const sure of ["the", "do", "main", "is", "to", "me", "so", "at", "in", "a"]) {
      expect(
        strong.some(([k]) => k === sure),
        sure,
      ).toBe(false);
    }
  });

  it("is large enough and parsed once", () => {
    const sizes = speechPrepTableSizes();
    expect(sizes.english).toBeGreaterThanOrEqual(1100);
    expect(sizes.romanHindi).toBeGreaterThanOrEqual(370);
    expect(speechPrepTableSizes()).toEqual(sizes);
  });
});

describe("Speech Prep latency", () => {
  const reply =
    "आपके Gmail में एक नया email आया है और kal ki meeting 3:45 बजे है, ₹1,500 का bill भी pending है। ";
  const hinglish = "kal meeting hai aur aap mujhe do minute mein call kar do. ";
  const english = "Please send the report to the team before the meeting on the 21st at 3:45 pm. ";

  it("stays far below the 800 ms voice budget and reports chars per ms", () => {
    const text = (reply + hinglish + english).repeat(500);
    const started = performance.now();
    const out = prepareForSpeech(text, {}, { enabled: true, hindiVoice: true });
    const ms = Math.max(performance.now() - started, 0.001);
    const rate = text.length / ms;
    expect(out.length).toBeGreaterThan(0);
    // A normal reply is a few hundred characters; this is about 100 000.
    expect(ms).toBeLessThan(800);
    expect(rate).toBeGreaterThan(100);
  });

  it("a typical reply costs a few milliseconds", () => {
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) prepareForSpeech(reply + hinglish, {}, { enabled: true });
    expect((performance.now() - started) / 50).toBeLessThan(25);
  });

  it("survives text built to hurt regular expressions", () => {
    const nasty = [
      `${"'".repeat(20000)}x`,
      `"${"a ".repeat(30000)}`,
      "क ".repeat(20000) + "A ".repeat(20000),
      "a.b ".repeat(20000),
      `${"1".repeat(40000)}:${"5".repeat(40000)}`,
      "₹".repeat(30000) + "1,".repeat(30000),
      "-".repeat(50000) + "5",
    ];
    for (const text of nasty) {
      const started = performance.now();
      prepareForSpeech(text, {}, { enabled: true, hindiVoice: true });
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(800);
    }
  });
});

describe("Speech Prep setting", () => {
  const read = (file: string) => readFileSync(resolve(__dirname, "../..", file), "utf8");

  it("is on by default and honoured on the speak path", () => {
    expect(DEFAULT_PREFERENCES.voice.speechPrep).toBe(true);
    const mode = read("src/lib/friday/assistant-mode.ts");
    expect(mode).toContain("enabled: voice.speechPrep !== false");
    expect(mode).toContain("hindiVoice: usesHindiVoice(voice.speechLang || voice.recognitionLang)");
  });

  it("has a switch in Settings, Voice and is in the flow registry", () => {
    expect(read("src/components/friday/settings/VoiceSettings.tsx")).toContain(
      "prefs.voice.speechPrep !== false",
    );
    expect(read("src/lib/friday/flow-registry.gen.ts")).toContain('"voice.speechPrep"');
  });
});
