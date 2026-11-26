/**
 * The Hindi and English word lexicon and the script policy (src/lib/friday/voice-engine/hinglish-lexicon.ts).
 * Every vector is read from core/fixtures/voice-eval/twer-vectors.json, the same file kernel/tests/test_stt_bench.py
 * reads, so the two copies of the tables cannot drift apart. Synthetic text only: no audio, no model, no network.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fixScript,
  labelLanguages,
  LEXICON_VERSION,
  lexiconKey,
  lexiconLines,
  type ScriptPolicy,
  type WordLanguage,
} from "../../src/lib/friday/voice-engine/hinglish-lexicon";

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/voice-eval/twer-vectors.json"), "utf8"),
) as {
  lexiconVersion: string;
  lexiconDigest: { entries: number; sha256: string };
  fix: Array<{ id: string; text: string; policy: ScriptPolicy; expected: string }>;
  label: Array<{ cores: string[]; langs: WordLanguage[] }>;
};

describe("the lexicon tables", () => {
  it("are the same table as the Python copy (version, size and hash)", () => {
    const lines = lexiconLines();
    expect(LEXICON_VERSION).toBe(vectors.lexiconVersion);
    expect(lines.length).toBe(vectors.lexiconDigest.entries);
    expect(createHash("sha256").update(lines.join("\n"), "utf8").digest("hex")).toBe(
      vectors.lexiconDigest.sha256,
    );
  });

  it("keep Hindi and English words that look alike out of the sure list", () => {
    const sure = new Set(
      lexiconLines()
        .filter((l) => l.startsWith("sure|"))
        .map((l) => l.split("|")[1]),
    );
    for (const word of [
      "do",
      "main",
      "to",
      "me",
      "hai",
      "hum",
      "par",
      "band",
      "hi",
      "mat",
      "din",
    ]) {
      expect(sure.has(word), word).toBe(false);
    }
    const ambiguous = new Set(
      lexiconLines()
        .filter((l) => l.startsWith("ambiguous|"))
        .map((l) => l.split("|")[1]),
    );
    for (const word of ["do", "main", "to", "me", "hai"])
      expect(ambiguous.has(word), word).toBe(true);
  });

  it("fold the nukta and the chandrabindu on lookup", () => {
    expect(lexiconKey("फ़ोन")).toBe(lexiconKey("फोन"));
    expect(lexiconKey("कँप्यूटर")).toBe(lexiconKey("कंप्यूटर"));
    expect(lexiconKey("Meeting")).toBe("meeting");
  });
});

describe("fixScript", () => {
  for (const c of vectors.fix) {
    it(`${c.id} (${c.policy})`, () => {
      expect(fixScript(c.text, c.policy)).toBe(c.expected);
    });
  }

  it("defaults to the codemix policy: Hindi in Devanagari, English in Latin", () => {
    expect(fixScript("kal मीटिंग")).toBe("कल meeting");
  });

  it("is idempotent, except where one ambiguous word leans on another (the second pass sees the turned word)", () => {
    for (const c of vectors.fix) {
      const once = fixScript(c.text, c.policy);
      const twice = fixScript(once, c.policy);
      if (c.id === "two-ambiguous-words-do-not-prove-each-other") expect(twice).toBe("में तो ठीक");
      else expect(twice, c.id).toBe(once);
    }
  });

  it("never touches a word that is not in the tables", () => {
    expect(fixScript("Supertonic xyzzy क़िताब")).toBe("Supertonic xyzzy क़िताब");
  });

  it("keeps the words in place, one for one", () => {
    const text = "mujhe  meeting\tki description chahiye.";
    expect(fixScript(text).split(/\s+/)).toHaveLength(text.split(/\s+/).length);
  });
});

describe("labelLanguages", () => {
  for (const c of vectors.label) {
    it(`labels ${JSON.stringify(c.cores)}`, () => {
      expect(labelLanguages(c.cores)).toEqual(c.langs);
    });
  }
});
