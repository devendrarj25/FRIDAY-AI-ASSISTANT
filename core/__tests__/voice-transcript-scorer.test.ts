/**
 * The offline recogniser scorer: word and character error, the confidence range, the script mismatch and
 * the latency against the 800 ms budget. Synthetic text only; the same fixture is read by the Python test
 * for `kernel/stt_bench.py`, so the two scorers agree on every case.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WER_TARGETS,
  charErrorRate,
  dominantScript,
  editDistance,
  normaliseTranscript,
  percentile,
  rankEngines,
  scoreEngine,
  scriptMismatch,
  wordCounts,
  wordErrorRate,
  type ScoredSample,
  type SpeechLang,
} from "../../src/lib/friday/voice-engine/transcript-scorer";
import { LATENCY_BUDGET_MS } from "../../src/lib/friday/voice-engine/latency-monitor";

type Case = {
  id: string;
  lang: SpeechLang;
  reference: string;
  hypothesis: string;
  refWords: number;
  wordEdits: number;
};
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/voice-wer-cases.json"), "utf8"),
) as { cases: Case[] };

describe("the shared fixture", () => {
  it("covers Hindi, English and Hinglish with at least 8 cases each", () => {
    for (const lang of ["hi", "en", "hinglish"] as const) {
      expect(fixture.cases.filter((c) => c.lang === lang).length, lang).toBeGreaterThanOrEqual(8);
    }
  });

  it("gets the hand-set edit count and reference length for every case", () => {
    for (const c of fixture.cases) {
      expect(wordCounts(c.reference, c.hypothesis), c.id).toEqual({
        edits: c.wordEdits,
        words: c.refWords,
      });
    }
  });
});

describe("normalising", () => {
  it("ignores case, punctuation, the danda and Devanagari digits", () => {
    expect(normaliseTranscript("  Namaste,  DUNIYA!  ")).toBe("namaste duniya");
    expect(normaliseTranscript("मेरे २ दोस्त हैं।")).toBe("मेरे 2 दोस्त हैं");
    expect(normaliseTranscript("kal ki meeting — 5 baje")).toBe("kal ki meeting 5 baje");
  });

  it("does not split a Hindi word that carries a vowel sign", () => {
    expect(normaliseTranscript("मौसम, अच्छा!").split(" ")).toEqual(["मौसम", "अच्छा"]);
  });
});

describe("error rates", () => {
  it("counts a substitution, a deletion and an insertion as one edit each", () => {
    expect(editDistance(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
    expect(editDistance(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(editDistance(["a", "c"], ["a", "b", "c"])).toBe(1);
  });

  it("scores an empty reference 0 when nothing was heard and 1 otherwise", () => {
    expect(wordErrorRate("", "")).toBe(0);
    expect(wordErrorRate("", "noise")).toBe(1);
    expect(charErrorRate("", "")).toBe(0);
    expect(wordErrorRate("stop", "")).toBe(1);
  });

  it("scores characters by code point, not by UTF-16 unit", () => {
    expect(charErrorRate("क", "क")).toBe(0);
    expect(charErrorRate("meeting", "meating")).toBeCloseTo(1 / 7, 5);
  });
});

describe("script", () => {
  it("names the script and flags only a clean swap", () => {
    expect(dominantScript("मुझे चाय चाहिए")).toBe("devanagari");
    expect(dominantScript("mujhe chai chahiye")).toBe("latin");
    expect(dominantScript("Chrome खोलो और report भेजो")).toBe("mixed");
    expect(dominantScript("12 34")).toBe("none");
    expect(scriptMismatch("मुझे चाय चाहिए", "mujhe chai chahiye")).toBe(true);
    expect(scriptMismatch("Chrome खोलो", "chrome खोलो")).toBe(false);
    expect(scriptMismatch("kal subah", "kal subah")).toBe(false);
  });
});

describe("scoring an engine", () => {
  const samples: ScoredSample[] = fixture.cases.map((c, i) => ({
    id: c.id,
    lang: c.lang,
    reference: c.reference,
    hypothesis: c.hypothesis,
    ms: 300 + i * 40,
  }));

  it("reports total edits over total reference words, per language and overall", () => {
    const report = scoreEngine(samples);
    const total = (lang?: SpeechLang) => {
      const rows = fixture.cases.filter((c) => !lang || c.lang === lang);
      return rows.reduce((s, c) => s + c.wordEdits, 0) / rows.reduce((s, c) => s + c.refWords, 0);
    };
    expect(report.overall.corpusWer).toBeCloseTo(total(), 10);
    for (const lang of ["hi", "en", "hinglish"] as const) {
      expect(report.byLang[lang]?.corpusWer, lang).toBeCloseTo(total(lang), 10);
    }
    expect(report.overall.samples).toBe(fixture.cases.length);
  });

  it("gives the same range on every run, and a range that contains the point value", () => {
    const a = scoreEngine(samples).overall;
    const b = scoreEngine(samples).overall;
    expect(a.corpusWerRange).toEqual(b.corpusWerRange);
    expect(a.corpusWerRange!.low).toBeLessThanOrEqual(a.corpusWer + 1e-9);
    expect(a.corpusWerRange!.high).toBeGreaterThanOrEqual(a.corpusWer - 1e-9);
  });

  it("gives no range for a single sentence, and a wide exact-match interval for a small set", () => {
    const one = scoreEngine(samples.slice(0, 1)).overall;
    expect(one.corpusWerRange).toBeNull();
    const exact = scoreEngine(samples).overall;
    expect(exact.exactRange.high - exact.exactRange.low).toBeGreaterThan(0.2);
    expect(exact.exact).toBe(fixture.cases.filter((c) => c.wordEdits === 0).length);
  });

  it("counts the script mismatch and does not hide it inside the error", () => {
    const report = scoreEngine(samples);
    expect(report.byLang.hi?.scriptMismatches).toBe(1);
    expect(report.byLang.en?.scriptMismatches).toBe(0);
  });

  it("measures latency against the 800 ms budget", () => {
    expect(LATENCY_BUDGET_MS).toBe(800);
    const slow: ScoredSample[] = [
      { id: "a", lang: "en", reference: "hi", hypothesis: "hi", ms: 500 },
      { id: "b", lang: "en", reference: "hi", hypothesis: "hi", ms: 800 },
      { id: "c", lang: "en", reference: "hi", hypothesis: "hi", ms: 1400 },
    ];
    const latency = scoreEngine(slow).overall.latency!;
    expect(latency).toMatchObject({ measured: 3, p50: 800, p95: 1400, withinBudget: 2 });
    expect(scoreEngine(samples.map(({ ms: _ms, ...rest }) => rest)).overall.latency).toBeNull();
  });

  it("calls a language within, uncertain or over its target", () => {
    expect(WER_TARGETS.en).toBeLessThan(WER_TARGETS.hi);
    const perfect = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      lang: "en" as const,
      reference: "open the door now",
      hypothesis: "open the door now",
    }));
    expect(scoreEngine(perfect).verdicts.en).toBe("within");
    const bad = perfect.map((s) => ({ ...s, hypothesis: "open a floor" }));
    expect(scoreEngine(bad).verdicts.en).toBe("over");
    const borderline = perfect.map((s, i) => ({
      ...s,
      hypothesis: i < 2 ? "open the door" : s.hypothesis,
    }));
    expect(["within", "uncertain"]).toContain(scoreEngine(borderline).verdicts.en);
    const few = [...perfect.slice(0, 3), { ...perfect[0]!, id: "x", hypothesis: "open the door" }];
    expect(scoreEngine(few).verdicts.en).not.toBeUndefined();
  });

  it("ranks the engine with the lower error first and an empty engine last", () => {
    const good = samples.map((s) => ({ ...s, hypothesis: s.reference }));
    const ranked = rankEngines({ none: [], noisy: samples, clean: good });
    expect(ranked.map((row) => row.engine)).toEqual(["clean", "noisy", "none"]);
  });
});

describe("percentile", () => {
  it("is nearest-rank and null for no values", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });
});
