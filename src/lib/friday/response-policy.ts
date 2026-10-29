import { readFeeling, type Feeling } from "./brain/affect";
import { styleFor, type StyleContext } from "./character-bible";
import { guardBoilerplate } from "./conversation-style";
import { pickPhrase } from "./phrase-bank";

export type TalkLevel = "reserved" | "balanced" | "chatty";
export type Warmth = "plain" | "steady" | "warm";
export type Register = "en" | "hi" | "hinglish";

const HUMAN = /i am human|i'm human|i am conscious|i'm conscious|i feel your pain|i truly feel/i;
const DIAGNOSIS = /\b(you have|diagnos\w*|depression|anxiety disorder|bipolar)\b/i;

export function registerOf(text: string): Register {
  const value = String(text || "");
  const devanagari = /[\u0900-\u097F]/.test(value);
  const latin = /[A-Za-z]/.test(value);
  if (devanagari && !latin) return "hi";
  if (/\b(yaar|nahi|hai|karo|baje|kal|mujhe|haan)\b/i.test(value)) return "hinglish";
  if (devanagari && latin) return "hinglish";
  return "en";
}

export function talkCap(level: TalkLevel, stressed: boolean): number {
  if (stressed) return level === "chatty" ? 220 : 160;
  if (level === "reserved") return 280;
  if (level === "chatty") return 700;
  return 420;
}

let softenAnger = false;

/** The owner said the anger reading was wrong. Later anger lines stay neutral. */
export function noteStyleCorrection(text: string): boolean {
  if (/\b(gussa nahi|not angry|nahi gussa|main gussa nahi)\b/i.test(text)) {
    softenAnger = true;
    return true;
  }
  return false;
}

export function resetStyleCorrection(): void {
  softenAnger = false;
}

export function shapeReply(input: {
  prompt: string;
  text: string;
  talk?: TalkLevel;
  warmth?: Warmth;
  context?: StyleContext;
  hour?: number;
}): { text: string; feeling: Feeling; register: Register } {
  let feeling = readFeeling(
    input.prompt,
    input.hour === undefined ? undefined : { hour: input.hour },
  );
  if (softenAnger && feeling.label === "anger") {
    feeling = { ...feeling, label: "neutral", confidence: 0.2 };
  }
  const register = registerOf(input.prompt);
  const talk = input.talk ?? "balanced";
  const warmth = input.warmth ?? "steady";
  const context = input.context ?? (feeling.label === "hurry" ? "hurry" : "work");
  const stressed =
    feeling.label === "hurry" || feeling.label === "distress" || feeling.intensity >= 0.75;
  let body = String(input.text || "")
    .replace(HUMAN, "")
    .replace(DIAGNOSIS, "")
    .trim();
  const guarded = guardBoilerplate(body);
  if (body && !guarded) {
    body = register === "hi" ? "ठीक है।" : register === "hinglish" ? "Theek hai." : "Okay.";
  } else {
    body = guarded;
  }
  const mistake = /\b(that(?:'s| is) wrong|you(?:'re| are) wrong|galat hai|galat tha)\b/i.test(
    input.prompt,
  );
  if (mistake && feeling.label !== "distress") {
    const own =
      register === "hi" ? "गलत था।" : register === "hinglish" ? "Galat tha." : "That was wrong.";
    if (!/wrong|गलत|galat/i.test(body)) body = `${own} ${body}`.trim();
  }
  if (feeling.label === "distress") {
    const help = pickPhrase({
      lang: register === "en" ? "en" : "hinglish",
      emotion: "distress",
      intensity: "high",
      context: "relaxed",
      kind: "ack",
    });
    body = help;
  } else if (warmth !== "plain" && feeling.confidence >= 0.45 && feeling.label !== "neutral") {
    const ack = pickPhrase({
      lang: register === "en" ? "en" : register,
      emotion: feeling.label,
      intensity: feeling.intensity >= 0.66 ? "high" : feeling.intensity >= 0.33 ? "mid" : "low",
      context,
      kind: "ack",
    });
    if (ack && !body.startsWith(ack)) body = `${ack} ${body}`.trim();
  }
  const cap = talkCap(talk, stressed);
  if (body.length > cap) body = `${body.slice(0, cap - 1).trim()}…`;
  if (talk === "chatty" && !stressed && feeling.label === "excitement") {
    body = `${body} ${styleFor("relaxed")}`.trim();
  }
  if (warmth === "warm" && feeling.label === "excitement" && !stressed) {
    body = `That's a real win. ${body}`.trim();
  }
  if (warmth === "plain") {
    body = body.replace(/^That's a real win\.\s*/, "");
  }
  return { text: body, feeling, register };
}
