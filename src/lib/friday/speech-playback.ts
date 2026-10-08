import { SampleRing, rms } from "./speech-dsp";
import { shouldCutPlayback } from "./speech-vad";

export function outputReachable(input: { deviceId: string; volume: number }): {
  ok: boolean;
  reason: string;
} {
  if (!input.deviceId) return { ok: false, reason: "no output device" };
  if (input.volume <= 0) return { ok: false, reason: "volume is zero" };
  return { ok: true, reason: "output looks reachable" };
}

export function playbackPlan(input: {
  samples: Float32Array;
  deviceId: string;
  volume: number;
  ownerEnergy: number;
  ownerAlreadySpeaking: boolean;
}): {
  ok: boolean;
  reason: string;
  duck: boolean;
  cut: boolean;
  dropped: number;
  referenceRms: number;
} {
  const device = outputReachable({ deviceId: input.deviceId, volume: input.volume });
  const ring = new SampleRing(Math.max(8, input.samples.length));
  const dropped = ring.push(input.samples);
  const referenceRms = rms(ring.snapshot());
  const cut = shouldCutPlayback({
    ownerEnergy: input.ownerEnergy,
    playbackEnergy: referenceRms,
    ownerAlreadySpeaking: input.ownerAlreadySpeaking,
  });
  return {
    ok: device.ok && !cut,
    reason: cut ? "owner started speaking" : device.reason,
    duck: device.ok && referenceRms > 0.01,
    cut,
    dropped,
    referenceRms,
  };
}

export function bargeBoundMs(): number {
  return 120;
}
