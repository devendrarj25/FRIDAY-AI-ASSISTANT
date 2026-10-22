/**
 * FRIDAY · when a heard line is for her.
 *
 * One deterministic decision. Ambient speech is never a tool call. A name
 * match uses the existing wake-word matcher, then a weekday guard so
 * "Friday" as a day does not start a turn. No cloud call.
 */

import { isSelfEchoTranscript, matchWakeWord, normalizeTranscript } from "./wake-word";

export type AddressMode = "name-only" | "conversation" | "meant-for-me";

export type AddressTag = "addressed" | "ambient" | "self";

export type AddressDecision = {
  tag: AddressTag;
  answer: boolean;
  reason: string;
  confidence: number;
  /** False unless she is actually answering. Ambient speech cannot start a tool. */
  tools: boolean;
  closeFollowUp: boolean;
};

const DISMISS =
  /^(?:rehne do|rehne do yaar|nothing|nothing else|never mind|nevermind|chhodo|chodo|chod do|cancel|bas|enough)$/i;

const OTHER_PERSON =
  /^(?:hey |hi |ok |okay )?(?:alex|mom|dad|mummy|papa|bhai|didi|sir|maam|dude)\b|\b(tell|ask|bolo)\s+(him|her|them|usko|unko)\b/i;

const WEEKDAY =
  /\b(?:on|this|next|last|every|coming|until|by|before|after)\s+friday\b|\bfriday\s+(?:morning|evening|night|afternoon|week|ko|ke|ki|par|pe|tak)\b|\bsee you\b[^.?]{0,24}\bfriday\b|\bfriday ko\b/i;

const DIRECTED =
  /\b(open|close|set|remind|show|play|stop|start|turn|send|read|check|batao|bata|karo|kholo|band|sunao|yaad|schedule|kal|aaj|what|who|why|how|when|kya|kaun|kyun|kab)\b/i;

export function normalizeAddressMode(value: unknown): AddressMode {
  if (value === "name-only" || value === "meant-for-me" || value === "conversation") return value;
  return "conversation";
}

function named(text: string, wakeWord: string): boolean {
  return matchWakeWord(text, wakeWord).matched;
}

function weekdayOnly(text: string, wakeWord: string): boolean {
  if (!named(text, wakeWord)) return false;
  const norm = normalizeTranscript(text);
  if (!WEEKDAY.test(norm)) return false;
  const tokens = norm.split(" ").filter(Boolean);
  const index = tokens.findIndex((token) => matchWakeWord(token, wakeWord).matched);
  const previous = tokens[index - 1] ?? "";
  const next = tokens[index + 1] ?? "";
  if (previous === "hey" || previous === "ok" || previous === "okay" || next === "ji") return false;
  if (index === 0 && DIRECTED.test(tokens.slice(1).join(" "))) return false;
  return true;
}

function directedScore(text: string): number {
  const norm = normalizeTranscript(text);
  if (!norm) return 0;
  let score = 0.35;
  if (DIRECTED.test(norm)) score += 0.4;
  if (/\b(you|your|tum|tumhe|aap|aapka|teri|tera)\b/i.test(norm)) score += 0.15;
  if (/[?？]/.test(text)) score += 0.1;
  return Math.min(0.95, score);
}

const STOP = new Set(
  "this that with from have will what when where which about there their your then than they them were been into just also only very kya hai tha thi hain karo kiya".split(
    " ",
  ),
);

function contentWords(text: string): Set<string> {
  return new Set(
    normalizeTranscript(text)
      .split(" ")
      .filter((word) => word.length >= 4 && !STOP.has(word)),
  );
}

/** Talk about her, or about the work she just did, without her name. */
const ABOUT_HER = /\b(she|her|usne|isne|unhone|assistant|tumne|aapne)\b/i;

export function aboutHerWork(text: string, recentWork = ""): { score: number; work: boolean } {
  const heard = contentWords(text);
  const work = contentWords(recentWork);
  let shared = 0;
  for (const word of heard) if (work.has(word)) shared += 1;
  const onWork = shared >= 2;
  const score = (onWork ? 0.4 : 0) + (ABOUT_HER.test(normalizeTranscript(text)) ? 0.15 : 0);
  return { score, work: onWork };
}

/**
 * Decide whether this utterance is for FRIDAY.
 * `followUpOpen` is the window after she spoke or acted.
 */
export function decideAddressing(input: {
  text: string;
  mode?: AddressMode;
  wakeWord?: string;
  followUpOpen?: boolean;
  lastSpoken?: string;
  recentlySpeaking?: boolean;
  /** What FRIDAY just answered or worked on, for "meant for me" without her name. */
  recentWork?: string;
}): AddressDecision {
  const text = String(input.text || "").trim();
  const mode = input.mode ?? "conversation";
  const wakeWord = input.wakeWord || "friday";
  const norm = normalizeTranscript(text);
  if (input.recentlySpeaking && input.lastSpoken && isSelfEchoTranscript(text, input.lastSpoken)) {
    return {
      tag: "self",
      answer: false,
      reason: "self-voice",
      confidence: 0.9,
      tools: false,
      closeFollowUp: false,
    };
  }
  if (!norm) {
    return {
      tag: "ambient",
      answer: false,
      reason: "empty",
      confidence: 0,
      tools: false,
      closeFollowUp: false,
    };
  }
  if (DISMISS.test(norm)) {
    return {
      tag: "ambient",
      answer: false,
      reason: "dismissed",
      confidence: 0.9,
      tools: false,
      closeFollowUp: true,
    };
  }
  if (OTHER_PERSON.test(norm) && !named(text, wakeWord)) {
    return {
      tag: "ambient",
      answer: false,
      reason: "other-person",
      confidence: 0.8,
      tools: false,
      closeFollowUp: false,
    };
  }
  if (named(text, wakeWord) && !weekdayOnly(text, wakeWord)) {
    return {
      tag: "addressed",
      answer: true,
      reason: "name",
      confidence: 0.92,
      tools: true,
      closeFollowUp: false,
    };
  }
  if (weekdayOnly(text, wakeWord)) {
    return {
      tag: "ambient",
      answer: false,
      reason: "weekday",
      confidence: 0.84,
      tools: false,
      closeFollowUp: false,
    };
  }
  if (input.followUpOpen && mode !== "name-only") {
    return {
      tag: "addressed",
      answer: true,
      reason: "follow-up",
      confidence: 0.8,
      tools: true,
      closeFollowUp: false,
    };
  }
  if (mode === "meant-for-me") {
    const about = aboutHerWork(text, input.recentWork);
    const confidence = Math.min(0.95, directedScore(text) + about.score);
    if (confidence >= 0.72) {
      return {
        tag: "addressed",
        answer: true,
        reason: about.work ? "about-her-work" : about.score > 0 ? "about-her" : "directed",
        confidence,
        tools: true,
        closeFollowUp: false,
      };
    }
    return {
      tag: "ambient",
      answer: false,
      reason: "below-threshold",
      confidence,
      tools: false,
      closeFollowUp: false,
    };
  }
  return {
    tag: "ambient",
    answer: false,
    reason: mode === "name-only" ? "name-required" : "not-addressed",
    confidence: directedScore(text),
    tools: false,
    closeFollowUp: false,
  };
}
