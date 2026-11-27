import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CalibrationBook,
  CalibrationRing,
  DICTATION_EAGER_FRAMES,
  LANG_BASE_OFFSET,
  MAX_BASE_FRAMES,
  MAX_WAIT_FRAMES,
  MIN_BASE_FRAMES,
  eotEagerFrames,
  eotHoldFrames,
  maxWaitFramesFor,
  withLangOffset,
} from "../../src/lib/friday/voice-engine/endpoint-calibration";
import {
  BACKCHANNEL_WORDS,
  DANGLING_TAIL_WORDS,
} from "../../src/lib/friday/voice-engine/hinglish-lexicon";

describe("eotHoldFrames: dangling tail words", () => {
  it("'aur' tail adds 6", () => {
    expect(eotHoldFrames("mujhe doodh chahiye aur")).toBe(6);
  });

  it.each([
    "main kal aa raha hoon ki",
    "uske ke",
    "ye mere ko",
    "chai toh",
    "matlab",
    "chai ya",
    "jaise",
    "nahin kyunki",
    "theek hai lekin",
    "bread and",
    "tea or",
    "give me the",
    "a cup of",
    "I want to",
    "I was um",
    "I was uh",
    "well hmm",
    "so",
    "I tried but",
  ])("English/Hinglish dangling %j adds 6", (text) => {
    expect(eotHoldFrames(text)).toBe(6);
  });

  it.each([
    "मुझे चाय चाहिए और",
    "ये चाय की",
    "उसके के",
    "चाय को",
    "चाय तो",
    "मतलब",
    "चाय या",
    "ठीक है लेकिन",
  ])("Devanagari dangling %j adds 6", (text) => {
    expect(eotHoldFrames(text)).toBe(6);
  });

  it("ignores case, trailing spaces and a trailing comma", () => {
    expect(eotHoldFrames("Chai AUR  ")).toBe(6);
    expect(eotHoldFrames("chai aur,")).toBe(6);
  });

  it("does not match a word that only ends like a tail word", () => {
    expect(eotHoldFrames("main bahut thaka hoon")).toBe(0);
    expect(eotHoldFrames("open the door")).toBe(0);
  });

  it("a finished sentence mark gives 0, even after a tail word", () => {
    expect(eotHoldFrames("chai chahiye.")).toBe(0);
    expect(eotHoldFrames("kya time hua hai?")).toBe(0);
    expect(eotHoldFrames("band karo!")).toBe(0);
    expect(eotHoldFrames("मुझे चाय चाहिए।")).toBe(0);
    expect(eotHoldFrames("I want to.")).toBe(0);
  });

  it("empty or blank text is 0", () => {
    expect(eotHoldFrames("")).toBe(0);
    expect(eotHoldFrames("   ")).toBe(0);
    expect(eotHoldFrames("", "number")).toBe(0);
    expect(eotHoldFrames("", "yesno")).toBe(0);
  });
});

describe("eotHoldFrames: expect number", () => {
  it.each([
    "mera number hai 98",
    "call 9876",
    "set alarm for seven",
    "ek",
    "मेरा नंबर पाँच",
    "twenty",
  ])("trailing number %j with expect number adds 4", (text) => {
    expect(eotHoldFrames(text, "number")).toBe(4);
  });

  it("a number without expect number adds nothing", () => {
    expect(eotHoldFrames("mera number hai 98")).toBe(0);
    expect(eotHoldFrames("mera number hai 98", "open")).toBe(0);
  });

  it("a finished sentence mark after a number gives 0", () => {
    expect(eotHoldFrames("mera number hai 98.", "number")).toBe(0);
  });

  it("a non-number tail with expect number adds nothing", () => {
    expect(eotHoldFrames("mera number batao", "number")).toBe(0);
  });
});

describe("eotHoldFrames: expect yesno", () => {
  it.each(["haan", "nahi", "ji", "yes", "no", "ok", "theek", "हाँ", "नहीं", "Haan.", "ji haan"])(
    "yes/no %j with expect yesno gives -4",
    (text) => {
      expect(eotHoldFrames(text, "yesno")).toBe(-4);
    },
  );

  it("never goes below -4", () => {
    expect(eotHoldFrames("haan haan haan", "yesno")).toBe(-4);
  });

  it("a yes/no word without expect yesno adds nothing", () => {
    expect(eotHoldFrames("haan")).toBe(0);
    expect(eotHoldFrames("haan", "number")).toBe(0);
  });

  it("a long non-yes/no answer with expect yesno adds nothing", () => {
    expect(eotHoldFrames("pata nahi kya karna hai", "yesno")).toBe(0);
  });

  it("a dangling tail still holds under expect yesno", () => {
    expect(eotHoldFrames("haan aur", "yesno")).toBe(6);
  });
});

