/**
 * The Hinglish word tables as data (config/hinglish-lexicon.json): the stop and look words that were missing, the
 * shared tail and backchannel tables, and the same 40 sample lines as kernel/tests/test_hinglish_lexicon.py.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKCHANNEL_WORDS,
  DANGLING_TAIL_WORDS,
  detectTurnLanguage,
  labelLanguages,
  lexiconDataLines,
  lexiconLines,
  fixScript,
} from "../../src/lib/friday/voice-engine/hinglish-lexicon";

type Declared = "hi" | "en" | "hi-en" | "";
type Row = [string, Declared, "hi" | "en" | "hi-en" | "", boolean];

// Keep in step with SAMPLES in kernel/tests/test_hinglish_lexicon.py (line, declared, language, romanised).
const SAMPLES: Row[] = [
  ["ruko ruko ruko", "en", "hi-en", true],
  ["ruko aur dekh lo", "en", "hi-en", true],
  ["rukiye abhi batao", "en", "hi-en", true],
  ["dekhne do mujhe", "en", "hi-en", true],
  ["batao suno bolo", "en", "hi-en", true],
  ["haan theek hai", "en", "hi-en", true],
  ["kya kar rahe ho", "en", "hi-en", true],
  ["nahin achha nahi", "en", "hi-en", true],
  ["mujhe ji nahin chahiye", "en", "hi-en", true],
  ["kal subah meeting hai", "en", "hi-en", true],
  ["aap kaise ho", "en", "hi-en", true],
  ["ruko ek minute", "en", "hi-en", true],
  ["jaldi karo bhai", "en", "hi-en", true],
  ["dekh kya raha hai", "en", "hi-en", true],
  ["mera kaam ho gaya", "en", "hi-en", true],
  ["open the report", "en", "en", false],
  ["what time is it", "en", "en", false],
  ["stop the music please", "en", "en", false],
  ["wait one moment", "en", "en", false],
  ["play my favourite song", "en", "en", false],
  ["send the mail to Rahul", "en", "en", false],
  ["do you see the file", "en", "en", false],
  ["turn on the lights", "en", "en", false],
  ["read my last message", "en", "en", false],
  ["cancel the meeting tomorrow", "en", "en", false],
  ["रुको", "en", "hi", false],
  ["हाँ ठीक है", "en", "hi", false],
  ["कल की meeting cancel करो", "en", "hi-en", false],
  ["open करो file", "en", "hi-en", false],
  ["ठीक", "", "hi", false],
  ["ruko", "hi", "hi", false],
  ["ruko", "", "en", false],
  ["hmm", "en", "en", false],
  ["ok", "hi-en", "hi-en", false],
  ["12345", "hi", "hi", false],
  ["", "", "", false],
  ["ruko ruko ruko", "hi", "hi", true],
  ["open the report", "hi", "hi", false],
  ["kal subah meeting hai", "hi-en", "hi-en", true],
  ["wait one moment", "hi-en", "hi-en", false],
];

describe("the Hinglish lexicon data", () => {
  it("has 40 sample lines and every one reads the same as the kernel copy", () => {
    expect(SAMPLES).toHaveLength(40);
    for (const [line, declared, lang, romanised] of SAMPLES) {
      expect(detectTurnLanguage(line, declared), line).toEqual({ lang, romanised });
    }
  });

  it("knows the stop, look and answer words as Hindi", () => {
    const words = [
      "ruko",
      "rukiye",
      "rukna",
      "dekh",
      "dekhne",
      "batao",
      "suno",
      "bolo",
      "kya",
      "nahi",
      "nahin",
      "haan",
      "han",
      "achha",
      "accha",
      "theek",
      "thik",
      "ji",
    ];
    for (const w of words) expect(labelLanguages([w]), w).toEqual(["hi"]);
    expect(fixScript("ruko")).toBe("रुको");
    expect(fixScript("rukiye")).toBe("रुकिए");
  });

  it("exports one table of tail words and one of backchannel words", () => {
    for (const w of ["aur", "ki", "ke", "ko", "toh", "matlab", "ya", "jaise", "kyunki", "lekin"]) {
      expect(DANGLING_TAIL_WORDS.has(w), w).toBe(true);
    }
    expect(DANGLING_TAIL_WORDS.has("और")).toBe(true);
    expect(DANGLING_TAIL_WORDS.has("and")).toBe(true);
    expect(DANGLING_TAIL_WORDS.has("ruko")).toBe(false);
    for (const w of ["haan", "nahi", "ji", "theek", "achha", "hmm", "जी"]) {
      expect(BACKCHANNEL_WORDS.has(w), w).toBe(true);
    }
    expect(BACKCHANNEL_WORDS.has("aur")).toBe(false);
  });

  it("is one JSON file the kernel reads too: same lines, pinned hash", () => {
    const json = JSON.parse(
      readFileSync(resolve(__dirname, "../../config/hinglish-lexicon.json"), "utf8"),
    ) as { version: string; sureHindiAdded: Array<[string, string]> };
    expect(json.version).toBe("hinglish-lex-2");
    const lines = lexiconDataLines();
    expect(lines).toEqual([...lines].sort());
    const hash = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
    expect(lines.length).toBe(PINNED_LINES);
    expect(hash).toBe(PINNED_HASH);
    // The scorer's pinned view (lexiconLines, twer-vectors.json) reads the same sure-Hindi data, added words included.
    const added = json.sureHindiAdded.flatMap(([v]) => v.split("|"));
    const scored = new Set(lexiconLines().map((l) => l.split("|")[1]));
    for (const w of added) expect(scored.has(w), w).toBe(true);
    for (const w of ["ruko", "rukiye", "dekh", "ji"]) expect(scored.has(w), w).toBe(true);
  });
});

const PINNED_LINES = 308;
const PINNED_HASH = "739c3b0fb4d9ce2660ccc89111eff59014cddcc2e2faf4a94059cc899448fba2";
