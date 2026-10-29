import { describe, expect, it } from "vitest";
import { suppressSelfVoice } from "../../src/lib/friday/voice-audio";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const voiceprint = require("../../electron/voiceprint.cjs") as {
  score: (
    probe: number[],
    enrolled: number[],
    threshold: number,
  ) => { execute: boolean; match: boolean; reason: string };
  enrol: (vector: number[]) => { ok: boolean; reason?: string };
  forget: () => { ok: boolean; enrolled: boolean };
};

describe("speaker score and self-voice", () => {
  it("scores a voiceprint without approving an action, and drops FRIDAY's own voice", () => {
    const same = voiceprint.score([1, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0], 0.75);
    expect(same.match).toBe(true);
    expect(same.execute).toBe(false);
    expect(same.reason).toBe("speaker-match");
    const other = voiceprint.score([1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0, 0], 0.75);
    expect(other.match).toBe(false);
    expect(other.execute).toBe(false);
    expect(voiceprint.enrol([1]).ok).toBe(false);
    expect(voiceprint.forget().enrolled).toBe(false);
    expect(suppressSelfVoice({ mic: [1, 0], playback: [1, 0], speaking: true })).toEqual({
      keep: false,
      reason: "self-voice",
    });
    expect(suppressSelfVoice({ mic: [1, 0], playback: [0, 1], speaking: true }).reason).toBe(
      "owner",
    );
    expect(suppressSelfVoice({ mic: [1, 0], playback: [1, 0], speaking: false }).reason).toBe(
      "quiet",
    );
  });
});
