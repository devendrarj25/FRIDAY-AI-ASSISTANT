/**
 * Canonical transcript and per-span TTS treatment: the raw hypothesis is kept, Hindi stays Devanagari, English stays
 * Roman, digits are digits, Roman Hindi is flagged and never transliterated here, and each span gets a TTS path.
 */
import { describe, expect, it } from "vitest";
import {
  segmentCodemix,
  type CodemixSpan,
} from "../../src/lib/friday/voice-engine/language-segmenter";
import {
  canonicalise,
  scriptPolicyFor,
  spanTreatments,
} from "../../src/lib/friday/voice-engine/script-policy";

const single = (text: string): CodemixSpan => {
  const spans = segmentCodemix(text);
  expect(spans).toHaveLength(1);
  return spans[0]!;
};

describe("canonicalise", () => {
  it("keeps the raw hypothesis byte-identical", () => {
    const raw = "  mujhe  file‍  open\t karni hai  ।\n";
    const out = canonicalise(raw);
    expect(out.raw).toBe(raw);
    expect(out.text).not.toBe(raw);
  });

  it("removes zero-width characters", () => {
    expect(canonicalise("open​ the⁠ file﻿").text).toBe("open the file");
  });

  it("collapses whitespace of every kind and trims", () => {
    expect(canonicalise("  open  the\t\nfile 　now ").text).toBe("open the file now");
  });

  it("straightens quotes and pulls punctuation back to its word", () => {
    expect(canonicalise("it’s “fine” , ok ?").text).toBe('it\'s "fine", ok?');
    expect(canonicalise("नमस्ते ।").text).toBe("नमस्ते।");
  });

  it("writes Devanagari and full-width digits as ASCII digits", () => {
    expect(canonicalise("२ बजे").text).toBe("2 बजे");
    expect(canonicalise("２０２４").text).toBe("2024");
  });

  it("keeps existing numerals and never turns number words into digits", () => {
    expect(canonicalise("at 2 pm").text).toBe("at 2 pm");
    expect(canonicalise("two baje, दो बजे").text).toBe("two baje, दो बजे");
  });

  it("leaves clean mixed text unchanged: English Roman, Hindi Devanagari", () => {
    const text = "मुझे meeting चाहिए";
    expect(canonicalise(text).text).toBe(text);
  });

  it("does not transliterate Roman Hindi and flags the turn as romanised", () => {
    const out = canonicalise("kya baat hai");
    expect(out.text).toBe("kya baat hai");
    expect(out.romanised).toBe(true);
  });

  it("flags a mixed turn that holds Roman Hindi words", () => {
    expect(canonicalise("mujhe ek file open karni hai").romanised).toBe(true);
  });

  it("does not flag pure English or pure Devanagari", () => {
    expect(canonicalise("open the file").romanised).toBe(false);
    expect(canonicalise("मुझे फाइल खोलनी है").romanised).toBe(false);
    expect(canonicalise("मुझे meeting चाहिए").romanised).toBe(false);
  });

  it("returns the spans of the canonical text", () => {
    const out = canonicalise("  mujhe file kholo ");
    expect(out.spans).toEqual(segmentCodemix(out.text));
    expect(out.spans.map((s) => s.lang)).toEqual(["hi", "en", "hi"]);
  });

  it("handles empty and whitespace-only input", () => {
    expect(canonicalise("")).toEqual({ text: "", spans: [], raw: "", romanised: false });
    const blank = canonicalise(" ​ ");
    expect(blank.text).toBe("");
    expect(blank.raw).toBe(" ​ ");
    expect(blank.spans).toEqual([]);
  });

  it("is idempotent and deterministic", () => {
    const raw = " “kya”  baat‍ hai ,  २ baje ";
    const once = canonicalise(raw);
    expect(canonicalise(raw)).toEqual(once);
    expect(canonicalise(once.text).text).toBe(once.text);
  });

  it("does not mutate its options", () => {
    const opts = Object.freeze({ defaultLang: "hi" as const });
    expect(() => canonicalise("2024", opts)).not.toThrow();
    expect(opts).toEqual({ defaultLang: "hi" });
  });
});

