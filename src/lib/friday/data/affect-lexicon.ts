/** Versioned feeling cues. Scores are behaviour, not a claim that anyone feels them. */

export const AFFECT_LEXICON_VERSION = 2;

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
    | "sarcasm"
    | "tiredness"
    | "overwhelm"
    | "disappointment"
    | "relief";
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
    pattern:
      "gussa|bilkul galat|bakwaas|kitni baar|irritat[\\p{L}\\p{M}]*|frustrat[\\p{L}\\p{M}]*|fed up|pareshan kar|tang aa|chid|गुस्सा|बकवास",
    label: "anger",
    valence: -0.7,
    arousal: 0.75,
    weight: 0.8,
  },
  {
    id: "anxiety-en",
    pattern:
      "anxious|worried|nervous|what if it fails|can't sleep|scared|afraid|panic[\\p{L}\\p{M}]*|stressed|stress|neend nahi|घबरा[\\p{L}\\p{M}]*|चिंता",
    label: "anxiety",
    valence: -0.4,
    arousal: 0.7,
    weight: 0.75,
  },
  {
    id: "anxiety-hi",
    pattern:
      "tension|ghabra[\\p{L}\\p{M}]*|dar lag[\\p{L}\\p{M}]*|darr|chinta|fikr|pareshan|परेशान|टेंशन",
    label: "anxiety",
    valence: -0.45,
    arousal: 0.7,
    weight: 0.75,
  },
  {
    id: "sad-en",
    pattern: "sad|upset|feeling down|feeling low|lonely|miss them|heartbroken|crying|depressed",
    label: "sadness",
    valence: -0.6,
    arousal: 0.3,
    weight: 0.75,
  },
  {
    id: "sad-hi",
    pattern:
      "udaas|dukhi|akela|akeli|rona|rone ka|mann nahi|mood kharab|mood off|dil toot|उदास|दुखी|अकेला|अकेली",
    label: "sadness",
    valence: -0.6,
    arousal: 0.3,
    weight: 0.75,
  },
  {
    id: "joy-en",
    pattern:
      "excited|awesome|love this|we did it|can't wait|amazing|so happy|great news|finally got|promoted|selected",
    label: "excitement",
    valence: 0.8,
    arousal: 0.8,
    weight: 0.7,
  },
  {
    id: "joy-hi",
    pattern: "mazza|badhiya|khush|maza aa|yay|mast|zabardast|kamaal|ho gaya select|खुश|मज़ा|मजा",
    label: "excitement",
    valence: 0.75,
    arousal: 0.7,
    weight: 0.7,
  },
  {
    id: "thanks-en",
    pattern: "thank you|thanks|grateful|shukriya|dhanyavaad|thanku|thnx|शुक्रिया|धन्यवाद",
    label: "gratitude",
    valence: 0.6,
    arousal: 0.3,
    weight: 0.7,
  },
  {
    id: "conf-en",
    pattern:
      "confused|don't understand|samajh nahi|samajh nhi|kya matlab|lost|not clear|clear nahi|समझ नहीं",
    label: "confusion",
    valence: -0.1,
    arousal: 0.4,
    weight: 0.65,
  },
  {
    id: "hurry-en",
    pattern:
      "hurry|jaldi|abhi ke abhi|abhi chahiye|abhi hi|asap|quick|turant|bas kar do|जल्दी|तुरंत",
    label: "hurry",
    valence: 0,
    arousal: 0.85,
    weight: 0.7,
  },
  {
    id: "distress-en",
    pattern:
      "kill myself|suicide|can't go on|want to die|end my life|no point (?:in )?living|marna chahta|marna chahti|mar jana chahta|mar jana chahti|mar jaun|jeene ka mann nahi|jeena nahi chahta|jeena nahi chahti|khud ko khatam|zindagi khatam|मरना चाहता|मरना चाहती|जीने का मन नहीं",
    label: "distress",
    valence: -1,
    arousal: 0.4,
    weight: 1,
  },
  {
    id: "tired-en",
    pattern:
      "tired|exhausted|drained|burn(?:ed|t) out|burnout|no energy|sleepy|can't focus|thak gaya|thak gayi|thak gaye|thaka hua|thakan|neend aa rahi|थक गया|थक गई|थकान",
    label: "tiredness",
    valence: -0.4,
    arousal: 0.15,
    weight: 0.75,
  },
  {
    id: "overwhelm-en",
    pattern:
      "overwhelmed|too much|too many things|can't keep up|buried in work|so much work|kaam bahut hai|bahut kaam|sab kuch ek saath|sambhal nahi|handle nahi|bohot pressure|bahut pressure|pressure me|pressure mein",
    label: "overwhelm",
    valence: -0.5,
    arousal: 0.65,
    weight: 0.75,
  },
  {
    id: "disappoint-en",
    pattern:
      "disappointed|let down|didn't work out|failed again|lost the deal|rejected|nirash|nirasha|mayus|himmat toot|dil tut|reject ho gaya|fail ho gaya|निराश",
    label: "disappointment",
    valence: -0.55,
    arousal: 0.3,
    weight: 0.75,
  },
  {
    id: "relief-en",
    pattern:
      "relieved|what a relief|finally done|phew|chain mila|rahat|tension khatam|ho gaya aakhir|aakhir ho gaya|चैन|राहत",
    label: "relief",
    valence: 0.55,
    arousal: 0.2,
    weight: 0.7,
  },
  {
    id: "sarcasm-en",
    pattern: "yeah right|sure jan|wah bhai|as if",
    label: "sarcasm",
    valence: -0.2,
    arousal: 0.4,
    weight: 0.55,
  },
];

export const INTENSIFIERS = /\b(very|so|extremely|bahut|bilkul|really|itna)\b/gi;
export const NEGATIONS = /\b(not|never|nahi|nahin|no)\b/i;
