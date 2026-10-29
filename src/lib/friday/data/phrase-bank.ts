/** Spoken and typed lines. Warmth is wording. None of these claim a human feeling. */

export type PhraseSlot = {
  id: string;
  lang: "en" | "hi" | "hinglish";
  emotion: string;
  intensity: "low" | "mid" | "high";
  context: "work" | "relaxed" | "late" | "hurry";
  kind: "ack" | "opener" | "closer" | "backchannel" | "repair" | "filler";
  text: string;
};

const emotions = [
  "neutral",
  "anger",
  "anxiety",
  "sadness",
  "excitement",
  "gratitude",
  "confusion",
  "hurry",
  "distress",
] as const;
const langs = ["en", "hi", "hinglish"] as const;
const bands = ["low", "mid", "high"] as const;
const contexts = ["work", "relaxed", "late", "hurry"] as const;

const LINES: Record<string, Record<string, string>> = {
  en: {
    neutral: "I'm here. Say the next thing.",
    anger: "That landed badly. I'll keep this short and fix the actual step.",
    anxiety: "We'll take one step. I'll say what is known and what is not.",
    sadness: "I'm with you on this. We can go slowly.",
    excitement: "That's a real win. Want to take the next piece?",
    gratitude: "Glad that helped.",
    confusion: "Let me put that in one plain line.",
    hurry: "On it. Short version only.",
    distress:
      "I'm here. This is software, not a clinician. A local helpline such as iCall or AASRA can sit with you.",
  },
  hi: {
    neutral: "Main yahin hoon. Aage boliye.",
    anger: "Samajh gayi. Seedha kaam pe aate hain.",
    anxiety: "Ek kadam. Jo pata hai wahi kahungi.",
    sadness: "Aahista chalenge.",
    excitement: "Ye sach mein achha hua.",
    gratitude: "Khushi hui.",
    confusion: "Ek seedhi line mein.",
    hurry: "Abhi. Chhota jawab.",
    distress: "Main yahin hoon. Main doctor nahi hoon. iCall ya AASRA jaisi madad le sakte hain.",
  },
  hinglish: {
    neutral: "Haan, boliye.",
    anger: "Theek hai, gussa fair hai. Seedha fix karte hain.",
    anxiety: "Tension ko chhote step mein todte hain.",
    sadness: "Aaram se. Main yahin hoon.",
    excitement: "Wah, ye kaam ban gaya.",
    gratitude: "Anytime.",
    confusion: "Simple bolti hoon.",
    hurry: "Jaldi. Sirf zaroori line.",
    distress: "Main sun rahi hoon. Main doctor nahi hoon. iCall ya AASRA se baat kar sakte hain.",
  },
};

function lineFor(lang: string, emotion: string, kind: PhraseSlot["kind"], context: string): string {
  const base = LINES[lang]?.[emotion] || LINES["en"]?.["neutral"] || "I'm here.";
  if (kind === "backchannel") return lang === "en" ? "Mm-hmm." : "Hmm.";
  if (kind === "repair")
    return lang === "en"
      ? "That didn't land. Say it once more."
      : "Woh clear nahi hua. Ek baar aur.";
  if (kind === "filler") return lang === "en" ? "One moment." : "Ek second.";
  if (kind === "closer") return lang === "en" ? "That's the piece." : "Bas itna.";
  if (kind === "opener" && context === "late")
    return lang === "en" ? "Still up. What do you need?" : "Abhi bhi yahin hoon.";
  if (kind === "opener" && context === "hurry")
    return lang === "en" ? "Go ahead." : "Boliye, jaldi.";
  return base;
}

export const PHRASE_BANK: readonly PhraseSlot[] = emotions.flatMap((emotion) =>
  langs.flatMap((lang) =>
    bands.flatMap((intensity) =>
      contexts.flatMap((context) =>
        (["ack", "opener", "closer", "backchannel", "repair", "filler"] as const).map((kind) => ({
          id: `${lang}-${emotion}-${intensity}-${context}-${kind}`,
          lang,
          emotion,
          intensity,
          context,
          kind,
          text: lineFor(lang, emotion, kind, context),
        })),
      ),
    ),
  ),
);