describe("scriptPolicyFor", () => {
  it("sends a Devanagari span to the Devanagari path of FRIDAY Voice", () => {
    expect(scriptPolicyFor(single("मुझे फाइल खोलनी है"), "supertonic")).toMatchObject({
      path: "devanagari",
      lang: "hi",
      engineReads: true,
    });
  });

  it("sends an English span to the English path", () => {
    expect(scriptPolicyFor(single("open the file"), "neural")).toMatchObject({
      path: "english",
      lang: "en",
      engineReads: true,
    });
  });

  it("sends romanised Hindi to the Hinglish path", () => {
    expect(scriptPolicyFor(single("kya baat hai"), "supertonic")).toMatchObject({
      path: "hinglish",
      lang: "hi",
    });
  });

  it("expands a number with Hindi words when a Hindi word follows", () => {
    const [num, hi] = segmentCodemix("2 baje") as [CodemixSpan, CodemixSpan];
    expect(scriptPolicyFor(num, "supertonic", { next: hi })).toMatchObject({
      path: "numbers",
      numberLang: "hi",
    });
  });

  it("expands a number with English words when an English word follows", () => {
    const [at, num, pm] = segmentCodemix("at 2 pm") as [CodemixSpan, CodemixSpan, CodemixSpan];
    expect(scriptPolicyFor(num, "supertonic", { prev: at, next: pm }).numberLang).toBe("en");
  });

  it("falls back to the language before the number when nothing follows", () => {
    const [hi, num] = segmentCodemix("kal 2") as [CodemixSpan, CodemixSpan];
    expect(scriptPolicyFor(num, "supertonic", { prev: hi }).numberLang).toBe("hi");
  });

  it("uses the default language for a number alone", () => {
    const num = single("2024");
    expect(scriptPolicyFor(num, "supertonic").numberLang).toBe("en");
    expect(scriptPolicyFor(num, "supertonic", { defaultLang: "hi" }).numberLang).toBe("hi");
  });

  it("does not read punctuation aloud", () => {
    expect(scriptPolicyFor(single("?!"), "supertonic")).toMatchObject({
      path: "none",
      lang: "none",
    });
  });

  it("says the system voice cannot read Hindi, and can read English", () => {
    expect(scriptPolicyFor(single("मुझे फाइल"), "sapi").engineReads).toBe(false);
    expect(scriptPolicyFor(single("open the file"), "sapi").engineReads).toBe(true);
  });

  it("treats an unknown engine like the system voice for Hindi", () => {
    expect(scriptPolicyFor(single("मुझे फाइल"), "mystery").engineReads).toBe(false);
  });

  it("does not mutate the span it is given", () => {
    const span = Object.freeze({ ...single("kya baat hai") });
    expect(() => scriptPolicyFor(span, "supertonic")).not.toThrow();
  });
});

describe("spanTreatments", () => {
  it("resolves each number from its neighbours across a whole sentence", () => {
    const hi = spanTreatments(segmentCodemix("kal 2 baje meeting"), "supertonic");
    expect(hi.map((t) => t.path)).toEqual(["hinglish", "numbers", "hinglish", "english"]);
    expect(hi[1]?.numberLang).toBe("hi");
    const en = spanTreatments(segmentCodemix("at 2 pm"), "supertonic");
    expect(en.find((t) => t.path === "numbers")?.numberLang).toBe("en");
  });

  it("skips punctuation spans when looking for the neighbouring language", () => {
    const spans = segmentCodemix("(2) baje");
    expect(spanTreatments(spans, "supertonic").find((t) => t.path === "numbers")?.numberLang).toBe(
      "hi",
    );
  });

  it("returns one treatment per span, in order, without touching the spans", () => {
    const spans = Object.freeze(segmentCodemix("मुझे meeting चाहिए"));
    const out = spanTreatments(spans, "neural");
    expect(out.map((t) => t.path)).toEqual(["devanagari", "english", "devanagari"]);
    expect(out.map((t) => t.span)).toEqual(spans);
  });

  it("returns nothing for no spans", () => {
    expect(spanTreatments([], "supertonic")).toEqual([]);
  });
});
