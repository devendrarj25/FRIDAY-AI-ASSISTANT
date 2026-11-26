import { describe, expect, it } from "vitest";
import {
  detectTurnLanguage,
  ROMAN_HINGLISH_SHARE,
  SHORT_TURN_WORDS,
} from "../../src/lib/friday/voice-engine/hinglish-lexicon";
import { languageMix } from "../../src/lib/friday/voice-engine/stream-session";

describe("one turn-language detector for the Brain hint and her own lines", () => {
  it("names its thresholds", () => {
    expect(ROMAN_HINGLISH_SHARE).toBe(0.3);
    expect(SHORT_TURN_WORDS).toBe(3);
  });

  const roman = [
    "kal subah meeting hai, mujhe yaad dilana",
    "mujhe kal ka schedule batao",
    "abhi kya kar rahe ho",
    "mujhe ek second dekho abhi",
    "mera phone kahan hai",
    "yaar ye report kal tak chahiye",
    "aaj ka mausam kaisa hai",
    "tum mujhe bata sakte ho kya",
  ];
  for (const line of roman) {
    it(`romanised Hinglish is hi-en: ${line}`, () => {
      const got = detectTurnLanguage(line, "en");
      expect(got.lang).toBe("hi-en");
      expect(got.romanised).toBe(true);
    });
  }

  const english = [
    "open the quarterly report please",
    "what is the weather like tomorrow",
    "remind me about the meeting at nine",
    "send the invoice to Rahul Sharma",
    "play some music while I work",
    "do you know where the main file is",
  ];
  for (const line of english) {
    it(`plain English stays en: ${line}`, () => {
      const got = detectTurnLanguage(line, "en");
      expect(got.lang).toBe("en");
      expect(got.romanised).toBe(false);
    });
  }

  it("Devanagari is hi and not romanised", () => {
    expect(detectTurnLanguage("कल सुबह मीटिंग है", "en")).toEqual({ lang: "hi", romanised: false });
    expect(detectTurnLanguage("हाँ", "")).toEqual({ lang: "hi", romanised: false });
  });

  it("mixed scripts are hi-en", () => {
    expect(detectTurnLanguage("कल की meeting cancel करो", "en")).toEqual({
      lang: "hi-en",
      romanised: false,
    });
  });

  it("very short lines and digits keep the declared language", () => {
    expect(detectTurnLanguage("ruko", "en").lang).toBe("en");
    expect(detectTurnLanguage("kya hai", "en").lang).toBe("en");
    expect(detectTurnLanguage("kya hai", "hi").lang).toBe("hi");
    expect(detectTurnLanguage("12 34", "en").lang).toBe("en");
    expect(detectTurnLanguage("12 34 56", "hi").lang).toBe("hi");
    expect(detectTurnLanguage("", "").lang).toBe("");
  });

  it("an English line with a Hindi name stays English", () => {
    expect(detectTurnLanguage("call Kabir about the project plan", "en").lang).toBe("en");
  });

  it("a declared Hindi or Hinglish ear is kept for romanised text", () => {
    expect(detectTurnLanguage("kal ki meeting", "hi").lang).toBe("hi");
    expect(detectTurnLanguage("kal subah meeting hai", "hi-en").lang).toBe("hi-en");
  });

  it("the Brain's turn record uses it", () => {
    expect(languageMix("kal subah meeting hai, mujhe yaad dilana", "en").lang).toBe("hi-en");
    expect(languageMix("open the report", "en").lang).toBe("en");
  });
});
