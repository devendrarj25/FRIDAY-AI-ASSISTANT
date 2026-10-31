/** A question about now favours the newest record; a question about the past does not. */
import { describe, expect, it } from "vitest";
import {
  recencyWeightFor,
  retrievalScore,
  temporalIntent,
  type RankSignals,
} from "../../src/lib/friday/brain/retrieval";

const NOW = Date.UTC(2026, 9, 30);
const DAY = 86_400_000;

const record = (ageDays: number, text: string): RankSignals => ({
  title: "owner city",
  text,
  confidence: 0.8,
  source: "user",
  provenance: "user",
  verified: true,
  updatedAt: NOW - ageDays * DAY,
  freshnessAt: NOW - ageDays * DAY,
});

describe("temporal intent", () => {
  it("reads now, then, and neither, in English and Hinglish", () => {
    expect(temporalIntent("where do I live right now")).toBe("current");
    expect(temporalIntent("abhi mera office kahan hai")).toBe("current");
    expect(temporalIntent("where did I live originally")).toBe("history");
    expect(temporalIntent("pehle kaun sa phone tha")).toBe("history");
    expect(temporalIntent("where do I live")).toBe("neutral");
    // History wins when both are said, so a past question is not pushed to the newest record.
    expect(temporalIntent("what was the latest thing I did before the move")).toBe("history");
  });

  it("keeps the long-standing weight for an ordinary question", () => {
    expect(recencyWeightFor("where do I live")).toBe(0.12);
    expect(recencyWeightFor("where do I live now")).toBeGreaterThan(0.12);
    expect(recencyWeightFor("where did I live earlier")).toBe(0);
  });
});

describe("ranking by time", () => {
  const fresh = record(2, "owner lives in Pune");
  const old = record(400, "owner lives in Jaipur");

  it("puts the newer record first for a question about now", () => {
    const q = "where does the owner live now";
    expect(retrievalScore(fresh, q, "", NOW)).toBeGreaterThan(retrievalScore(old, q, "", NOW));
  });

  it("does not favour the newer record for a question about the past", () => {
    const q = "where did the owner live originally";
    const gap = retrievalScore(fresh, q, "", NOW) - retrievalScore(old, q, "", NOW);
    const now = "where does the owner live now";
    const nowGap = retrievalScore(fresh, now, "", NOW) - retrievalScore(old, now, "", NOW);
    expect(gap).toBeLessThan(nowGap);
    expect(Math.abs(gap)).toBeLessThan(0.02);
  });
});
