import { rms } from "./speech-dsp";

export type VadFrame = { energy: number; zcr: number; flux: number; speech: boolean };

export function zeroCrossings(samples: ArrayLike<number>): number {
  let count = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1] ?? 0;
    const next = samples[i] ?? 0;
    if ((prev >= 0 && next < 0) || (prev < 0 && next >= 0)) count += 1;
  }
  return samples.length ? count / samples.length : 0;
}

export function frameVad(samples: Float32Array, frame = 160, previousEnergy = 0): VadFrame[] {
  const frames: VadFrame[] = [];
  let last = previousEnergy;
  for (let start = 0; start + frame <= samples.length; start += frame) {
    const slice = samples.subarray(start, start + frame);
    const energy = rms(slice);
    const zcr = zeroCrossings(slice);
    const flux = Math.abs(energy - last);
    last = energy;
    frames.push({ energy, zcr, flux, speech: false });
  }
  const energies = frames.map((row) => row.energy).sort((a, b) => a - b);
  const floor = energies[Math.floor(energies.length / 2)] ?? 0;
  let open = false;
  for (const row of frames) {
    const loud = row.energy > 0.05 && row.zcr < 0.45 && row.energy > floor * 0.9;
    const quiet = row.energy < Math.max(0.006, floor * 1.2);
    if (!open && loud) open = true;
    else if (open && quiet && row.flux < 0.02) open = false;
    row.speech = open;
  }
  return frames;
}

/** Hindi and Hinglish keep a longer hangover so a pause inside a word is not a turn end. */
export function hangoverFrames(language: string): number {
  const lang = language.toLowerCase();
  if (lang.startsWith("hi") || lang.includes("hinglish")) return 14;
  return 8;
}

export function endpointIndex(frames: VadFrame[], language: string): number {
  const hang = hangoverFrames(language);
  let lastSpeech = -1;
  frames.forEach((frame, index) => {
    if (frame.speech) lastSpeech = index;
  });
  if (lastSpeech < 0) return frames.length;
  const end = Math.min(frames.length, lastSpeech + hang);
  return end;
}

/**
 * Cut FRIDAY's playback when the owner starts. Do not cut a turn the owner
 * is already speaking.
 */
export function shouldCutPlayback(input: {
  ownerEnergy: number;
  playbackEnergy: number;
  ownerAlreadySpeaking: boolean;
}): boolean {
  if (input.ownerAlreadySpeaking) return false;
  if (input.playbackEnergy < 0.02) return false;
  return input.ownerEnergy > Math.max(0.03, input.playbackEnergy * 0.8);
}
