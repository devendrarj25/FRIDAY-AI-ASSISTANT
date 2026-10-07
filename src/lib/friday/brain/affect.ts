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

export type UserSignal =
  "urgency" | "frustration" | "excitement" | "confusion" | "stress" | "satisfaction";

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
};

const initial = (): AffectState => ({
  user: { ...EMPTY_USER },
  attention: 0.5,
  importance: 0.4,
  mood: "calm",
  interaction: "neutral",
  failures: 0,
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

  constructor() {
    restoreFromDisk<AffectState>(STORAGE_KEY, (value) => {
      this.state = {
        ...initial(),
        ...value,
        user: { ...EMPTY_USER, ...value.user },
        interaction: value.interaction ?? "neutral",
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
    if (user.stress > 0.55 && user.frustration < 0.45) return "empathetic";
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
    this.decay();

    for (const key of Object.keys(CUES) as UserSignal[]) {
      if (CUES[key].test(prompt)) this.state.user[key] = clamp(this.state.user[key] + 0.45);
    }
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

    const guidance: string[] = [];
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

/** Read confusion/urgency from the current prompt without mutating affect state. */
export function readPromptSignals(text: string): { confusion: boolean; urgency: boolean } {
  const prompt = String(text || "");
  return {
    confusion: CUES.confusion.test(prompt),
    urgency: CUES.urgency.test(prompt),
  };
}
