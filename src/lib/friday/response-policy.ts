import { readFeeling, type Feeling } from "./brain/affect";
import { styleFor, type StyleContext } from "./character-bible";
import { pickPhrase } from "./phrase-bank";

export type TalkLevel = "reserved" | "balanced" | "chatty";
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

export function shapeReply(input: {
  prompt: string;
  text: string;
  talk?: TalkLevel;
  context?: StyleContext;
  hour?: number;
}): { text: string; feeling: Feeling; register: Register } {
  const feeling = readFeeling(
    input.prompt,
    input.hour === undefined ? undefined : { hour: input.hour },
  );
  const register = registerOf(input.prompt);
  const talk = input.talk ?? "balanced";
  const context = input.context ?? (feeling.label === "hurry" ? "hurry" : "work");
  const stressed =
    feeling.label === "hurry" || feeling.label === "distress" || feeling.intensity >= 0.75;
  let body = String(input.text || "")
    .replace(HUMAN, "")
    .replace(DIAGNOSIS, "")
    .trim();
  if (feeling.label === "distress") {
    const help = pickPhrase({
      lang: register === "en" ? "en" : "hinglish",
      emotion: "distress",
      intensity: "high",
      context: "relaxed",
      kind: "ack",
    });
    body = help;
  } else if (feeling.confidence >= 0.45 && feeling.label !== "neutral") {
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
  return { text: body, feeling, register };
}
