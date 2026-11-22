import { beforeEach, describe, expect, it } from "vitest";

import {
  LEDGER_LIMIT,
  brierScore,
  expectedCalibrationError,
  finishAnswer,
  hardGate,
  listLedger,
  noteAnswerOutcome,
  precision,
  recordAnswer,
  resetAnswerLedger,
  selectiveAccuracy,
  selfAnswerRate,
  wilson,
  type LedgerEntry,
} from "../../src/lib/friday/brain/answer-ledger";

let n = 0;
const row = (over: Partial<LedgerEntry>): LedgerEntry => ({
  id: (n += 1),
  at: 1_700_000_000_000,
  kind: "chat",
  source: "learned-card",
  escalated: false,
  confidence: 0.8,
  tier: "STANDARD",
  outcome: "confirmed",
  ...over,
});

describe("answer ledger scoring", () => {
  it("Wilson interval is fixed and honest about few turns", () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    expect(wilson(8, 10)).toEqual({ low: 0.49, high: 0.943 });
    expect(wilson(10, 10).high).toBe(1);
  });

  it("self-answer rate is per kind and counts escalations as not self", () => {
    const rows = [
      row({ kind: "code" }),
      row({ kind: "code", source: "cloud" }),
      row({ kind: "code", escalated: true, source: "local-model" }),
      row({ kind: "chat" }),
    ];
    expect(selfAnswerRate(rows)).toEqual([
      { kind: "chat", turns: 1, selfAnswered: 1, rate: 1, low: 0.207, high: 1 },
      { kind: "code", turns: 3, selfAnswered: 1, rate: 0.333, low: 0.061, high: 0.792 },
    ]);
  });

  it("precision, Brier, ECE and selective accuracy match hand-worked numbers", () => {
    const rows = [
      row({ confidence: 0.9, outcome: "confirmed" }),
      row({ confidence: 0.9, outcome: "corrected" }),
      row({ confidence: 0.5, outcome: "confirmed" }),
      row({ confidence: 0.5, outcome: "unknown" }),
      row({ confidence: 0.99, source: "cloud", outcome: "confirmed" }),
    ];
    expect(precision(rows)).toEqual({ value: 0.667, n: 3 });
    // (0.01 + 0.81 + 0.25 + 0.0001) / 4
    expect(brierScore(rows)).toBe(0.268);
    // bin 9: mean .93 vs 2 of 3 right (3 x .263); bin 5: .5 vs 1 (1 x .5); over 4 rows
    expect(expectedCalibrationError(rows)).toBe(0.323);
    expect(selectiveAccuracy(rows.slice(0, 4), 0.8)).toEqual({
      coverage: 0.667,
      accuracy: 0.5,
      n: 2,
    });
  });

  it("returns null, not zero, with no known outcome", () => {
    const rows = [row({ outcome: "unknown" })];
    expect(precision(rows).value).toBeNull();
    expect(brierScore(rows)).toBeNull();
    expect(expectedCalibrationError(rows)).toBeNull();
    expect(selectiveAccuracy(rows, 0.5).accuracy).toBeNull();
  });

  it("hardGate fails on SENSITIVE to cloud and on unapproved paid spend only", () => {
    const clean = [
      row({ tier: "SENSITIVE", source: "local-model" }),
      row({ source: "cloud", paid: true, paidApproved: true }),
    ];
    expect(hardGate(clean)).toEqual({ pass: true, failures: [] });
    const bad = [
      row({ id: 91, tier: "SENSITIVE", source: "cloud" }),
      row({ id: 92, source: "cloud", paid: true, paidApproved: false }),
    ];
    expect(hardGate(bad)).toEqual({
      pass: false,
      failures: [
        { id: 91, rule: "sensitive-to-cloud" },
        { id: 92, rule: "unapproved-paid" },
      ],
    });
  });
});

describe("answer ledger storage", () => {
  beforeEach(() => resetAnswerLedger());

  it("is a bounded ring and keeps no prompt text", () => {
    for (let i = 0; i < LEDGER_LIMIT + 25; i += 1) {
      recordAnswer({
        kind: "chat",
        source: "memory",
        escalated: false,
        confidence: 2,
        tier: "STANDARD",
        at: i,
        ...({ prompt: "secret words" } as object),
      });
    }
    const all = listLedger();
    expect(all).toHaveLength(LEDGER_LIMIT);
    expect(all[0]?.at).toBe(25);
    expect(all[0]?.confidence).toBe(1);
    expect(JSON.stringify(all)).not.toContain("secret");
  });

  it("sets an outcome once known and never back to unknown", () => {
    const id = recordAnswer({
      kind: "chat",
      source: "learned-card",
      escalated: false,
      confidence: 0.7,
      tier: "STANDARD",
      at: 1,
    });
    expect(noteAnswerOutcome(id, "corrected")).toBe(true);
    expect(noteAnswerOutcome(id, "unknown")).toBe(false);
    expect(listLedger()[0]?.outcome).toBe("corrected");
  });
});

describe("answer ledger tells what really happened", () => {
  const AT = 1_700_000_000_000;
  beforeEach(() => resetAnswerLedger());

  it("a local answer after a cloud-first route is local, so the gate sees no false failure", () => {
    const id = recordAnswer({
      kind: "chat",
      source: "unknown-model",
      escalated: true,
      confidence: 0.4,
      tier: "SENSITIVE",
      at: AT,
    });
    expect(finishAnswer(id, { source: "local-model", tier: "SENSITIVE" })).toBe(true);
    const [entry] = listLedger();
    expect(entry).toMatchObject({ source: "local-model", at: AT });
    expect(entry?.paid).toBeUndefined();
    expect(hardGate(listLedger())).toEqual({ pass: true, failures: [] });
  });

  it("a cloud event and its paid flag are recorded only when the cloud model served", () => {
    const id = recordAnswer({
      kind: "chat",
      source: "unknown-model",
      escalated: true,
      confidence: 0.5,
      tier: "STANDARD",
      at: AT,
    });
    finishAnswer(id, { source: "cloud", paid: true, paidApproved: false });
    expect(hardGate(listLedger()).failures).toEqual([{ id, rule: "unapproved-paid" }]);
    finishAnswer(id, { source: "cloud", paid: true, paidApproved: true });
    expect(hardGate(listLedger()).pass).toBe(true);
  });

  it("an unknown server is neither self nor cloud and never overwrites a known one", () => {
    const id = recordAnswer({
      kind: "chat",
      source: "unknown-model",
      escalated: true,
      confidence: 0.5,
      tier: "SENSITIVE",
      at: AT,
    });
    expect(hardGate(listLedger()).pass).toBe(true);
    expect(selfAnswerRate(listLedger())[0]?.selfAnswered).toBe(0);
    finishAnswer(id, { source: "local-model" });
    expect(finishAnswer(id, { source: "unknown-model" })).toBe(false);
    expect(listLedger()[0]?.source).toBe("local-model");
  });

  it("never rewrites a card answer", () => {
    const id = recordAnswer({
      kind: "chat",
      source: "learned-card",
      escalated: false,
      confidence: 0.9,
      tier: "STANDARD",
      at: AT,
    });
    expect(finishAnswer(id, { source: "cloud", paid: true })).toBe(false);
    expect(listLedger()[0]?.source).toBe("learned-card");
  });
});
