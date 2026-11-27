import { describe, expect, it } from "vitest";
import { canonicalise } from "../../src/lib/friday/voice-engine/script-policy";
import { segmentCodemix } from "../../src/lib/friday/voice-engine/language-segmenter";
import { buildTurnRecord } from "../../src/lib/friday/voice-engine/stream-session";

const FACTS = {
  turnId: "t7",
  eagerText: "",
  speaker: null,
  env: null,
  clipped: false,
} as const;

describe("TurnRecord v2: the canonical transcript, its spans and the ASR band", () => {
  const raw = "  मुझे  कल का weather​ बताओ ,  please ";
  const record = buildTurnRecord({
    text: raw,
    textRaw: "mujhe kal ka weather batao",
    confidence: 0.9,
    eotWaitMs: 560,
    facts: FACTS,
  });

  it("is version 2", () => {
    expect(record.v).toBe(2);
  });

  it("carries the canonical text and the spans of the code-mixed line", () => {
    const canon = canonicalise(raw);
    expect(record.canonical).toBe(canon.text);
    expect(record.canonical).toBe("मुझे कल का weather बताओ, please");
    expect(record.spans).toEqual(segmentCodemix(canon.text));
    expect(record.spans.some((s) => s.lang === "hi")).toBe(true);
    expect(record.spans.some((s) => s.lang === "en")).toBe(true);
  });

  it("flags Hindi written in Latin letters", () => {
    expect(record.romanised).toBe(false);
    const roman = buildTurnRecord({ text: "mujhe kal ka mausam batao", facts: FACTS });
    expect(roman.romanised).toBe(true);
    expect(roman.canonical).toBe("mujhe kal ka mausam batao");
    const english = buildTurnRecord({ text: "open the calendar", facts: FACTS });
    expect(english.romanised).toBe(false);
  });

  it("keeps the wait the engine measured, or null", () => {
    expect(record.eotWaitMs).toBe(560);
    expect(buildTurnRecord({ text: "hi", facts: null }).eotWaitMs).toBeNull();
    for (const bad of [Number.NaN, -3, Number.POSITIVE_INFINITY, null]) {
      expect(buildTurnRecord({ text: "hi", eotWaitMs: bad, facts: null }).eotWaitMs).toBeNull();
    }
    expect(buildTurnRecord({ text: "hi", eotWaitMs: 480.4, facts: null }).eotWaitMs).toBe(480);
  });

  it.each([
    [1, "high"],
    [0.85, "high"],
    [0.849, "mid"],
    [0.6, "mid"],
    [0.599, "low"],
    [0, "low"],
    [null, "low"],
  ] as const)("confidence %s is band %s", (confidence, band) => {
    expect(buildTurnRecord({ text: "hello there", confidence, facts: null }).asrBand).toBe(band);
  });

  it("keeps every v1 field as it was", () => {
    expect(record).toMatchObject({
      text: raw,
      textRaw: "mujhe kal ka weather batao",
      lang: "hi-en",
      confidence: 0.9,
      turnId: "t7",
      eager: false,
      speaker: null,
      env: null,
      clipped: false,
      interruptedPlayedMs: null,
    });
  });

  it("an empty line gives an empty canonical text and no spans", () => {
    const empty = buildTurnRecord({ text: "", facts: null });
    expect(empty.canonical).toBe("");
    expect(empty.spans).toEqual([]);
    expect(empty.romanised).toBe(false);
  });

  it("the new fields are data: nothing in the record is a function", () => {
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});
