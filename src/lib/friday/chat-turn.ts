/**
 * Typed chat and Manual mode. Auto still owns the microphone and speech.
 * This file only shapes the prompt and how a stopped or tool-using turn looks.
 */

const DEVANAGARI = /[\u0900-\u097F]/;
const LATIN = /[A-Za-z]/;
const ROMAN_HINGLISH = /\b(kya|hai|hain|nahi|nahin|karo|karna|batao|bata|yaad)\b/i;

export type TurnLanguage = "hindi" | "hinglish" | "english";

/** Language of the latest typed line. A pinned Settings language is applied by the caller. */
export function turnLanguage(text: string): TurnLanguage {
  const sample = text.trim();
  const devanagari = DEVANAGARI.test(sample);
  const latin = LATIN.test(sample);
  if (devanagari && latin) return "hinglish";
  if (devanagari) return "hindi";
  if (ROMAN_HINGLISH.test(sample)) return "hinglish";
  return "english";
}

/**
 * Extra system text for a typed turn. Standing english / hindi / hinglish
 * settings stay; follow-user matches the last message.
 */
export function manualChatGuide(prompt: string, replyLanguage: string): string {
  const follow = replyLanguage === "follow-user" || replyLanguage === "";
  const lang = turnLanguage(prompt);
  const match = follow
    ? lang === "hindi"
      ? "The last message is Hindi. Reply in Hindi."
      : lang === "hinglish"
        ? "The last message is Hinglish. Reply in that mix."
        : "The last message is English. Reply in English."
    : "The language setting already chosen stays in force.";
  return [
    "MANUAL CHAT — this is typed. Do not ask them to use the microphone, and do not say you are speaking.",
    "Answer like a person in the room: the point first, then the detail they need.",
    match,
    "A normal turn is a few sentences. Use a list or code only when they asked for one, or when the answer is itself a list or code.",
    "Never invent a file, a device, or a number a tool did not return. If a tool failed, say so in one sentence and answer from what you do have.",
  ].join(" ");
}

/**
 * A stop with text keeps that bubble. An empty stop is one line, "Stopped."
 * Any other error with text is folded into the same bubble.
 */
export function settleInterrupted(
  answer: string,
  error: string,
): { keep: boolean; text: string | null } {
  const partial = answer.trim().length > 0;
  if (error === "Stopped by you." && partial) return { keep: true, text: null };
  if (error === "Stopped by you.") return { keep: false, text: "Stopped." };
  if (partial) {
    const body = answer.replace(/\s+$/u, "");
    return { keep: true, text: `${body}\n\n[${error}]` };
  }
  return { keep: false, text: error };
}

const TOOL_LABEL: Record<string, string> = {
  fs_read: "fs.read",
  "fs.read": "fs.read",
  android_list: "android.list",
  "android.list": "android.list",
  bluetooth_list: "bluetooth.list",
  "bluetooth.list": "bluetooth.list",
  bluetooth_scan: "bluetooth.scan",
  "bluetooth.scan": "bluetooth.scan",
  network_discover: "network.discover",
  "network.discover": "network.discover",
};

/** Header line while a read-only model tool is running. */
export function toolActivity(name: string): string {
  const raw = String(name || "").trim();
  const label = TOOL_LABEL[raw] ?? raw.replaceAll("_", ".");
  return `Checking ${label}.`;
}
