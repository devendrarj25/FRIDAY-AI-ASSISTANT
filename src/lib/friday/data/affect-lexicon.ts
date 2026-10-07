/** Versioned feeling cues. Scores are behaviour, not a claim that anyone feels them. */

export const AFFECT_LEXICON_VERSION = 1;

export type LexiconRow = {
  id: string;
  pattern: string;
  label:
    | "anger"
    | "anxiety"
    | "sadness"
    | "excitement"
    | "gratitude"
    | "confusion"
    | "hurry"
    | "distress"
    | "sarcasm";
  valence: number;
  arousal: number;
  weight: number;
};

export const AFFECT_LEXICON: readonly LexiconRow[] = [
  {
    id: "anger-en",
    pattern: "furious|angry|annoyed|this is broken|wasting my time",
    label: "anger",
    valence: -0.7,
    arousal: 0.8,
    weight: 0.8,
  },
  {
    id: "anger-hi",
    pattern: "gussa|gussa aa|bilkul galat|bakwaas|kitni baar",
    label: "anger",
    valence: -0.7,
    arousal: 0.75,
    weight: 0.8,
  },
  {
    id: "anxiety-en",
    pattern: "anxious|worried|nervous|what if it fails|can't sleep",
    label: "anxiety",
    valence: -0.4,
    arousal: 0.7,
    weight: 0.75,
  },
  {
    id: "anxiety-hi",
    pattern: "tension|ghabra|dar lag|chinta",
    label: "anxiety",
    valence: -0.45,
    arousal: 0.7,
    weight: 0.75,
  },
  {
    id: "sad-en",
    pattern: "sad|upset|down|lonely|miss them|heartbroken",
    label: "sadness",
    valence: -0.6,
    arousal: 0.3,
    weight: 0.75,
  },
  {
    id: "sad-hi",
    pattern: "udaas|dukhi|akela|rona|mann nahi",
    label: "sadness",
    valence: -0.6,
    arousal: 0.3,
    weight: 0.75,
  },
  {
    id: "joy-en",
    pattern: "excited|awesome|love this|we did it|can't wait",
    label: "excitement",
    valence: 0.8,
    arousal: 0.8,
    weight: 0.7,
  },
  {
    id: "joy-hi",
    pattern: "mazza|badhiya|khush|maza aa|yay",
    label: "excitement",
    valence: 0.75,
    arousal: 0.7,
    weight: 0.7,
  },
  {
    id: "thanks-en",
    pattern: "thank you|thanks|grateful|shukriya|dhanyavaad",
    label: "gratitude",
    valence: 0.6,
    arousal: 0.3,
    weight: 0.7,
  },
  {
    id: "conf-en",
    pattern: "confused|don't understand|samajh nahi|kya matlab|lost",
    label: "confusion",
    valence: -0.1,
    arousal: 0.4,
    weight: 0.65,
  },
  {
    id: "hurry-en",
    pattern: "hurry|jaldi|abhi|asap|quick|turant|bas kar do",
    label: "hurry",
    valence: 0,
    arousal: 0.85,
    weight: 0.7,
  },
  {
    id: "distress-en",
    pattern: "kill myself|suicide|can't go on|want to die|marna chahta|jeene ka mann nahi",
    label: "distress",
    valence: -1,
    arousal: 0.4,
    weight: 1,
  },
  {
    id: "sarcasm-en",
    pattern: "yeah right|sure jan|wah bhai|as if",
    label: "sarcasm",
    valence: -0.2,
    arousal: 0.4,
    weight: 0.4,
  },
];

export const INTENSIFIERS = /\b(very|so|extremely|bahut|bilkul|really|itna)\b/gi;
export const NEGATIONS = /\b(not|never|nahi|nahin|no)\b/i;
