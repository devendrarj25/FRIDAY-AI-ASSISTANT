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

/** Speech about what somebody else said or did: a story, not a request. */
const REPORTED =
  /\b(?:he|she|they|usne|isne|unhone|unho ne|wo|woh|vo)\s+(?:said|says|told|asked|was saying|were saying|bola|bolta|kaha|kehta|keh raha|keh rahi|bata raha|puchh raha)\b|\b(?:he|she|they) (?:said|told)\b|\bmujhe (?:bola|kaha|bataya)\b|\bsaid that\b|\btold me\b/i;

/** Someone saying what they themselves will do or plan: not an order to her. */
const OWN_PLAN =
  /\b(?:main|mai|hum|we|i)\b[^.?!]{0,40}\b(?:karunga|karungi|karenge|kholunga|dekhunga|dekhungi|jaunga|jaungi|will|going to|gonna|plan(?:ning)? to|wanted to|chahta tha|chahti thi|soch raha|soch rahi)\b/i;

/** A short answer or reaction that fits right after she spoke. */
const REPLY_WORD =
  /^(?:yes|yeah|yep|no|nope|ok(?:ay)?|sure|fine|right|exactly|correct|haan|han|ha|nahi|nahin|na|theek hai|thik hai|achha|accha|sahi|bilkul|zaroor|ji|ji haan|thanks|thank you|shukriya|dhanyavaad)\b/i;

/** A request said as an order at the start of the line: "make it shorter", "send it to Ravi". */
const IMPERATIVE =
  /^(?:please\s+|ok(?:ay)?\s+|and\s+|now\s+|also\s+)*(?:make|give|tell|call|find|search|write|create|delete|remove|move|copy|add|change|turn|switch|increase|decrease|undo|redo|summari[sz]e|translate|explain|repeat|continue|go|do|try|use|save|print|share|email|text|message|read|show|play|pause|resume|mute|unmute|lock|close|open)\b/i;

const SECOND_PERSON = /\b(?:you|your|tum|tumhe|tumhara|aap|aapko|aapka|friday)\b/i;

const CORRECTION =
  /\b(?:no no|not that|wrong|actually|instead|i meant|i mean|galat|nahi nahi|maine kaha|mera matlab)\b/i;

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
 * Does a line heard inside the follow-up window belong to the talk she is in? Anything said
 * after she spoke used to count, so the TV, a call, or a person across the room could start a
 * task. Now it must answer her, continue her topic, correct her, or be plainly directed at her.
 */
export function followUpFits(input: { text: string; lastSpoken?: string; recentWork?: string }): {
  fits: boolean;
  reason: string;
} {
  const norm = normalizeTranscript(input.text);
  if (!norm) return { fits: false, reason: "empty" };
  const words = norm.split(" ").filter(Boolean);
  if (REPORTED.test(input.text)) return { fits: false, reason: "about-someone-else" };
  if (OWN_PLAN.test(norm) && !SECOND_PERSON.test(norm)) {
    return { fits: false, reason: "own-plan" };
  }
  if (CORRECTION.test(norm)) return { fits: true, reason: "correction" };
  if (words.length <= 6 && REPLY_WORD.test(norm)) return { fits: true, reason: "reply" };
  const askedBack = /[?？]|\b(?:kya|batao|bataiye|chahiye|chahte|want|should|shall)\b/i.test(
    input.lastSpoken || "",
  );
  if (askedBack && words.length <= 8) return { fits: true, reason: "answers-her-question" };
  if (IMPERATIVE.test(norm)) return { fits: true, reason: "imperative" };
  if (directedScore(input.text) >= 0.75) return { fits: true, reason: "directed" };
  // The same subject as the last thing she said or did: a word of five letters or more in common.
  const heard = [...contentWords(input.text)].filter((word) => word.length >= 5);
  const before = contentWords(`${input.recentWork || ""} ${input.lastSpoken || ""}`);
  if (heard.some((word) => before.has(word))) return { fits: true, reason: "same-topic" };
  // A long stretch of talk with no sign it is for her is somebody's conversation, not a request.
  return { fits: false, reason: words.length > 12 ? "long-ambient-talk" : "unrelated" };
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
    const fit = followUpFits({
      text,
      lastSpoken: input.lastSpoken || "",
      recentWork: input.recentWork || "",
    });
    if (fit.fits) {
      return {
        tag: "addressed",
        answer: true,
        reason: "follow-up",
        confidence: 0.8,
        tools: true,
        closeFollowUp: false,
      };
    }
    return {
      tag: "ambient",
      answer: false,
      reason: `follow-up window, not for her (${fit.reason})`,
      confidence: Math.max(0.55, 1 - directedScore(text)),
      tools: false,
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
