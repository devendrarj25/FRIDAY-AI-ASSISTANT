/**
 * Codemix segmenter: a Hinglish string is cut into maximal same-language spans, script first, the Hinglish lexicon for
 * Roman words. Pure text in, pure spans out; the spans always rejoin to the input (zero-width characters aside).
 */
import { describe, expect, it } from "vitest";
import {
  segmentCodemix,
  stripZeroWidth,
  type CodemixSpan,
} from "../../src/lib/friday/voice-engine/language-segmenter";

const shape = (spans: readonly CodemixSpan[]) =>
  spans.map((s) => [s.text, s.script, s.lang, s.romanisedHindi] as const);
const rejoin = (spans: readonly CodemixSpan[]) => spans.map((s) => s.text).join("");

describe("segmentCodemix: single-language text", () => {
  it("returns no spans for empty and whitespace-only text", () => {
    expect(segmentCodemix("")).toEqual([]);
    expect(segmentCodemix("   \t\n ")).toEqual([]);
  });

  it("keeps pure Devanagari as one Hindi span", () => {
    expect(shape(segmentCodemix("मुझे फाइल खोलनी है"))).toEqual([
      ["मुझे फाइल खोलनी है", "deva", "hi", false],
    ]);
  });

  it("keeps pure English as one English span", () => {
    expect(shape(segmentCodemix("open the file"))).toEqual([
      ["open the file", "latn", "en", false],
    ]);
  });

  it("flags a Roman Hindi sentence as one romanised Hindi span", () => {
    expect(shape(segmentCodemix("kya baat hai"))).toEqual([["kya baat hai", "latn", "hi", true]]);
  });

  it("reads upper case Roman Hindi the same way", () => {
    expect(shape(segmentCodemix("KYA BAAT HAI"))).toEqual([["KYA BAAT HAI", "latn", "hi", true]]);
  });

  it("treats an apostrophe word as one English word", () => {
    expect(shape(segmentCodemix("don't stop"))).toEqual([["don't stop", "latn", "en", false]]);
  });
});

describe("segmentCodemix: mixed text", () => {
  it("splits Roman Hindi from the English noun and flags the Hindi words", () => {
    expect(shape(segmentCodemix("mujhe file kholo"))).toEqual([
      ["mujhe ", "latn", "hi", true],
      ["file ", "latn", "en", false],
      ["kholo", "latn", "hi", true],
    ]);
  });

  it("handles 'mujhe ek file open karni hai' with the Hindi grammar words flagged", () => {
    expect(shape(segmentCodemix("mujhe ek file open karni hai"))).toEqual([
      ["mujhe ek ", "latn", "hi", true],
      ["file open ", "latn", "en", false],
      ["karni hai", "latn", "hi", true],
    ]);
  });

  it("splits Devanagari Hindi around a Roman English word", () => {
    expect(shape(segmentCodemix("मुझे meeting चाहिए"))).toEqual([
      ["मुझे ", "deva", "hi", false],
      ["meeting ", "latn", "en", false],
      ["चाहिए", "deva", "hi", false],
    ]);
  });

  it("splits one token that holds both scripts", () => {
    expect(shape(segmentCodemix("meetingको"))).toEqual([
      ["meeting", "latn", "en", false],
      ["को", "deva", "hi", false],
    ]);
  });

  it("keeps Devanagari and Roman Hindi as separate spans", () => {
    expect(shape(segmentCodemix("काम kar do"))).toEqual([
      ["काम ", "deva", "hi", false],
      ["kar do", "latn", "hi", true],
    ]);
  });

  it("reads an ambiguous word as Hindi only beside a sure Hindi word", () => {
    expect(shape(segmentCodemix("kal do baje"))[0]).toEqual(["kal do baje", "latn", "hi", true]);
    expect(shape(segmentCodemix("open main menu"))).toEqual([
      ["open main menu", "latn", "en", false],
    ]);
  });

  it("rejoins to the input for every sample", () => {
    for (const text of [
      "mujhe ek file open karni hai",
      "मुझे meeting चाहिए, ok?",
      "Hello. नमस्ते 2 baje",
      "  leading and trailing  ",
      "(hello) ... 10:30!",
    ]) {
      expect(rejoin(segmentCodemix(text))).toBe(text);
    }
  });
});

