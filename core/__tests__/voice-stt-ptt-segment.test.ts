import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRE_ROLL_MS } from "../../src/lib/friday/pcm-capture";
import { PTT_LEAD_MAX_MS, pttCloseDecision, pttSegmentStart } from "../../src/lib/friday/voice-stt";

describe("a segment opened by a push-to-talk hold", () => {
  it("starts at the key-down, with the one pre-roll before it", () => {
    expect(pttSegmentStart(10_000, 400)).toEqual({
      startedMono: 9_600,
      pcmFrom: 9_600 - PRE_ROLL_MS,
    });
  });

  it("without a hold it starts where speech was heard, as before", () => {
    expect(pttSegmentStart(10_000, 0)).toEqual({
      startedMono: 10_000,
      pcmFrom: 10_000 - PRE_ROLL_MS,
    });
  });

  it("does not reach back further than the lead cap, or for a negative or junk hold", () => {
    expect(pttSegmentStart(50_000, 90_000).startedMono).toBe(50_000 - PTT_LEAD_MAX_MS);
    expect(pttSegmentStart(50_000, -5).startedMono).toBe(50_000);
    expect(pttSegmentStart(50_000, Number.NaN).startedMono).toBe(50_000);
  });
});

describe("when a push-to-talk segment closes", () => {
  const base = { pttSegment: true, capturing: true, silenceClose: false, tooLong: false };

  it("stays open through a pause while the key is down or in the release tail", () => {
    expect(pttCloseDecision({ ...base, silenceClose: true })).toEqual({ close: false, reason: "" });
  });

  it("is finalised at the end of the tail, even when the voice activity check is not quiet yet", () => {
    expect(pttCloseDecision({ ...base, capturing: false })).toEqual({
      close: true,
      reason: "push-to-talk released",
    });
    expect(pttCloseDecision({ ...base, capturing: false, silenceClose: true }).close).toBe(true);
  });

  it("is always cut at the segment cap, held or not", () => {
    expect(pttCloseDecision({ ...base, tooLong: true })).toEqual({
      close: true,
      reason: "segment closed",
    });
  });

  it("a segment that no hold opened closes on silence exactly as before", () => {
    const plain = { pttSegment: false, capturing: false, silenceClose: false, tooLong: false };
    expect(pttCloseDecision(plain)).toEqual({ close: false, reason: "" });
    expect(pttCloseDecision({ ...plain, silenceClose: true })).toEqual({
      close: true,
      reason: "silence",
    });
    // a key that is down in Always style does not hold such a segment open
    expect(pttCloseDecision({ ...plain, capturing: true, silenceClose: true }).close).toBe(true);
  });
});

describe("voice-stt wiring of the hold", () => {
  const source = readFileSync("src/lib/friday/voice-stt.ts", "utf8").replace(/\r\n/g, "\n");
  it("opens the clock from the key-down and closes through the one decision", () => {
    expect(source).toMatch(/pttSegmentStart\(performance\.now\(\), this\.pttLeadMs\(\)\)/);
    expect(source).toContain("pttCloseDecision({");
    expect(source).toMatch(/pttCapturing\(Date\.now\(\)/);
    expect(source).toMatch(/pttHeldForMs\(Date\.now\(\)\)/);
  });
  it("only follows the key when the listen style is push-to-talk", () => {
    expect(source).toMatch(/listenStyle[\s\S]{0,80}push-to-talk/);
  });
});
