import { describe, expect, it } from "vitest";

import { advanceVad, type VadMemory } from "../../src/lib/friday/voice-audio";

const FRAME_MS = 1000 / 60;

type Run = { worstDropMs: number; started: boolean; floorAfter: number; speechAtEnd: boolean };

/** Drive advanceVad the way the capture loop does: 60 frames a second, state carried from frame to frame. */
function drive(levels: number[], settleFrames = 90): Run {
  let floor = 0;
  let voiceFrames = 0;
  let memory: VadMemory | undefined;
  let dropMs = 0;
  let worst = 0;
  let started = false;
  let speech = false;
  const step = (level: number) => {
    const out = advanceVad({
      level,
      noiseFloor: floor,
      voiceFrames,
      speakingGuard: false,
      ducked: false,
      dtMs: FRAME_MS,
      ...(memory ? { memory } : {}),
    });
    floor = out.noiseFloor;
    voiceFrames = out.voiceFrames;
    memory = out.memory;
    speech = out.speech;
  };
  for (let i = 0; i < settleFrames; i += 1) step(0.002);
  for (const level of levels) {
    step(level);
    if (speech) {
      started = true;
      worst = Math.max(worst, dropMs);
      dropMs = 0;
    } else if (started) dropMs += FRAME_MS;
  }
  worst = Math.max(worst, dropMs);
  return { worstDropMs: worst, started, floorAfter: floor, speechAtEnd: speech };
}

const modulated = (rms: number, depth: number, seconds: number): number[] =>
  Array.from(
    { length: Math.round(seconds * 60) },
    (_, i) => rms * (1 + depth * Math.sin((2 * Math.PI * 4 * i) / 60)),
  );

describe("the noise floor does not climb into speech", () => {
  for (const rms of [0.02, 0.05, 0.1]) {
    for (const depth of [0, 0.3, 0.6]) {
      it(`8 s of speech at ${rms} RMS, depth ${depth}, never drops for over 200 ms`, () => {
        const run = drive(modulated(rms, depth, 8));
        expect(run.started).toBe(true);
        expect(run.worstDropMs).toBeLessThanOrEqual(200);
        expect(run.speechAtEnd).toBe(true);
      });
    }
  }

  it("the floor does not rise while speech is on, nor for about half a second after", () => {
    const loud = modulated(0.05, 0, 3);
    const run = drive(loud);
    expect(run.floorAfter).toBeLessThan(0.01);
    // Speech stops: for 400 ms the floor stays where it was even if the room is a little louder than it.
    const tail = [...loud, ...Array.from({ length: 24 }, () => 0.012)];
    expect(drive(tail).floorAfter).toBeLessThan(0.01);
  });

  it("a steady fan is still learned as the floor, slowly, once speech has gone on far too long", () => {
    const fan = Array.from({ length: 60 * 40 }, () => 0.03);
    const run = drive(fan);
    expect(run.speechAtEnd).toBe(false);
    expect(run.floorAfter).toBeGreaterThan(0.02);
  });

  it("a quiet room that gets a little louder when nobody speaks still drifts up slowly", () => {
    const room = Array.from({ length: 60 * 20 }, () => 0.0035);
    const run = drive(room);
    expect(run.floorAfter).toBeGreaterThan(0.003);
    expect(run.speechAtEnd).toBe(false);
  });

  it("after a fan has been learned and stops, speech is heard again at once", () => {
    const levels = [
      ...Array.from({ length: 60 * 40 }, () => 0.03),
      ...Array.from({ length: 60 }, () => 0.002),
      ...modulated(0.05, 0.3, 1),
    ];
    const run = drive(levels);
    expect(run.speechAtEnd).toBe(true);
  });
});
