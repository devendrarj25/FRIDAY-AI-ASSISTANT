/**
 * FRIDAY · emotional / context engine
 *
 * A persistent, simulated internal state. Two halves:
 *
 *  - what FRIDAY reads from the owner (mood, urgency, frustration, excitement,
 *    confusion, stress, satisfaction, importance, attention)
 *  - what FRIDAY herself is in (calm, focused, curious, concerned, happy,
 *    excited, thoughtful)
 *
 * These are behavioural states used to adapt tone and pacing. They are never
 * presented as human feelings or consciousness — the prompt fragment compiled
 * here says so explicitly.
 *
 * The engine is signal-driven: it reads the words the owner actually wrote and
 * the real outcomes of finished turns. It never invents a mood.
 */

import { readLocalState, restoreFromDisk, writeState } from "../persist";
import { getConversationSession } from "./conversation-state";
import {
  burstSignals,
  channelDirective,
  chatSignals,
  voiceSignals,
  type Channel,
} from "./channel-mood";
import type { VoiceTone } from "../voice-tone";
import { AFFECT_LEXICON, INTENSIFIERS, NEGATIONS } from "../data/affect-lexicon";

export type UserSignal =
  "urgency" | "frustration" | "excitement" | "confusion" | "stress" | "satisfaction" | "low";

export type FridayState =
  | "calm"
  | "focused"
  | "curious"
  | "concerned"
  | "happy"
  | "thoughtful"
  | "empathetic"
  | "frustrated"
  | "satisfied"
  | "cautious"
  | "excited";

export type InteractionState =
  | "neutral"
  | "focused"
  | "urgent"
  | "confused-user"
  | "frustrated-user"
  | "excited-user"
  | "satisfied-user"
  | "cautious"
  | "reflective"
  | "supportive"
  | "exploratory";

export type AffectState = {
  /** 0..1 per signal, decayed over time. */
  user: Record<UserSignal, number>;
  /** How much of the owner's attention this thread seems to have, 0..1. */
  attention: number;
  /** How important the current thread looks, 0..1. */
  importance: number;
  /** FRIDAY's own current behavioural state. */
  mood: FridayState;
  /** Interactional stance derived from conversation, not claimed emotion. */
  interaction: InteractionState;
  /** Consecutive failures observed — drives "concerned". */
  failures: number;
  /** The last readings of the owner's feeling, newest last. Labels only: never his words. */
  recent: { at: number; label: string }[];
  /** Which channel the last message arrived on. */
  channel: Channel;
  /** How the last spoken message sounded against his own usual voice; null for typed messages. */
  voice: { label: string; arousal: number; mismatch: boolean } | null;
  /** When the last message arrived, and how many came in a quick run. */
  lastAt: number | null;
  burst: number;
  /** Consecutive successes observed — drives "happy". */
  streak: number;
  updatedAt: number | null;
};

const STORAGE_KEY = "friday.brain.affect.v1";

const EMPTY_USER: Record<UserSignal, number> = {
  urgency: 0,
  frustration: 0,
  excitement: 0,
  confusion: 0,
  stress: 0,
  satisfaction: 0,
  low: 0,
};

const initial = (): AffectState => ({
  user: { ...EMPTY_USER },
  attention: 0.5,
  importance: 0.4,
  mood: "calm",
  interaction: "neutral",
  failures: 0,
  recent: [],
  channel: "chat",
  voice: null,
  lastAt: null,
  burst: 0,
  streak: 0,
  updatedAt: null,
});