describe("eotHoldFrames: the word lists are the lexicon's", () => {
  it("reads the tail and backchannel words from the lexicon, with no list of its own", () => {
    const source = readFileSync(
      new URL("../../src/lib/friday/voice-engine/endpoint-calibration.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('from "./hinglish-lexicon"');
    expect(source).not.toMatch(/const (DANGLING|YES_NO) = new Set/);
  });

  it("every lexicon tail word holds a turn open and nothing else does", () => {
    for (const word of DANGLING_TAIL_WORDS) {
      expect(eotHoldFrames(`mujhe batana hai ${word}`), word).toBe(6);
    }
  });

  it("achha and a Devanagari yes close a yes/no turn fast, and only then", () => {
    for (const word of ["achha", "accha", "अच्छा", "ठीक", "okay"]) {
      expect(BACKCHANNEL_WORDS.has(word), word).toBe(true);
      expect(eotHoldFrames(word, "yesno"), word).toBe(-4);
      expect(eotHoldFrames(word), word).toBe(0);
      expect(eotHoldFrames(word, "number"), word).toBe(0);
    }
  });

  it("hmm is a thought, not an answer: it holds the turn even when a yes/no is expected", () => {
    for (const word of ["hmm", "Hmm,", "हम्म"]) {
      expect(eotHoldFrames(word, "yesno"), word).toBeGreaterThanOrEqual(0);
    }
    expect(eotHoldFrames("hmm", "yesno")).toBe(6);
    expect(eotHoldFrames("hmm")).toBe(6);
    expect(eotHoldFrames("हम्म", "yesno")).toBe(6);
    expect(eotHoldFrames("हम्म")).toBe(6);
    expect(eotHoldFrames("hmm.", "yesno")).toBe(0);
  });

  it("a backchannel word that ends a longer sentence is not a yes/no answer without the expectation", () => {
    expect(eotHoldFrames("main kal aaunga achha")).toBe(0);
    expect(eotHoldFrames("sab theek hai achha", "number")).toBe(0);
  });
});

describe("CalibrationRing", () => {
  const fill = (ring: CalibrationRing, n: number, eotWaitMs: number, cuts = 0): void => {
    for (let i = 0; i < n; i += 1) ring.push({ eotWaitMs, falseCut: i < cuts });
  };

  it("fewer than 20 samples keeps the current base", () => {
    const ring = new CalibrationRing();
    fill(ring, 19, 700, 19);
    expect(ring.suggestedBaseFrames(6)).toBe(6);
  });

  it("a false-cut rate above 5% gives cur + 1", () => {
    const ring = new CalibrationRing();
    fill(ring, 20, 400, 2);
    expect(ring.suggestedBaseFrames(6)).toBe(7);
  });

  it("a false-cut rate of exactly 5% does not raise the base", () => {
    const ring = new CalibrationRing();
    fill(ring, 20, 400, 1);
    expect(ring.suggestedBaseFrames(6)).toBe(6);
  });

  it("rate below 1% with p50 above 480 ms gives cur - 1", () => {
    const ring = new CalibrationRing();
    fill(ring, 200, 600, 0);
    expect(ring.suggestedBaseFrames(6)).toBe(5);
  });

  it("rate below 1% with p50 at or under 480 ms keeps the base", () => {
    const ring = new CalibrationRing();
    fill(ring, 50, 480, 0);
    expect(ring.suggestedBaseFrames(6)).toBe(6);
  });

  it("a rate between 1% and 5% keeps the base", () => {
    const ring = new CalibrationRing();
    fill(ring, 100, 700, 3);
    expect(ring.suggestedBaseFrames(6)).toBe(6);
  });

  it("clamps to 4..10", () => {
    const hi = new CalibrationRing();
    fill(hi, 20, 400, 10);
    expect(hi.suggestedBaseFrames(10)).toBe(10);
    const lo = new CalibrationRing();
    fill(lo, 50, 900, 0);
    expect(lo.suggestedBaseFrames(4)).toBe(4);
    expect(lo.suggestedBaseFrames(5)).toBe(4);
  });

  it("is bounded: the oldest sample falls out past the cap", () => {
    const ring = new CalibrationRing();
    fill(ring, 250, 600, 0);
    expect(ring.size()).toBe(200);
    const small = new CalibrationRing(3);
    fill(small, 5, 600, 0);
    expect(small.size()).toBe(3);
  });

  it("old false cuts age out of the window", () => {
    const ring = new CalibrationRing(20);
    fill(ring, 20, 400, 20);
    expect(ring.suggestedBaseFrames(6)).toBe(7);
    fill(ring, 20, 400, 0);
    expect(ring.suggestedBaseFrames(6)).toBe(6);
  });

  it("ignores a non-finite wait", () => {
    const ring = new CalibrationRing();
    ring.push({ eotWaitMs: Number.NaN, falseCut: false });
    ring.push({ eotWaitMs: Number.POSITIVE_INFINITY, falseCut: false });
    expect(ring.size()).toBe(0);
  });

  it("round-trips through JSON", () => {
    const ring = new CalibrationRing();
    fill(ring, 30, 600, 2);
    const back = CalibrationRing.fromJSON(JSON.parse(JSON.stringify(ring.toJSON())));
    expect(back.size()).toBe(30);
    expect(back.toJSON()).toEqual(ring.toJSON());
    expect(back.suggestedBaseFrames(6)).toBe(ring.suggestedBaseFrames(6));
  });

  it.each([
    null,
    undefined,
    7,
    "x",
    [],
    {},
    { v: 1 },
    { v: 1, samples: "no" },
    { v: 1, samples: [{ eotWaitMs: "a", falseCut: false }] },
    { v: 1, samples: [null] },
  ])("a bad shape %j loads as empty", (bad) => {
    const ring = CalibrationRing.fromJSON(bad);
    expect(ring.size()).toBe(0);
    expect(ring.suggestedBaseFrames(6)).toBe(6);
  });

  it("a stored list longer than the cap keeps the newest", () => {
    const samples = Array.from({ length: 300 }, (_, i) => ({ eotWaitMs: i, falseCut: false }));
    const ring = CalibrationRing.fromJSON({ v: 1, samples });
    expect(ring.size()).toBe(200);
    expect(ring.toJSON().samples[0]?.eotWaitMs).toBe(100);
  });

  it("toJSON returns a copy, not the live list", () => {
    const ring = new CalibrationRing();
    fill(ring, 3, 600, 0);
    ring.toJSON().samples.pop();
    expect(ring.size()).toBe(3);
  });
});

describe("end of turn per language", () => {
  it("LANG_BASE_OFFSET is en 0, hi 2, hinglish 2", () => {
    expect(LANG_BASE_OFFSET).toEqual({ en: 0, hi: 2, hinglish: 2 });
  });

  it("a Hindi or Hinglish dangling tail holds at least as long as English, and by the offset", () => {
    const text = "mujhe batao ki";
    const en = eotHoldFrames(text, undefined, "en");
    expect(eotHoldFrames(text, undefined, "hi")).toBeGreaterThanOrEqual(en);
    expect(eotHoldFrames(text, undefined, "hi")).toBe(6 + LANG_BASE_OFFSET.hi);
    expect(eotHoldFrames(text, undefined, "hinglish")).toBe(6 + LANG_BASE_OFFSET.hinglish);
    expect(en).toBe(6);
  });

  it("without a language every old answer is unchanged", () => {
    expect(eotHoldFrames("chai aur")).toBe(6);
    expect(eotHoldFrames("haan", "yesno")).toBe(-4);
    expect(eotHoldFrames("mera number hai 98", "number")).toBe(4);
  });

  it("a finished sentence and a fast yes never wait longer for a language", () => {
    expect(eotHoldFrames("chai chahiye.", undefined, "hi")).toBe(0);
    expect(eotHoldFrames("haan", "yesno", "hinglish")).toBe(-4);
    expect(eotHoldFrames("mera number hai 98", undefined, "hi")).toBe(0);
  });

  it("withLangOffset adds the offset, never past MAX_BASE_FRAMES + 2, and never lowers a base", () => {
    expect(withLangOffset(6, "hi")).toBe(8);
    expect(withLangOffset(6, "en")).toBe(6);
    expect(withLangOffset(6, undefined)).toBe(6);
    expect(withLangOffset(MAX_BASE_FRAMES, "hinglish")).toBe(MAX_BASE_FRAMES + 2);
    expect(withLangOffset(MAX_BASE_FRAMES + 1, "hi")).toBe(MAX_BASE_FRAMES + 2);
    expect(withLangOffset(400, "hi")).toBe(400);
  });
});

describe("end of turn eagerness and the longest wait", () => {
  it("dictation and open wait 4 frames more, the rest add nothing", () => {
    expect(DICTATION_EAGER_FRAMES).toBe(4);
    expect(eotEagerFrames("dictation")).toBe(4);
    expect(eotEagerFrames("open")).toBe(4);
    for (const e of ["yesno", "number", "name", undefined] as const) {
      expect(eotEagerFrames(e)).toBe(0);
    }
  });

  it("the longest quiet wait is 2.4 s, 4 s for dictation and open", () => {
    expect(MAX_WAIT_FRAMES).toBe(30);
    expect(maxWaitFramesFor(undefined)).toBe(30);
    expect(maxWaitFramesFor("yesno")).toBe(30);
    expect(maxWaitFramesFor("dictation")).toBe(50);
    expect(maxWaitFramesFor("open")).toBe(50);
  });

  it("a configured wait is clamped to 1.2..4 s", () => {
    expect(maxWaitFramesFor(undefined, 2)).toBe(15);
    expect(maxWaitFramesFor(undefined, 400)).toBe(50);
    expect(maxWaitFramesFor("open", 400)).toBe(50);
    expect(maxWaitFramesFor(undefined, Number.NaN)).toBe(30);
  });

  it("a fast yes/no base is the minimum base", () => {
    expect(MIN_BASE_FRAMES).toBe(4);
  });
});

describe("CalibrationBook: one ring per language", () => {
  const fill = (book: CalibrationBook, lang: "en" | "hi" | "hinglish", n: number, cuts = 0) => {
    for (let i = 0; i < n; i += 1) book.push(lang, { eotWaitMs: 700, falseCut: i < cuts });
  };

  it("19 samples of a language keep the base, 20 move it", () => {
    const book = new CalibrationBook();
    fill(book, "hi", 19, 19);
    expect(book.suggestedBaseFrames("hi", 6)).toBe(6);
    fill(book, "hi", 1, 1);
    expect(book.suggestedBaseFrames("hi", 6)).toBe(7);
  });

  it("another language's samples never count", () => {
    const book = new CalibrationBook();
    fill(book, "hi", 40, 40);
    expect(book.size("en")).toBe(0);
    expect(book.suggestedBaseFrames("en", 6)).toBe(6);
    expect(book.suggestedBaseFrames("hinglish", 6)).toBe(6);
    expect(book.suggestedBaseFrames("hi", 6)).toBe(7);
  });

  it("baseFramesFor adds the language offset to the suggestion within the clamp", () => {
    const book = new CalibrationBook();
    expect(book.baseFramesFor("hi", 6)).toBe(8);
    expect(book.baseFramesFor("en", 6)).toBe(6);
    expect(book.baseFramesFor("hinglish", MAX_BASE_FRAMES)).toBe(MAX_BASE_FRAMES + 2);
  });

  it("round-trips by language, and a bad shape loads empty", () => {
    const book = new CalibrationBook();
    fill(book, "en", 3);
    fill(book, "hinglish", 5, 1);
    const back = CalibrationBook.fromJSON(JSON.parse(JSON.stringify(book.toJSON())));
    expect(back.size("en")).toBe(3);
    expect(back.size("hinglish")).toBe(5);
    expect(back.size("hi")).toBe(0);
    for (const bad of [
      null,
      3,
      { v: 1 },
      { v: 2, rings: 4 },
      { v: 2, rings: { en: [{ x: 1 }] } },
    ]) {
      const empty = CalibrationBook.fromJSON(bad);
      expect(empty.size("en") + empty.size("hi") + empty.size("hinglish")).toBe(0);
    }
  });

  it("each language ring keeps at most 200 samples", () => {
    const book = new CalibrationBook();
    fill(book, "en", 260);
    expect(book.size("en")).toBe(200);
  });
});
