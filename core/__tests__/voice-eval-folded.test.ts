/**
 * The folded scorer, the latency and flicker metrics, the bootstrap and the regression gate of
 * transcript-scorer.ts. Every vector is read from core/fixtures/voice-eval/fold-vectors.json, the same file
 * kernel/tests/test_stt_bench.py reads, so the Python and the TypeScript scorers cannot drift apart.
 * Synthetic text and timelines only: no audio, no model, no clock, no network.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateCounts,
  aggregateFlicker,
  aggregateLatency,
  bootstrapWer,
  flickerMetrics,
  foldToken,
  foldTokens,
  foldedCharErrorRate,
  foldedCounts,
  foldedWordErrorRate,
  latencyMetrics,
  matchErrorRate,
  pairedBootstrap,
  regressionGate,
  seeded,
  summariseLatency,
  wordErrorRate,
  type GateRow,
  type LatencyTimeline,
} from "../../src/lib/friday/voice-engine/transcript-scorer";

type GateSpec = {
  lang: string | string[];
  words: number[];
  edits: number[];
  violations?: number[];
};
const vectors = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/voice-eval/fold-vectors.json"), "utf8"),
) as {
  fold: Array<{ text: string; tokens: string[] }>;
  counts: Array<Record<string, number | string>>;
  mer: Array<{ id: string; mer: number }>;
  latency: Array<{ id: string; timeline: LatencyTimeline; expected: Record<string, unknown> }>;
  latencyBackwards: LatencyTimeline;
  latencySummary: Array<{ values: Array<number | null>; expected: Record<string, number | null> }>;
  flicker: Array<{
    id: string;
    partials: string[];
    final: string;
    expected: Record<string, number>;
  }>;
  seeded: Record<string, number[]>;
  bootstrap: {
    rows: Array<{ edits: number; total: number }>;
    seed: number;
    draws: number;
    expected: { estimate: number; low: number; high: number };
  };
  gate: Array<{
    id: string;
    baseline: GateSpec;
    candidate: GateSpec;
    pass: boolean;
    reasonIncludes: string[];
  }>;
};

function gateRows(spec: GateSpec): GateRow[] {
  return spec.words.map((words, i) => ({
    id: `u${i}`,
    lang: Array.isArray(spec.lang) ? spec.lang[i]! : spec.lang,
    words,
    edits: spec.edits[i]!,
    violations: spec.violations?.[i] ?? 0,
  }));
}

describe("the fold", () => {
  for (const c of vectors.fold) {
    it(`folds ${JSON.stringify(c.text)}`, () => {
      expect(foldTokens(c.text)).toEqual(c.tokens);
    });
  }

  it("leaves a word that is also a number word in another language alone", () => {
    expect(foldToken("do")).toBe("do");
    expect(foldToken("no")).toBe("no");
  });
});

describe("folded counts", () => {
  for (const c of vectors.counts) {
    it(`matches the hand-set vector ${c["id"]}`, () => {
      const got = foldedCounts(String(c["reference"]), String(c["hypothesis"])) as Record<
        string,
        number
      >;
      const { id: _id, reference: _r, hypothesis: _h, ...want } = c;
      expect(Object.fromEntries(Object.keys(want).map((k) => [k, got[k]]))).toEqual(want);
    });
  }

  it("is transliteration-insensitive where the strict rate is not", () => {
    const ref = "kal subah alarm laga do";
    const hyp = "कल सुबह अलार्म लगा दो";
    expect(wordErrorRate(ref, hyp)).toBe(1);
    expect(foldedWordErrorRate(ref, hyp)).toBe(0);
    expect(foldedCharErrorRate(ref, hyp)).toBe(0);
    expect(foldedWordErrorRate("send the report to rahul", "send the report to rohan")).toBe(0.2);
    expect(foldedWordErrorRate("", "")).toBe(0);
    expect(foldedWordErrorRate("", "x")).toBe(1);
    expect(foldedCharErrorRate("meeting", "meating")).toBeGreaterThan(0);
  });

  for (const c of vectors.mer) {
    it(`gives the match error rate for ${c.id}`, () => {
      const row = vectors.counts.find((x) => x["id"] === c.id)!;
      expect(matchErrorRate(String(row["reference"]), String(row["hypothesis"]))).toBeCloseTo(
        c.mer,
        10,
      );
    });
  }

  it("keeps the match error rate within 0 to 1 where WER passes 1", () => {
    expect(foldedWordErrorRate("a", "a b c d")).toBe(3);
    expect(matchErrorRate("a", "a b c d")).toBe(0.75);
  });
});

describe("latency from a timeline", () => {
  for (const c of vectors.latency) {
    it(`reads ${c.id}`, () => {
      expect(latencyMetrics(c.timeline)).toEqual(c.expected);
    });
  }

  it("refuses a timeline that runs backwards, has no start or an unknown event", () => {
    expect(() => latencyMetrics(vectors.latencyBackwards)).toThrow(/backwards/);
    expect(() =>
      latencyMetrics({ audioMs: 10, events: [{ t: 1, kind: "final", text: "x" }] }),
    ).toThrow(/speech_start/);
    expect(() =>
      latencyMetrics({ audioMs: 10, events: [{ t: 1, kind: "bogus" as never }] }),
    ).toThrow(/kind/);
  });

  for (const [i, c] of vectors.latencySummary.entries()) {
    it(`summarises with nearest-rank percentiles (case ${i})`, () => {
      expect(summariseLatency(c.values)).toEqual(c.expected);
    });
  }

  it("counts premature endpoints and unfinished turns across a set", () => {
    const out = aggregateLatency(vectors.latency.map((c) => c.timeline));
    expect(out.utterances).toBe(4);
    expect(out.prematureEndpoints).toBe(1);
    expect(out.unfinished).toBe(1);
    expect(out.timeToFirstPartialMs.n).toBe(3);
    expect(out.timeToFirstPartialMs.p50).toBe(300);
    expect(out.finalisationLagMs.n).toBe(3);
    expect(out.finalisationLagMs.p99).toBe(1500);
    expect(out.endpointLatencyMs.n).toBe(2);
    expect(out.rtf.n).toBe(2);
    expect(aggregateLatency([]).utterances).toBe(0);
  });
});

describe("flicker", () => {
  for (const c of vectors.flicker) {
    it(`counts ${c.id}`, () => {
      expect(flickerMetrics(c.partials, c.final)).toEqual(c.expected);
    });
  }

  it("adds up as revised over shown", () => {
    const out = aggregateFlicker(vectors.flicker.map((c) => flickerMetrics(c.partials, c.final)));
    expect(out.shownWords).toBe(17);
    expect(out.revisedWords).toBe(3);
    expect(out.revisions).toBe(3);
    expect(out.rate).toBeCloseTo(3 / 17, 12);
    expect(aggregateFlicker([]).rate).toBe(0);
  });
});

describe("bootstrap and the regression gate", () => {
  it("draws the same stream as the Python generator", () => {
    const draw = seeded(12345);
    expect([draw(), draw(), draw()].map((x) => Number(x.toFixed(10)))).toEqual(
      vectors.seeded["12345"],
    );
  });

  it("gives the seeded range of the shared vector", () => {
    const rows = vectors.bootstrap.rows.map((r) => ({ edits: r.edits, words: r.total }));
    const got = bootstrapWer(rows, {
      seed: vectors.bootstrap.seed,
      draws: vectors.bootstrap.draws,
    });
    expect(got.estimate).toBeCloseTo(vectors.bootstrap.expected.estimate, 12);
    expect(got.low).toBeCloseTo(vectors.bootstrap.expected.low, 12);
    expect(got.high).toBeCloseTo(vectors.bootstrap.expected.high, 12);
    expect(bootstrapWer(rows.slice(0, 1)).low).toBeNull();
    expect(bootstrapWer([]).estimate).toBe(0);
  });

  it("cancels the difficulty of each sentence in a paired comparison", () => {
    const base = [5, 40, 10, 60, 15, 30].map((edits, i) => ({ id: `u${i}`, words: 100, edits }));
    const worse = base.map((r) => ({ ...r, edits: r.edits + 3 }));
    const out = pairedBootstrap(base, worse, { seed: 3, draws: 500 });
    expect(out.delta).toBeCloseTo(0.03, 12);
    expect(out.low).toBeCloseTo(0.03, 12);
    expect(out.high).toBeCloseTo(0.03, 12);
    expect(out.excludesZero).toBe(true);
    const same = pairedBootstrap(base, base, { seed: 3, draws: 500 });
    expect(same.delta).toBe(0);
    expect(same.excludesZero).toBe(false);
    expect(() => pairedBootstrap(base, worse.slice(0, -1))).toThrow(/same utterances/);
  });

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
      if (c.pass) expect(out.reasons).toEqual([]);
    });
  }

  it("refuses two runs over different utterances", () => {
    const a = [{ id: "x", lang: "en", words: 5, edits: 0, violations: 0 }];
    const b = [{ id: "y", lang: "en", words: 5, edits: 0, violations: 0 }];
    const out = regressionGate(a, b);
    expect(out.pass).toBe(false);
    expect(out.reasons[0]).toContain("same utterances");
  });

  it("uses two points as the limit, and the limit can move", () => {
    const base = gateRows({ lang: "en", words: Array(8).fill(100), edits: Array(8).fill(10) });
    const cand = gateRows({ lang: "en", words: Array(8).fill(100), edits: Array(8).fill(11) });
    expect(regressionGate(base, cand).pass).toBe(true);
    expect(regressionGate(base, cand, { maxWerRise: 0.005 }).pass).toBe(false);
  });

  it("adds counts first and divides after, so a long sentence counts for more", () => {
    const rows = [
      {
        id: "a",
        lang: "en",
        ...foldedCounts("one two three four five six seven eight nine ten", "one two"),
      },
      { id: "b", lang: "en", ...foldedCounts("yes", "no") },
    ];
    const total = aggregateCounts(rows);
    expect(total.words).toBe(11);
    expect(total.edits).toBe(9);
    expect(total.foldedWer).toBeCloseTo(9 / 11, 12);
    expect(total.utterances).toBe(2);
  });
});
