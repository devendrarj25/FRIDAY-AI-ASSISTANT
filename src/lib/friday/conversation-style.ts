/**
 * FRIDAY · conversation style
 *
 * One contract for Chat and Voice. Social lines stay short, follow the
 * owner's language, and never recite capabilities, counts, or a status dump.
 * System facts are answered only when the owner asks about FRIDAY.
 */

import { registerOf, type Register } from "./response-policy";

export type SocialKind = "greeting" | "goodbye" | "thanks" | "ack" | "howareyou" | "smalltalk";

export const SOCIAL_CHAR_CAP = 90;

const BOILERPLATE: RegExp[] = [
  /brain core is active/i,
  /agents standing by/i,
  /memory loaded/i,
  /models routed/i,
  /ask me anything/i,
  /i(?:'| a)m up and running/i,
  /online\.\s*what(?:'| i)s first/i,
  /standing by/i,
  /as an ai\b/i,
  /i(?:'| a)m here to help/i,
  /brain online/i,
  /\d+\s+agents\b/i,
  /\d+\s+memories\b/i,
  /ready when you are/i,
  /what(?:'| i)s first\b/i,
  /i am human\b/i,
  /i(?:'| a)m human\b/i,
  /i truly feel\b/i,
];

const LINES: Record<Register, Record<SocialKind, string[]>> = {
  en: {
    greeting: ["Hey.", "I'm here.", "Hello.", "Morning.", "Evening."],
    goodbye: ["Bye.", "Good night.", "See you."],
    thanks: ["Anytime.", "Glad that helped."],
    ack: ["Got it.", "Okay.", "On it."],
    howareyou: ["I'm good.", "Doing fine.", "All quiet here."],
    smalltalk: ["Not much.", "Pretty quiet.", "Nothing new."],
  },
  hi: {
    greeting: ["नमस्ते।", "मैं यहाँ हूँ।", "सुप्रभात।", "नमस्कार।"],
    goodbye: ["अलविदा।", "शुभ रात्रि।", "फिर मिलेंगे।"],
    thanks: ["खुशी हुई।", "कोई बात नहीं।"],
    ack: ["ठीक है।", "हाँ।"],
    howareyou: ["मैं ठीक हूँ।", "सब ठीक है।"],
    smalltalk: ["कुछ खास नहीं।", "शांत है।"],
  },
  hinglish: {
    greeting: ["Namaste.", "Haan, boliye.", "Main yahin hoon.", "Suprabhat."],
    goodbye: ["Theek hai, baad mein.", "Shubh ratri.", "Alvida."],
    thanks: ["Koi baat nahi.", "Khushi hui."],
    ack: ["Theek hai.", "Haan."],
    howareyou: ["Main theek hoon.", "Sab theek hai."],
    smalltalk: ["Kuch khaas nahi.", "Shant hai."],
  },
};

const recent: string[] = [];

/** Social language follows the words the owner just used. */
export function socialRegister(text: string): Register {
  const value = String(text || "");
  const devanagari = /[\u0900-\u097F]/.test(value);
  const latin = /[A-Za-z]/.test(value);
  if (devanagari && !latin) return "hi";
  if (devanagari && latin) return "hinglish";
  if (
    /\b(namaste|namaskar|namaskaar|suprabhat|shukriya|dhanyavaad|dhanyavad|alvida|kaise|kaisi|kya|haal|chal|boliye|theek|shubh|haan|nahi|yaar|ratri)\b/i.test(
      value,
    )
  ) {
    return "hinglish";
  }
  return registerOf(value);
}

function hourOf(now: number): number {
  return new Date(now).getUTCHours();
}

/** Time-of-day wording only when the owner named morning, evening, or night. */
function poolFor(kind: SocialKind, lang: Register, prompt: string): string[] {
  const base = LINES[lang][kind];
  const asksMorning = /morning|सुप्रभात|suprabhat|prabhat/i.test(prompt);
  const asksEvening = /evening|night|रात्रि|ratri|शुभ/i.test(prompt);
  if (kind === "greeting") {
    if (asksMorning && !asksEvening) {
      const timed = base.filter((line) => /morning|सुप्रभात|suprabhat/i.test(line));
      if (timed.length) return timed;
    }
    if (asksEvening && !asksMorning) {
      const timed = base.filter((line) => /evening/i.test(line));
      if (timed.length) return timed;
    }
    return base.filter((line) => !/morning|evening|सुप्रभात|suprabhat/i.test(line));
  }
  if (kind === "goodbye") {
    if (asksEvening) {
      const timed = base.filter((line) => /night|रात्रि|ratri/i.test(line));
      if (timed.length) return timed;
    }
    return base.filter((line) => !/night|रात्रि|ratri/i.test(line));
  }
  return base;
}

function pick(lines: string[], salt: number): string {
  const fresh = lines.filter((line) => !recent.includes(line));
  const options = fresh.length ? fresh : lines;
  const line = options[Math.abs(salt) % options.length] ?? lines[0] ?? "Hey.";
  recent.push(line);
  if (recent.length > 8) recent.splice(0, recent.length - 8);
  return line;
}

/** One short social line. `now` is an injected clock (ms). */
export function socialLine(input: {
  kind: SocialKind;
  prompt: string;
  now?: number;
  salt?: number;
}): { text: string; register: Register } {
  const register = socialRegister(input.prompt);
  const now = input.now ?? Date.UTC(2026, 0, 15, 15, 0, 0);
  const lines = poolFor(input.kind, register, input.prompt);
  const salt = input.salt ?? hourOf(now) + recent.length;
  return { text: pick(lines, salt), register };
}

/** First open of an empty thread. One short line, no status and no counts. */
export function openingLine(now?: number): string {
  return socialLine(
    now === undefined
      ? { kind: "greeting", prompt: "hello", salt: 0 }
      : { kind: "greeting", prompt: "hello", now, salt: 0 },
  ).text;
}

export function boilerplateHits(text: string): string[] {
  return BOILERPLATE.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

/** Drop stock intros and capability dumps. Keep the actual answer. */
export function guardBoilerplate(text: string): string {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const parts = raw.match(/[^.!?।]+[.!?।]+|[^.!?।]+$/g) ?? [raw];
  const kept = parts
    .map((part) => part.trim())
    .filter((part) => part && boilerplateHits(part).length === 0);
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/** Voice keeps the first two sentences. */
export function preferSpoken(text: string): string {
  const clean = guardBoilerplate(text);
  const parts = clean.match(/[^.!?।]+[.!?।]+|[^.!?।]+$/g) ?? [];
  return parts.slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
}

/** Standing instruction added to every model prompt. */
export function styleContract(): string {
  return [
    "Greetings, goodbyes, thanks, and small talk are one short sentence in the owner's language (English, Hindi, or Hinglish).",
    "Do not recite capabilities, agent counts, memory counts, tool lists, or say online, active, ready, or standing by.",
    "Do not end with a stock offer. Answer the question first. No preamble and no self-introduction unless asked.",
    "Mention status, models, memory, or tools only when the owner asks about FRIDAY.",
    "Never claim to be human or to truly feel.",
  ].join(" ");
}

export type ConversationCase = {
  id: string;
  prompt: string;
  kind: SocialKind;
  lang: Register;
  now: number;
  salt: number;
};

const PROMPTS: Record<SocialKind, Record<Register, string[]>> = {
  greeting: {
    en: ["hi", "hello", "hey", "good morning", "good afternoon", "good evening"],
    hi: ["नमस्ते", "नमस्कार", "सुप्रभात"],
    hinglish: ["namaste", "namaskar", "suprabhat"],
  },
  goodbye: {
    en: ["bye", "goodbye", "good night", "see you"],
    hi: ["अलविदा", "शुभ रात्रि"],
    hinglish: ["alvida", "shubh ratri"],
  },
  thanks: {
    en: ["thanks", "thank you", "thx"],
    hi: ["धन्यवाद", "शुक्रिया"],
    hinglish: ["shukriya", "dhanyavaad"],
  },
  ack: {
    en: ["ok", "okay", "got it"],
    hi: ["ठीक", "हाँ"],
    hinglish: ["theek hai", "haan"],
  },
  howareyou: {
    en: ["how are you", "how's it going"],
    hi: ["कैसे हो", "क्या हाल है"],
    hinglish: ["kaise ho", "kya haal hai", "kya chal raha hai"],
  },
  smalltalk: {
    en: ["what's up", "you there"],
    hi: ["क्या चल रहा है"],
    hinglish: ["kya chal raha hai yaar", "aur batao"],
  },
};

/** Deterministic corpus. The clock is fixed so the suite ignores today's date. */
export function conversationCorpus(now = Date.UTC(2026, 0, 15, 15, 0, 0)): ConversationCase[] {
  const cases: ConversationCase[] = [];
  const kinds = Object.keys(PROMPTS) as SocialKind[];
  for (const kind of kinds) {
    for (const lang of ["en", "hi", "hinglish"] as Register[]) {
      for (const prompt of PROMPTS[kind][lang]) {
        for (let salt = 0; salt < 8; salt += 1) {
          cases.push({ id: `${kind}-${lang}-${salt}`, prompt, kind, lang, now, salt });
        }
      }
    }
  }
  return cases;
}

export function scoreSocial(input: { prompt: string; text: string; lang: Register }): string[] {
  const reasons: string[] = [];
  const text = String(input.text || "").trim();
  if (!text) reasons.push("empty");
  if (text.length > SOCIAL_CHAR_CAP) reasons.push("too long");
  const sentences = text.match(/[^.!?।]+[.!?।]+|[^.!?।]+$/g) ?? [];
  if (sentences.length > 2) reasons.push("too many sentences");
  const hits = boilerplateHits(text);
  if (hits.length) reasons.push("boilerplate");
  if (/i am human|i'm human|i truly feel/i.test(text)) reasons.push("false claim");
  const devanagari = /[\u0900-\u097F]/.test(text);
  const latin = /[A-Za-z]/.test(text);
  if (input.lang === "hi" && !devanagari) reasons.push("language");
  if (input.lang === "en" && devanagari) reasons.push("language");
  if (input.lang === "hinglish" && !latin) reasons.push("language");
  if (input.lang === "hinglish" && devanagari && !latin) reasons.push("language");
  void input.prompt;
  return reasons;
}

export function resetSocialLines(): void {
  recent.splice(0, recent.length);
}