/** Word/punctuation cues. Deliberately conservative — a miss beats a wrong read. */
const CUES: Record<UserSignal, RegExp> = {
  urgency:
    /\b(urgent|asap|now|quick(ly)?|immediately|hurry|deadline|jaldi|abhi|turant|bas kar do)\b/i,
  frustration:
    /\b(still|again|not working|broken|failed|useless|wrong|stuck|annoying|kaam nahi|nahi ho raha|ye galat)\b/i,
  excitement: /\b(awesome|great|amazing|love it|perfect|excited|wow|badhiya|mast)\b/i,
  confusion: /\b(confus\w*|don'?t understand|what does|why is|how do i|samajh nahi|kya matlab)\b/i,
  stress: /\b(everything|too many|overwhelm\w*|can'?t keep up|pressure|late|behind)\b/i,
  satisfaction: /\b(thanks|thank you|works|working now|fixed|nice|good job|shukriya|dhanyavaad)\b/i,
  low: /\b(feeling (down|low)|mood (off|kharab)|thak (gaya|gayi)|udaas)\b/i,
};

const RECENT_MAX = 12;

/** Which of his signals a read feeling raises, and how much. */
const FEELING_SIGNALS: Partial<Record<string, [UserSignal, number][]>> = {
  anger: [["frustration", 0.5]],
  anxiety: [["stress", 0.5]],
  overwhelm: [["stress", 0.55]],
  sadness: [["low", 0.55]],
  disappointment: [["low", 0.5]],
  tiredness: [
    ["low", 0.45],
    ["stress", 0.2],
  ],
  distress: [
    ["low", 0.9],
    ["stress", 0.7],
  ],
  excitement: [["excitement", 0.5]],
  relief: [
    ["satisfaction", 0.4],
    ["excitement", 0.2],
  ],
  gratitude: [["satisfaction", 0.45]],
  confusion: [["confusion", 0.5]],
  hurry: [["urgency", 0.5]],
};

const EXPLORING = /\b(what if|maybe|brainstorm|could we|idea|explore)\b/i;

const IMPORTANT =
  /\b(production|release|build|installer|exe|owner|critical|important|data|backup|money|client)\b/i;

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

const clone = (state: AffectState): AffectState => ({
  ...state,
  user: { ...state.user },
});

class AffectEngine {
  private state: AffectState = readLocalState<AffectState>(STORAGE_KEY) ?? initial();
  private snapshot: AffectState = clone(this.state);
  private listeners = new Set<() => void>();
  private exploring = false;
  private lastText = "";
  private pendingVoice: { tone: VoiceTone | null; speechMs: number | null; at: number } | null =
    null;

  /**
   * The next message that arrives was spoken. Called by the voice session right before it hands the transcript to the
   * brain, so the same entry point serves both channels; it lapses after twenty seconds so a later typed message is
   * never read as speech.
   */
  noteVoice(input: { tone: VoiceTone | null; speechMs?: number | null }): void {
    this.pendingVoice = { tone: input.tone, speechMs: input.speechMs ?? null, at: Date.now() };
  }

  constructor() {
    restoreFromDisk<AffectState>(STORAGE_KEY, (value) => {
      this.state = {
        ...initial(),
        ...value,
        user: { ...EMPTY_USER, ...value.user },
        interaction: value.interaction ?? "neutral",
        recent: Array.isArray(value.recent) ? value.recent.slice(-RECENT_MAX) : [],
        channel: value.channel === "voice" ? "voice" : "chat",
        voice: value.voice ?? null,
        lastAt: value.lastAt ?? null,
        burst: value.burst ?? 0,
      };
      this.commit(false);
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AffectState => this.snapshot;

  private commit(persist = true): void {
    this.state.updatedAt = Date.now();
    this.state.mood = this.deriveMood();
    this.state.interaction = this.deriveInteraction();
    this.snapshot = clone(this.state);
    if (persist) writeState(STORAGE_KEY, this.state);
    this.listeners.forEach((listener) => listener());
  }

  /** Everything fades: a bad five minutes should not colour the whole day. */
  private decay(factor = 0.75): void {
    for (const key of Object.keys(this.state.user) as UserSignal[]) {
      this.state.user[key] = clamp(this.state.user[key] * factor);
    }
  }

  private deriveInteraction(): InteractionState {
    const { user } = this.state;
    const corrections = (() => {
      try {
        return getConversationSession().correctionStreak;
      } catch {
        return 0;
      }
    })();
    if (corrections >= 2 || user.frustration > 0.65) return "frustrated-user";
    if (user.low > 0.45) return "supportive";
    if (this.exploring && user.frustration < 0.4) return "exploratory";
    if (user.urgency > 0.55) return "urgent";
    if (user.confusion > 0.5) return "confused-user";
    if (user.excitement > 0.55) return "excited-user";
    if (user.satisfaction > 0.5) return "satisfied-user";
    if (this.state.importance > 0.75 || corrections === 1) return "cautious";
    if (user.stress > 0.45) return "reflective";
    if (this.state.mood === "focused") return "focused";
    return "neutral";
  }

  private deriveMood(): FridayState {
    const { user, failures, streak } = this.state;
    if (failures >= 2 || user.frustration > 0.7) return "frustrated";
    if (user.low > 0.45 || (user.stress > 0.55 && user.frustration < 0.45)) return "empathetic";
    if (failures >= 1 || user.frustration > 0.6 || user.stress > 0.6) return "concerned";
    if (user.confusion > 0.5) return "thoughtful";
    if (user.urgency > 0.5) return "focused";
    if (user.excitement > 0.55) return "excited";
    if (streak >= 3 && user.satisfaction > 0.45) return "satisfied";
    if (this.state.importance > 0.75) return "cautious";
    if (user.excitement > 0.5 || (streak >= 3 && user.satisfaction > 0.3)) return "happy";
    if (this.state.importance > 0.7) return "focused";
    if (user.satisfaction > 0.4) return "curious";
    return "calm";
  }

  /** Read one thing the owner actually wrote. */
  observePrompt(text: string): AffectState {
    const prompt = (text ?? "").trim();
    if (!prompt) return this.snapshot;
    const now = Date.now();
    // The chat pipeline and the dispatcher can both look at one turn; it is read once.
    if (prompt === this.lastText && this.state.lastAt && now - this.state.lastAt < 3000)
      return this.snapshot;
    this.lastText = prompt;
    const spoken =
      this.pendingVoice && now - this.pendingVoice.at <= 20_000 ? this.pendingVoice : null;
    this.pendingVoice = null;
    const gap = this.state.lastAt ? now - this.state.lastAt : null;
    this.state.burst = !spoken && gap !== null && gap < 6000 ? this.state.burst + 1 : 0;
    this.state.lastAt = now;
    this.state.channel = spoken ? "voice" : "chat";
    this.decay();

    for (const key of Object.keys(CUES) as UserSignal[]) {
      if (CUES[key].test(prompt)) this.state.user[key] = clamp(this.state.user[key] + 0.45);
    }
    // The wider read: whole-word cues in English, Hinglish and Devanagari, with negation.
    const feeling = readFeeling(prompt, { failures: this.state.failures });
    for (const [signal, amount] of FEELING_SIGNALS[feeling.label] ?? []) {
      if (feeling.confidence >= 0.5)
        this.state.user[signal] = clamp(this.state.user[signal] + amount);
    }
    const channelBumps = spoken
      ? (() => {
          const read = voiceSignals({
            tone: spoken.tone,
            text: prompt,
            speechMs: spoken.speechMs,
            words: feeling.confidence >= 0.5 ? feeling.label : "neutral",
          });
          this.state.voice = spoken.tone
            ? { label: spoken.tone.label, arousal: spoken.tone.arousal, mismatch: read.mismatch }
            : null;
          return read.bumps;
        })()
      : { ...chatSignals(prompt), ...burstSignals(this.state.burst) };
    if (!spoken) this.state.voice = null;
    for (const [signal, amount] of Object.entries(channelBumps) as [UserSignal, number][]) {
      this.state.user[signal] = clamp(this.state.user[signal] + amount);
    }
    this.state.recent = [
      ...this.state.recent,
      { at: Date.now(), label: feeling.confidence >= 0.5 ? feeling.label : "neutral" },
    ].slice(-RECENT_MAX);
    // Punctuation and shouting are urgency/frustration signals of their own.
    if (/!{2,}|\?{2,}/.test(prompt)) this.state.user.urgency = clamp(this.state.user.urgency + 0.2);
    if (prompt.length > 24 && prompt === prompt.toUpperCase() && /[A-Z]{6,}/.test(prompt)) {
      this.state.user.urgency = clamp(this.state.user.urgency + 0.3);
    }

    this.state.importance = clamp(
      (IMPORTANT.test(prompt) ? 0.7 : 0.35) +
        this.state.user.urgency * 0.2 +
        this.state.user.stress * 0.1,
    );
    this.state.attention = clamp(prompt.length > 160 ? 0.9 : prompt.length > 40 ? 0.7 : 0.5);
    this.exploring = EXPLORING.test(prompt) && this.state.user.frustration < 0.4;
    this.commit();
    return this.snapshot;
  }

  /** Read a real outcome — never a claimed one. */
  observeOutcome(input: { ok: boolean; ms?: number }): AffectState {
    if (input.ok) {
      this.state.failures = 0;
      this.state.streak += 1;
      this.state.user.satisfaction = clamp(this.state.user.satisfaction + 0.2);
      this.state.user.frustration = clamp(this.state.user.frustration - 0.2);
    } else {
      this.state.streak = 0;
      this.state.failures += 1;
      this.state.user.frustration = clamp(this.state.user.frustration + 0.25);
    }
    this.commit();
    return this.snapshot;
  }

  /** The owner said a reading was wrong: forget what was read from his messages. Outcomes (failures, streak) stay. */
  forgetReadings(): AffectState {
    this.state.user = { ...EMPTY_USER };
    this.state.recent = [];
    this.state.importance = 0.4;
    this.exploring = false;
    this.commit();
    return this.snapshot;
  }

  /**
   * What the last messages add up to: not one reading, a pattern. "carrying" means the same hard feeling showed up in
   * at least three of the last six readings, so it is a mood he is in, not a passing word.
   */
  moodTrend(): { label: string; count: number; of: number; carrying: boolean } {
    const HARD = new Set([
      "anger",
      "anxiety",
      "sadness",
      "tiredness",
      "overwhelm",
      "disappointment",
    ]);
    const window = this.state.recent.slice(-6);
    const counts = new Map<string, number>();
    for (const row of window)
      if (HARD.has(row.label)) counts.set(row.label, (counts.get(row.label) ?? 0) + 1);
    let label = "neutral";
    let count = 0;
    for (const [name, n] of counts) if (n > count) [label, count] = [name, n];
    return { label, count, of: window.length, carrying: count >= 3 };
  }

  /** The strongest signals right now, for logs and the prompt fragment. */
  readSignals(): { signal: UserSignal; level: number }[] {
    return (Object.keys(this.state.user) as UserSignal[])
      .map((signal) => ({ signal, level: this.state.user[signal] }))
      .filter((entry) => entry.level >= 0.3)
      .sort((a, b) => b.level - a.level);
  }

  /**
   * The prompt fragment. Adapts tone and pacing without ever asserting that
   * FRIDAY literally feels anything.
   */
  prompt(): string {
    const signals = this.readSignals();
    const lines: string[] = [
      `Your current working state is "${this.state.mood}" (interaction "${this.state.interaction}"). This is a behavioural state that shapes your tone and pacing — it is simulated, and you must never claim to have human feelings or consciousness if asked.`,
    ];

    if (signals.length) {
      lines.push(
        `Read from the owner right now: ${signals
          .map((entry) => `${entry.signal} (${Math.round(entry.level * 100)}%)`)
          .join(", ")}.`,
      );
    }

    const guidance: string[] = [channelDirective(this.state.channel)];
    if (this.state.voice) {
      lines.push(
        `His voice sounded ${this.state.voice.label} against his own usual voice (arousal ${Math.round(this.state.voice.arousal * 100)}%). A cue for tone only: it never overrides what he said.`,
      );
      if (this.state.voice.mismatch)
        guidance.push(
          "His words say he is fine but his voice does not match. Do not contradict him or name it; keep the reply easy and unhurried, and leave room for him to say more.",
        );
    }
    if (this.state.user.urgency >= 0.4)
      guidance.push("He is in a hurry: lead with the answer or the fix, skip preamble.");
    if (this.state.user.frustration >= 0.4)
      guidance.push(
        "Something has been failing for him: acknowledge it once, plainly, then fix it. No apologising in loops, no cheerfulness, no restating the same answer.",
      );
    if (this.state.interaction === "frustrated-user" || this.state.interaction === "cautious")
      guidance.push(
        "Recent corrections: be more careful and concise. Incorporate the correction. Do not get defensive.",
      );
    if (this.state.interaction === "exploratory")
      guidance.push("He is exploring: stay collaborative, offer options, do not lock a decision.");
    if (this.state.interaction === "urgent")
      guidance.push("Direct answer first. Do not bury it under explanation.");
    if (this.state.user.confusion >= 0.4)
      guidance.push("He is unsure: slow down, use one concrete example, avoid jargon.");
    if (this.state.user.stress >= 0.4)
      guidance.push("He is loaded: give one next step, not a list of ten.");
    if (this.state.user.excitement >= 0.4 || this.state.user.satisfaction >= 0.4)
      guidance.push("He is pleased: match the energy briefly, then keep the work moving.");
    if (this.state.user.low >= 0.4)
      guidance.push(
        "He sounds low or tired: be gentle and short. No jokes, no lists, no cheerfulness. Say one plain, kind sentence about how it sounds, then offer to take one thing off his plate. Do not diagnose him, and do not claim to feel what he feels.",
      );
    const trend = this.moodTrend();
    if (trend.carrying)
      guidance.push(
        `He has sounded ${trend.label} for ${trend.count} of his last ${trend.of} messages: do not treat this as a fresh mood; keep the same calm, and once, lightly, ask if he wants the day made smaller.`,
      );
    if (this.state.importance >= 0.7)
      guidance.push("This thread matters: be precise and state what you verified.");
    if (!guidance.length)
      guidance.push(
        "Normal working tone: warm, brief, useful — like a colleague who already knows the brief.",
      );

    lines.push(...guidance);
    return lines.join("\n");
  }
}

export const affect = new AffectEngine();

export type FeelingLabel =
  | "neutral"
  | "anger"
  | "anxiety"
  | "sadness"
  | "excitement"
  | "gratitude"
  | "confusion"
  | "hurry"
  | "distress"
  | "sarcasm"
  | "tiredness"
  | "overwhelm"
  | "disappointment"
  | "relief";

export type Feeling = {
  label: FeelingLabel;
  valence: number;
  arousal: number;
  intensity: number;
  confidence: number;
};

const cueCache = new Map<string, RegExp>();

/** A cue matches whole words only ("down" must not fire inside "download"); Devanagari has no word-boundary escape, so letters are checked by property. */
function cueRegExp(pattern: string): RegExp {
  let rx = cueCache.get(pattern);
  if (!rx) {
    rx = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${pattern})(?![\\p{L}\\p{M}\\p{N}])`, "iu");
    cueCache.set(pattern, rx);
  }
  return rx;
}

/** Text-only read. Prosody is added by the caller and is not stored. */
export function readFeeling(
  text: string,
  context?: { failures?: number; hour?: number; prosody?: number },
): Feeling {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  let best: Feeling = { label: "neutral", valence: 0, arousal: 0.2, intensity: 0, confidence: 0.2 };
  const negated = NEGATIONS.test(lower);
  for (const row of AFFECT_LEXICON) {
    const hit = cueRegExp(row.pattern).test(lower);
    if (!hit) continue;
    const boost = (lower.match(new RegExp(INTENSIFIERS.source, "gi")) || []).length * 0.08;
    const caps = raw.length > 8 && raw === raw.toUpperCase() ? 0.1 : 0;
    const bangs = (raw.match(/!/g) || []).length > 1 ? 0.08 : 0;
    let confidence = Math.min(0.95, row.weight + boost + caps + bangs);
    if (negated && row.label !== "distress") confidence *= 0.35;
    if ((context?.failures ?? 0) >= 2 && (row.label === "anger" || row.label === "anxiety")) {
      confidence = Math.min(0.95, confidence + 0.05);
    }
    if (typeof context?.prosody === "number") {
      confidence = Math.min(0.95, confidence + Math.max(0, context.prosody) * 0.05);
    }
    const intensity = Math.min(1, row.arousal * 0.6 + confidence * 0.4);
    if (confidence > best.confidence) {
      best = {
        label: confidence < 0.45 ? "neutral" : row.label,
        valence: negated && row.label !== "distress" ? -row.valence * 0.2 : row.valence,
        arousal: row.arousal,
        intensity: confidence < 0.45 ? 0.1 : intensity,
        confidence,
      };
    }
  }
  if (best.confidence < 0.45) {
    return {
      label: "neutral",
      valence: 0,
      arousal: 0.2,
      intensity: 0.1,
      confidence: best.confidence,
    };
  }
  return best;
}

/** Read confusion/urgency from the current prompt without mutating affect state. */
export function readPromptSignals(text: string): { confusion: boolean; urgency: boolean } {
  const prompt = String(text || "");
  return {
    confusion: CUES.confusion.test(prompt),
    urgency: CUES.urgency.test(prompt),
  };
}
