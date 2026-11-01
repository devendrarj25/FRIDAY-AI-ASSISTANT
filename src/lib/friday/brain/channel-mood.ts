/**
 * FRIDAY · mood by channel
 *
 * The same sentence means different things typed and spoken, and the cues are different. Typed, she has the words,
 * emoji, punctuation, trailing dots, stretched letters and how fast his messages come. Spoken, she has the words as
 * transcribed (noisier, and fillers are sometimes kept), how his voice sounds against his own usual voice (pitch,
 * loudness, liveliness, measured by the kernel), how fast he spoke, and hesitation. This module turns each channel's
 * cues into small bumps on the owner's signals and says how a reply should be shaped for that channel.
 *
 * Everything here is a heuristic read, not a measurement of the owner. A voice cue alone never names a mood: it only
 * strengthens or softens what his words already say. Nothing leaves the PC, no audio is kept, and none of it is a
 * reason to act or a diagnosis.
 */

import type { UserSignal } from "./affect";
import { TONE_WARMUP, type VoiceTone } from "../voice-tone";

export type Channel = "chat" | "voice";
export type Bumps = Partial<Record<UserSignal, number>>;

const add = (bumps: Bumps, signal: UserSignal, amount: number) => {
  bumps[signal] = Math.min(1, (bumps[signal] ?? 0) + amount);
};

/** Typed cues: emoji, trailing dots, stretched letters. Words are read elsewhere. */
export function chatSignals(text: string): Bumps {
  const bumps: Bumps = {};
  const value = String(text || "");
  if (/[😡🤬😠👿💢]/u.test(value)) add(bumps, "frustration", 0.5);
  if (/[😢😭😞😔🥺💔]/u.test(value)) add(bumps, "low", 0.5);
  if (/[😴🥱]/u.test(value)) add(bumps, "low", 0.35);
  if (/[😰😨😱😬]/u.test(value)) add(bumps, "stress", 0.45);
  if (/[😂🤣😄😁🎉🥳]/u.test(value)) add(bumps, "excitement", 0.35);
  if (/[🙏👍❤]/u.test(value)) add(bumps, "satisfaction", 0.25);
  // "ok..." or "hmm…" at the end of a short message: trailing off, not shouting.
  if (value.trim().length < 40 && /(\.{3,}|…)\s*$/.test(value)) add(bumps, "low", 0.2);
  // "pleaseee", "jaldiiii", "yaaaar": stretched letters are a plea.
  if (/([a-z])\1{3,}/i.test(value)) add(bumps, "urgency", 0.2);
  return bumps;
}

/** Several quick messages in a row mean he is waiting, or is annoyed that nothing has come back yet. */
export function burstSignals(burst: number): Bumps {
  const bumps: Bumps = {};
  if (burst >= 3) {
    add(bumps, "urgency", 0.25);
    add(bumps, "stress", 0.15);
  }
  return bumps;
}

const FILLER = /\b(?:u+m+|u+h+|e+r+m*|hmm+|matlab|wo wo|aa+|ye ye)\b/gi;
const FINE_WORDS =
  /\b(?:fine|okay|ok|all good|theek hai|thik hai|chalega|koi baat nahi|kuch nahi)\b/i;
const NEGATIVE = new Set(["anger", "anxiety", "overwhelm", "distress"]);
const SOFT_NEGATIVE = new Set(["sadness", "tiredness", "disappointment"]);
const POSITIVE = new Set(["excitement", "relief", "gratitude"]);

let rateBaseline: number | null = null;

export function resetRateBaseline(): void {
  rateBaseline = null;
}

export type VoiceRead = {
  bumps: Bumps;
  /** What he said sounds fine, how he said it does not (or the other way round). */
  mismatch: boolean;
  /** Speed against his own usual speed, 1 = usual; null when it could not be measured. */
  rateRatio: number | null;
  hesitations: number;
};

/**
 * Spoken cues. Pitch, loudness and liveliness only count once his own baseline is learned (TONE_WARMUP utterances),
 * and they only add to what the words say: a quiet voice with sad words is stronger evidence than a quiet voice alone.
 */
export function voiceSignals(input: {
  tone: VoiceTone | null;
  text: string;
  speechMs?: number | null;
  /** The label `readFeeling` gave the words. */
  words: string;
}): VoiceRead {
  const bumps: Bumps = {};
  const { tone, text } = input;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  let rateRatio: number | null = null;
  if (input.speechMs && input.speechMs >= 800 && wordCount >= 3) {
    const rate = wordCount / (input.speechMs / 1000);
    rateRatio = rateBaseline ? rate / rateBaseline : 1;
    rateBaseline = rateBaseline ? rateBaseline + (rate - rateBaseline) * 0.15 : rate;
  }
  const hesitations = (text.match(FILLER) ?? []).length;
  if (hesitations >= 2) add(bumps, "confusion", 0.25);
  if (rateRatio !== null && rateRatio >= 1.35) add(bumps, "urgency", 0.25);
  if (rateRatio !== null && rateRatio <= 0.7) add(bumps, "low", 0.1);

  let mismatch = false;
  if (tone && tone.samples >= TONE_WARMUP) {
    const fine =
      FINE_WORDS.test(text) && !NEGATIVE.has(input.words) && !SOFT_NEGATIVE.has(input.words);
    if (tone.label === "tense") {
      add(bumps, "urgency", 0.2);
      add(bumps, "stress", 0.2);
      if (input.words === "anger") add(bumps, "frustration", 0.25);
      if (fine) mismatch = true;
    } else if (tone.label === "energetic") {
      if (POSITIVE.has(input.words)) add(bumps, "excitement", 0.2);
      else add(bumps, "urgency", 0.1);
    } else if (tone.label === "calm") {
      add(bumps, "low", SOFT_NEGATIVE.has(input.words) ? 0.3 : 0.1);
      if (fine && tone.arousal <= 0.25) mismatch = true;
    }
  }
  return { bumps, mismatch, rateRatio, hesitations };
}

/** How a reply should be shaped for the channel it will arrive on. */
export function channelDirective(channel: Channel): string {
  return channel === "voice"
    ? "This turn was SPOKEN and your answer will be read aloud: at most two short sentences, plain words, no lists, no markdown, no symbols, never read out a URL or a file path (say it is on screen), numbers the way a person says them, and at most one question. If he sounds tense or low, use a slower, softer line made of short sentences."
    : "This turn was TYPED: match the length of his message; a short structure is fine when it helps; do not repeat his words back to him. If he sent several quick messages, answer them together in one reply.";
}
