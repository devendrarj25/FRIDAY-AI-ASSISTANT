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
    greeting: [
      "Hey.",
      "I'm here.",
      "Hello.",
      "Hi — go ahead.",
      "Hey, I'm listening.",
      "Morning.",
      "Evening.",
    ],
    goodbye: ["Bye.", "Good night.", "See you.", "Take care.", "Talk soon."],
    thanks: [
      "Anytime.",
      "Glad that helped.",
      "Happy to.",
      "Of course.",
      "That's what I'm here for.",
    ],
    ack: ["Got it.", "Okay.", "On it.", "Sure.", "Right."],
    howareyou: [
      "I'm good.",
      "Doing fine.",
      "All quiet here.",
      "Good, thanks for asking.",
      "Steady. How about you?",
    ],
    smalltalk: ["Not much.", "Pretty quiet.", "Nothing new.", "Just here with you.", "All calm."],
  },
  hi: {
    greeting: [
      "नमस्ते।",
      "मैं यहाँ हूँ।",
      "सुप्रभात।",
      "नमस्कार।",
      "हाँ, बोलिए।",
      "मैं सुन रही हूँ।",
    ],
    goodbye: ["अलविदा।", "शुभ रात्रि।", "फिर मिलेंगे।", "अपना ध्यान रखिए।"],
    thanks: ["खुशी हुई।", "कोई बात नहीं।", "ज़रूर।", "मदद करके अच्छा लगा।"],
    ack: ["ठीक है।", "हाँ।", "समझ गई।", "ज़रूर।"],
    howareyou: ["मैं ठीक हूँ।", "सब ठीक है।", "बढ़िया हूँ, आप बताइए।", "शांत है, आप कैसे हैं?"],
    smalltalk: ["कुछ खास नहीं।", "शांत है।", "बस आपके साथ हूँ।", "सब सामान्य है।"],
  },
  hinglish: {
    greeting: [
      "Namaste.",
      "Haan, boliye.",
      "Main yahin hoon.",
      "Suprabhat.",
      "Boliye, sun rahi hoon.",
      "Haan ji, batao.",
    ],
    goodbye: [
      "Theek hai, baad mein.",
      "Shubh ratri.",
      "Alvida.",
      "Apna khayal rakhna.",
      "Phir milte hain.",
    ],
    thanks: ["Koi baat nahi.", "Khushi hui.", "Zaroor.", "Madad karke achha laga."],
    ack: ["Theek hai.", "Haan.", "Samajh gayi.", "Done, dekhti hoon."],
    howareyou: [
      "Main theek hoon.",
      "Sab theek hai.",
      "Badhiya hoon, aap batao.",
      "Shaant hai, aap kaise ho?",
    ],
    smalltalk: ["Kuch khaas nahi.", "Shant hai.", "Bas aapke saath hoon.", "Sab normal hai."],
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

/**
 * What she knows about the moment, so a greeting is about now and not a stock phrase. Every
 * field is optional; with none, the plain pool above is used. Chat and Voice pass the same
 * thing, so she greets the same way in both.
 */
export type SocialContext = {
  /** Local hour 0-23 (the caller reads the clock). */
  hour?: number;
  /** Minutes since the last line in this thread; absent when this is the first. */
  gapMin?: number;
  /** The way the owner is addressed ("sir", a name); absent for none. */
  address?: string;
  /** What they were last on, a few words. */
  topic?: string;
  /** How the owner sounds right now. */
  feeling?: "steady" | "stressed" | "tired" | "happy" | "hurry";
};

type Part = { en: string; hinglish: string; hi: string };

const OPENERS: Record<"morning" | "afternoon" | "evening" | "late", Part[]> = {
  morning: [
    { en: "Good morning", hinglish: "Suprabhat", hi: "सुप्रभात" },
    { en: "Morning", hinglish: "Subah bakhair", hi: "सुबह बख़ैर" },
    {
      en: "Morning, early start",
      hinglish: "Suprabhat, jaldi uth gaye",
      hi: "सुप्रभात, जल्दी उठ गए",
    },
  ],
  afternoon: [
    { en: "Good afternoon", hinglish: "Namaste", hi: "नमस्ते" },
    { en: "Hey", hinglish: "Haan ji", hi: "हाँ जी" },
    { en: "Afternoon", hinglish: "Dopahar ki namaste", hi: "दोपहर की नमस्ते" },
  ],
  evening: [
    { en: "Good evening", hinglish: "Shubh sandhya", hi: "शुभ संध्या" },
    { en: "Evening", hinglish: "Namaste", hi: "नमस्ते" },
    { en: "Hey, evening already", hinglish: "Shaam ho gayi", hi: "शाम हो गई" },
  ],
  late: [
    { en: "Still up", hinglish: "Abhi tak jaag rahe ho", hi: "अभी तक जाग रहे हैं" },
    { en: "Hey, it's late", hinglish: "Der ho gayi hai", hi: "देर हो गई है" },
    { en: "Burning the midnight oil", hinglish: "Raat ko bhi kaam", hi: "रात को भी काम" },
  ],
};

const TAILS: Record<"quick" | "back" | "long" | "stressed" | "tired" | "happy", Part[]> = {
  quick: [
    { en: "I'm here.", hinglish: "Boliye.", hi: "बोलिए।" },
    { en: "Go ahead.", hinglish: "Haan, batao.", hi: "हाँ, बताइए।" },
    { en: "Listening.", hinglish: "Sun rahi hoon.", hi: "सुन रही हूँ।" },
    { en: "Right here.", hinglish: "Yahin hoon.", hi: "यहीं हूँ।" },
    { en: "Tell me.", hinglish: "Bolo.", hi: "बोलिए, सुन रही हूँ।" },
  ],
  back: [
    {
      en: "Good to have you back.",
      hinglish: "Wapas aaye, achha laga.",
      hi: "वापस आए, अच्छा लगा।",
    },
    { en: "Welcome back.", hinglish: "Swagat hai, phir se.", hi: "फिर से स्वागत है।" },
    { en: "What shall we do?", hinglish: "Bataiye, kya karein?", hi: "बताइए, क्या करें?" },
    { en: "Ready when you are.", hinglish: "Jab kahiye, shuru.", hi: "जब कहिए, शुरू।" },
    { en: "What's first?", hinglish: "Pehle kya karein?", hi: "पहले क्या करें?" },
  ],
  long: [
    { en: "It's been a while.", hinglish: "Kaafi der baad.", hi: "काफ़ी देर बाद।" },
    {
      en: "Good to see you again.",
      hinglish: "Phir milke achha laga.",
      hi: "फिर मिलकर अच्छा लगा।",
    },
    {
      en: "Nice to have you back.",
      hinglish: "Aapko wapas dekh achha laga.",
      hi: "आपको वापस देखकर अच्छा लगा।",
    },
    {
      en: "Everything is ready for you.",
      hinglish: "Sab taiyaar rakha hai.",
      hi: "सब तैयार रखा है।",
    },
  ],
  stressed: [
    {
      en: "Take a breath, I've got this.",
      hinglish: "Thodi saans lijiye, main hoon na.",
      hi: "थोड़ी साँस लीजिए, मैं हूँ न।",
    },
    { en: "One thing at a time.", hinglish: "Ek ek karke karte hain.", hi: "एक-एक करके करते हैं।" },
  ],
  tired: [
    {
      en: "Easy tonight — I'll keep it short.",
      hinglish: "Aaram se, main chhota rakhungi.",
      hi: "आराम से, मैं छोटा रखूँगी।",
    },
    { en: "Don't push too hard.", hinglish: "Zyada zor mat dijiye.", hi: "ज़्यादा ज़ोर मत दीजिए।" },
  ],
  happy: [
    {
      en: "You sound cheerful.",
      hinglish: "Aaj mood achha lag raha hai.",
      hi: "आज मूड अच्छा लग रहा है।",
    },
    { en: "Nice to hear.", hinglish: "Sunke achha laga.", hi: "सुनकर अच्छा लगा।" },
  ],
};

const registerKey = (register: Register): "en" | "hinglish" | "hi" => register;

function dayPart(hour: number): keyof typeof OPENERS {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "late";
}

function fresh<T>(items: T[], text: (item: T) => string, salt: number): T {
  const options = items.filter((item) => !recent.includes(text(item)));
  const list = options.length ? options : items;
  return list[Math.abs(salt) % list.length] as T;
}

/**
 * A greeting made from the moment: the part of the day, how long it has been, what they were
 * on, how they sound. Short (one or two sentences, under the social cap), different from the
 * last few, never a status line or a list of what she can do.
 */
export function contextualGreeting(
  context: SocialContext,
  register: Register,
  salt = 0,
): string | null {
  const key = registerKey(register);
  const gap = context.gapMin;
  const quick = gap !== undefined && gap < 10;
  const who = context.address
    ? key === "en"
      ? `, ${context.address}`
      : ` ${context.address}`
    : "";
  const parts: string[] = [];
  // A talk that never stopped needs no "good morning": just answer.
  if (!quick && context.hour !== undefined) {
    const opener = fresh(OPENERS[dayPart(context.hour)], (o) => `${o[key]}${who}.`, salt);
    parts.push(`${opener[key]}${who}.`);
  }
  let tail: Part;
  if (
    context.feeling === "stressed" ||
    context.feeling === "tired" ||
    context.feeling === "happy"
  ) {
    tail = fresh(TAILS[context.feeling], (t) => t[key], salt);
  } else if (gap !== undefined && gap >= 360) {
    tail = fresh(TAILS.long, (t) => t[key], salt);
  } else if (gap !== undefined && gap >= 10) {
    tail = fresh(TAILS.back, (t) => t[key], salt);
  } else {
    tail = fresh(TAILS.quick, (t) => t[key], salt);
  }
  let line = [...parts, tail[key]].join(" ");
  const topic = String(context.topic || "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    topic &&
    topic.length <= 36 &&
    gap !== undefined &&
    gap >= 10 &&
    gap < 1440 &&
    context.hour !== undefined
  ) {
    const pick =
      key === "en"
        ? `We were on ${topic} — pick that up?`
        : key === "hi"
          ? `हम ${topic} पर थे, वहीं से शुरू करें?`
          : `Hum ${topic} par the, wahin se shuru karein?`;
    if ([...parts, pick].join(" ").length <= SOCIAL_CHAR_CAP) line = [...parts, pick].join(" ");
  }
  if (line.length > SOCIAL_CHAR_CAP) line = parts[0] ? `${parts[0]}` : tail[key];
  return line || null;
}

/** One short social line. `now` is an injected clock (ms). */
export function socialLine(input: {
  kind: SocialKind;
  prompt: string;
  now?: number;
  salt?: number;
  context?: SocialContext;
}): { text: string; register: Register } {
  const register = socialRegister(input.prompt);
  const now = input.now ?? Date.UTC(2026, 0, 15, 15, 0, 0);
  const salt = input.salt ?? hourOf(now) + recent.length;
  if (input.kind === "greeting" && input.context) {
    const made = contextualGreeting(input.context, register, salt);
    if (made) {
      recent.push(made);
      if (recent.length > 8) recent.splice(0, recent.length - 8);
      return { text: made, register };
    }
  }
  const lines = poolFor(input.kind, register, input.prompt);
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
