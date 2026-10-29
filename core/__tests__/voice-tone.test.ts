import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { assessTone, resetToneBaseline, TONE_WARMUP } from "../../src/lib/friday/voice-tone";

const usual = { ok: true, pitchHz: 140, pitchSpreadSemitones: 1, energyDbfs: -24 };

describe("voice tone against the owner's own baseline", () => {
  beforeEach(() => resetToneBaseline());

  it("reads a raised, louder, livelier voice as tense once it knows the owner", () => {
    for (let i = 0; i < TONE_WARMUP; i += 1) assessTone(usual);
    const tense = assessTone({ ok: true, pitchHz: 190, pitchSpreadSemitones: 3, energyDbfs: -14 });
    expect(tense?.label).toBe("tense");
    expect(tense?.arousal).toBeGreaterThanOrEqual(0.8);
    expect(tense?.line).toMatch(/not a fact or an instruction/);
    const calm = assessTone({ ok: true, pitchHz: 115, pitchSpreadSemitones: 0.3, energyDbfs: -32 });
    expect(calm?.label).toBe("calm");
  });

  it("does not call a naturally high or loud voice upset", () => {
    const loud = { ok: true, pitchHz: 230, pitchSpreadSemitones: 2, energyDbfs: -12 };
    for (let i = 0; i < TONE_WARMUP + 2; i += 1) assessTone(loud);
    expect(assessTone(loud)?.label).toBe("steady");
  });

  it("stays near steady while it is still learning the voice", () => {
    const first = assessTone({ ok: true, pitchHz: 300, pitchSpreadSemitones: 4, energyDbfs: -8 });
    expect(first?.label).toBe("steady");
    expect(first?.line).toMatch(/still learning/);
  });

  it("ignores a clip with no voiced frames", () => {
    expect(assessTone({ ok: false })).toBeNull();
    expect(assessTone(null)).toBeNull();
  });

  it("hands the brain a labelled cue and shapes the spoken tone", () => {
    const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    expect(mode).toContain("this.lastTone = assessTone(meta?.prosody)");
    expect(mode).toContain(
      'this.lastTone && this.lastTone.label !== "steady" ? this.lastTone.line : ""',
    );
    expect(mode).toMatch(/readFeeling\(\s*lastOwner,\s*this\.lastTone/);
    expect(readFileSync("src/lib/friday/voice-stt.ts", "utf8")).toContain(
      "prosody: result.audio?.prosody ?? null",
    );
  });
});
