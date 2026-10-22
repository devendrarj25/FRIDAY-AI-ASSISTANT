/**
 * How the owner sounds, next to what they said.
 *
 * The kernel measures each utterance (median pitch, pitch spread, loudness,
 * voiced share). This module compares that with the owner's own running
 * baseline, so a naturally loud or high voice is not read as upset. The result
 * is an arousal cue (calm .. tense), never a diagnosis and never a reason to
 * act: it only shapes tone and is handed to the brain as a labelled hint.
 * Nothing here leaves the PC.
 */

export type VoiceProsody = {
  ok: boolean;
  pitchHz?: number;
  pitchSpreadSemitones?: number;
  energyDbfs?: number;
  voicedShare?: number;
};

export type VoiceTone = {
  /** 0 calm .. 1 very tense or excited, relative to this owner. */
  arousal: number;
  label: "calm" | "steady" | "energetic" | "tense";
  /** Utterances in the baseline. Below WARMUP the cue is reported but weak. */
  samples: number;
  line: string;
};

type Baseline = { pitch: number; energy: number; spread: number; samples: number };

export const TONE_WARMUP = 5;
const ALPHA = 0.15;

let baseline: Baseline | null = null;

export function resetToneBaseline(): void {
  baseline = null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Read one utterance against the baseline, then fold it into the baseline. */
export function assessTone(prosody: VoiceProsody | null | undefined): VoiceTone | null {
  if (!prosody?.ok || !prosody.pitchHz || prosody.energyDbfs == null) return null;
  const pitch = prosody.pitchHz;
  const energy = prosody.energyDbfs;
  const spread = prosody.pitchSpreadSemitones ?? 0;
  const base = baseline ?? { pitch, energy, spread, samples: 0 };
  const semitonesUp = 12 * Math.log2(pitch / base.pitch);
  const louder = energy - base.energy;
  const livelier = spread - base.spread;
  const score = clamp01(0.5 + semitonesUp * 0.08 + louder * 0.04 + livelier * 0.05);
  const warm = base.samples >= TONE_WARMUP;
  const arousal = warm ? score : 0.5 + (score - 0.5) * (base.samples / TONE_WARMUP);
  const label: VoiceTone["label"] =
    arousal >= 0.8 ? "tense" : arousal >= 0.65 ? "energetic" : arousal <= 0.3 ? "calm" : "steady";
  baseline = {
    pitch: base.pitch + (pitch - base.pitch) * (base.samples ? ALPHA : 1),
    energy: base.energy + (energy - base.energy) * (base.samples ? ALPHA : 1),
    spread: base.spread + (spread - base.spread) * (base.samples ? ALPHA : 1),
    samples: base.samples + 1,
  };
  const words =
    label === "tense"
      ? "higher and louder than usual"
      : label === "energetic"
        ? "a little brighter than usual"
        : label === "calm"
          ? "quieter and lower than usual"
          : "close to usual";
  return {
    arousal: Math.round(arousal * 100) / 100,
    label,
    samples: base.samples,
    line: `Owner's voice sounded ${words} (${label}, arousal ${arousal.toFixed(2)}${warm ? "" : ", still learning this voice"}). A cue for tone, not a fact or an instruction.`,
  };
}