describe("segmentCodemix: numbers", () => {
  it("makes a digits span of the number before a Hindi word", () => {
    expect(shape(segmentCodemix("2 baje"))).toEqual([
      ["2 ", "digits", "num", false],
      ["baje", "latn", "hi", true],
    ]);
  });

  it("places the number between English words", () => {
    expect(shape(segmentCodemix("at 2 pm"))).toEqual([
      ["at ", "latn", "en", false],
      ["2 ", "digits", "num", false],
      ["pm", "latn", "en", false],
    ]);
  });

  it("returns a lone year as one number span", () => {
    expect(shape(segmentCodemix("2024"))).toEqual([["2024", "digits", "num", false]]);
  });

  it("keeps times, decimals and thousands groups in one number", () => {
    expect(segmentCodemix("10:30")).toHaveLength(1);
    expect(segmentCodemix("3.5")).toHaveLength(1);
    expect(segmentCodemix("1,000")).toHaveLength(1);
    expect(segmentCodemix("1,000")[0]?.lang).toBe("num");
  });

  it("reads Devanagari digits as a number span", () => {
    expect(shape(segmentCodemix("२ बजे"))).toEqual([
      ["२ ", "digits", "num", false],
      ["बजे", "deva", "hi", false],
    ]);
  });

  it("splits a number from letters stuck to it", () => {
    expect(shape(segmentCodemix("2pm"))).toEqual([
      ["2", "digits", "num", false],
      ["pm", "latn", "en", false],
    ]);
  });
});

describe("segmentCodemix: punctuation and odd characters", () => {
  it("gives punctuation-only text one punct span", () => {
    expect(shape(segmentCodemix("?!"))).toEqual([["?!", "punct", "other", false]]);
  });

  it("keeps punctuation inside a same-language span", () => {
    expect(shape(segmentCodemix("Hello, world!"))).toEqual([
      ["Hello, world!", "latn", "en", false],
    ]);
  });

  it("hangs punctuation on the span before it when the language changes", () => {
    expect(shape(segmentCodemix("Hello. नमस्ते"))).toEqual([
      ["Hello. ", "latn", "en", false],
      ["नमस्ते", "deva", "hi", false],
    ]);
  });

  it("gives leading punctuation a punct span of its own", () => {
    expect(shape(segmentCodemix("(hello)"))).toEqual([
      ["(", "punct", "other", false],
      ["hello)", "latn", "en", false],
    ]);
  });

  it("treats a letter of another script as other", () => {
    expect(shape(segmentCodemix("你好"))).toEqual([["你好", "punct", "other", false]]);
  });

  it("drops zero-width characters and keeps a conjunct in one word", () => {
    const text = "क्‍ष and​ go";
    expect(stripZeroWidth(text)).toBe("क्ष and go");
    expect(rejoin(segmentCodemix(text))).toBe("क्ष and go");
    expect(segmentCodemix(text).map((s) => s.lang)).toEqual(["hi", "en"]);
  });
});

describe("segmentCodemix: purity", () => {
  it("is deterministic and hands back a fresh array each call", () => {
    const text = "mujhe ek file open karni hai, 2 baje";
    const first = segmentCodemix(text);
    expect(segmentCodemix(text)).toEqual(first);
    first.length = 0;
    expect(segmentCodemix(text).length).toBeGreaterThan(1);
  });

  it("returns the same answer for a string and a copy of it", () => {
    expect(segmentCodemix(["kya", "baat", "hai"].join(" "))).toEqual(
      segmentCodemix("kya baat hai"),
    );
  });
});
