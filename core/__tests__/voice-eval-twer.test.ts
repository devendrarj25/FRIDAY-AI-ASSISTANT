/**
 * T-WER, the switch-point error rate, the script-mismatch and policy counts, the Wilson ranges and the T-WER leg of
 * the regression gate of transcript-scorer.ts. Every vector is read from core/fixtures/voice-eval/twer-vectors.json,
 * the same file kernel/tests/test_stt_bench.py reads, so the Python and the TypeScript scorers cannot drift apart.
 * Synthetic text only: no audio, no model, no clock, no network.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateTwer,
  foldedCounts,
  regressionGate,
  twerCounts,
  twerTokens,
  twerWordErrorRate,
  TWER_LEXICON,
  wilsonRate,
  type GateRow,
} from "../../src/lib/friday/voice-engine/transcript-scorer";

type GateSpec = { lang: string | string[]; words: number[]; edits: number[]; twerEdits?: number[] };
const vectors = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/voice-eval/twer-vectors.json"), "utf8"),
) as {
  lexiconVersion: string;
  twerFold: Array<{ text: string; tokens: string[] }>;
  counts: Array<{
    id: string;
    reference: string;
    hypothesis: string;
    foldedEditsAtLeast?: number;
    twerEdits: number;
    switchPoints: number;
    switchErrors: number;
    policyFixes: number;
    hypWords: number;
  }>;
  aggregate: Record<string, number | string[]>;
  wilson: Array<{
    hits: number;
    total: number;
    estimate: number;
    low: number | null;
    high: number | null;
  }>;
  gate: Array<{
    id: string;
    baseline: GateSpec;
    candidate: GateSpec;
    pass: boolean;
    reasonIncludes: string[];
    reasonExcludes: string[];
  }>;
};

function gateRows(spec: GateSpec): GateRow[] {
  return spec.words.map((words, i) => ({
    id: `u${i}`,
    lang: Array.isArray(spec.lang) ? spec.lang[i]! : spec.lang,
    words,
    edits: spec.edits[i]!,
    violations: 0,
    ...(spec.twerEdits ? { twerEdits: spec.twerEdits[i]! } : {}),
  }));
}

describe("the T-WER fold", () => {
  it("names the lexicon it was made under", () => {
    expect(TWER_LEXICON).toBe(vectors.lexiconVersion);
  });

  for (const c of vectors.twerFold) {
    it(`folds ${JSON.stringify(c.text)}`, () => {
      expect(twerTokens(c.text)).toEqual(c.tokens);
    });
  }
});

describe("T-WER and the switch-point counts", () => {
  for (const c of vectors.counts) {
    it(`matches the hand-set vector ${c.id}`, () => {
      const got = twerCounts(c.reference, c.hypothesis);
      expect(got).toEqual({
        twerEdits: c.twerEdits,
        switchPoints: c.switchPoints,
        switchErrors: c.switchErrors,
        policyFixes: c.policyFixes,
        hypWords: c.hypWords,
      });
      if (c.foldedEditsAtLeast !== undefined) {
        const plain = foldedCounts(c.reference, c.hypothesis).edits;
        expect(plain).toBeGreaterThanOrEqual(c.foldedEditsAtLeast);
        expect(got.twerEdits).toBeLessThan(plain); // the plain fold cannot see a loanword spelled in Devanagari
      }
    });
  }

  it("is a rate over the reference words", () => {
    expect(
      twerWordErrorRate("mujhe meeting ki description chahiye", "मुझे मीटिंग की डिस्क्रिप्शन चाहिए"),
    ).toBe(0);
    expect(twerWordErrorRate("kal meeting hai", "कल hai")).toBeCloseTo(1 / 3, 12);
    expect(twerWordErrorRate("", "")).toBe(0);
    expect(twerWordErrorRate("", "x")).toBe(1);
  });
});

describe("Wilson ranges and the corpus numbers", () => {
  for (const c of vectors.wilson) {
    it(`gives the range of ${c.hits} of ${c.total}`, () => {
      const got = wilsonRate(c.hits, c.total);
      expect(got.estimate).toBeCloseTo(c.estimate, 12);
      if (c.low === null) expect(got.low).toBeNull();
      else expect(got.low).toBeCloseTo(c.low, 12);
      if (c.high === null) expect(got.high).toBeNull();
      else expect(got.high).toBeCloseTo(c.high, 12);
    });
  }

  it("adds counts first and divides after, with a range on every rate", () => {
    const spec = vectors.aggregate;
    const rows = (spec["ids"] as string[]).map((id) => {
      const c = vectors.counts.find((x) => x.id === id)!;
      return {
        ...foldedCounts(c.reference, c.hypothesis),
        ...twerCounts(c.reference, c.hypothesis),
      };
    });
    const out = aggregateTwer(rows);
    for (const key of ["twerEdits", "switchPoints", "switchErrors", "policyFixes", "hypWords"]) {
      expect((out as Record<string, unknown>)[key], key).toBe(spec[key]);
    }
    expect(out.twer).toBeCloseTo(spec["twer"] as number, 12);
    expect(out.switchPointErrorRate).toBe(spec["switchPointErrorRate"]);
    expect(out.lexicon).toBe(TWER_LEXICON);
    expect(out.switchPointErrorLow!).toBeLessThanOrEqual(out.switchPointErrorRate);
    expect(out.switchPointErrorHigh!).toBeGreaterThanOrEqual(out.switchPointErrorRate);
    expect(out.scriptMismatchLow!).toBeLessThanOrEqual(out.scriptMismatchRate);
    expect(out.policyFixHigh!).toBeGreaterThanOrEqual(out.policyFixRate);
    expect(out.twerLow!).toBeLessThanOrEqual(out.twer);
    const empty = aggregateTwer([]);
    expect(empty.twer).toBe(0);
    expect(empty.switchPointErrorLow).toBeNull();
    expect(empty.twerLow).toBeNull();
  });

  it("counts script mismatch among the words heard right, apart from the T-WER", () => {
    const ref = "kal subah alarm laga do";
    const hyp = "कल सुबह अलार्म लगा दो";
    const out = aggregateTwer([{ ...foldedCounts(ref, hyp), ...twerCounts(ref, hyp) }]);
    expect(out.twer).toBe(0);
    expect(out.scriptMismatchRate).toBe(1);
    expect(out.policyFixes).toBe(1);
  });
});

describe("the T-WER leg of the regression gate", () => {
  for (const c of vectors.gate) {
    it(`gate: ${c.id}`, () => {
      const out = regressionGate(gateRows(c.baseline), gateRows(c.candidate));
      expect(out.pass).toBe(c.pass);
      for (const needle of c.reasonIncludes) {
        expect(
          out.reasons.some((r) => r.includes(needle)),
          `${needle} in ${out.reasons.join(" | ")}`,
        ).toBe(true);
      }
      for (const needle of c.reasonExcludes) {
        expect(
          out.reasons.some((r) => r.includes(needle)),
          `${needle} must not be in ${out.reasons.join(" | ")}`,
        ).toBe(false);
      }
      if (c.pass) expect(out.reasons).toEqual([]);
    });
  }

  it("reports its numbers, or null for an older baseline", () => {
    const find = (id: string) => vectors.gate.find((c) => c.id === id)!;
    const alone = find("twer-regression-alone-fails");
    const leg = regressionGate(gateRows(alone.baseline), gateRows(alone.candidate)).groups["all"]!;
    expect(leg.twer).not.toBeNull();
    expect(leg.twer!.failed).toBe(true);
    expect(leg.twer!.excludesZero).toBe(true);
    expect(leg.twer!.baselineTwer).toBeCloseTo(0.1, 12);
    expect(leg.twer!.candidateTwer).toBeCloseTo(0.2, 12);
    expect(leg.failed).toBe(true);
    const old = find("older-baseline-without-twer-still-gates-on-folded-wer");
    const older = regressionGate(gateRows(old.baseline), gateRows(old.candidate));
    expect(older.groups["all"]!.twer).toBeNull();
  });

  it("moves its limit with the same setting as the folded limit", () => {
    const spec = (twerEdits: number) => ({
      lang: "hinglish",
      words: Array(8).fill(100) as number[],
      edits: Array(8).fill(10) as number[],
      twerEdits: Array(8).fill(twerEdits) as number[],
    });
    expect(regressionGate(gateRows(spec(10)), gateRows(spec(11))).pass).toBe(true);
    expect(regressionGate(gateRows(spec(10)), gateRows(spec(11)), { maxWerRise: 0.005 }).pass).toBe(
      false,
    );
  });
});
