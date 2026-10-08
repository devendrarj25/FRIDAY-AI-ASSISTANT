/** Owner-started room calibration. Samples stay numbers. No audio is stored. */

export function noiseFloor(samples: readonly number[]): number {
  if (!samples.length) return 0.02;
  const sorted = samples
    .filter((n) => Number.isFinite(n))
    .slice()
    .sort((a, b) => a - b);
  if (!sorted.length) return 0.02;
  return sorted[Math.floor(sorted.length / 2)] ?? 0.02;
}

export function wakeThreshold(floor: number, calibrated: number | null): number {
  if (calibrated != null && calibrated > 0) return Math.min(0.9, Math.max(0.2, calibrated));
  return Math.min(0.85, Math.max(0.35, 0.45 + floor));
}

export function scoreWake(energy: number, threshold: number): "hit" | "miss" {
  return energy >= threshold ? "hit" : "miss";
}

/** Noise that crosses the threshold without a wake word is a false wake. */
export function falseWake(noiseEnergy: number, threshold: number): boolean {
  return noiseEnergy >= threshold;
}

export function wakeSelfTest(input: { energy: number; floor: number }): {
  pass: boolean;
  detail: string;
} {
  const threshold = wakeThreshold(input.floor, null);
  const mark = scoreWake(input.energy, threshold);
  return {
    pass: mark === "hit",
    detail:
      mark === "hit" ? "wake energy cleared the room floor" : "wake energy stayed under the floor",
  };
}
