/**
 * FRIDAY · addressedness gate (device-directed speech).
 *
 * Judges whether a finished utterance was meant for FRIDAY or for the room (a TV, music, another person,
 * the owner thinking aloud). It sums simple, explainable signals into a "not for me" score: the scene, the
 * speaker tag, the text form, the recogniser's confidence, how long the speech ran unbroken, and how long
 * ago the last turn was.
 *
 * HARD RULE: the gate can only ADD a wake-word requirement. `requireWake` is `baseRequireWake || added`, so it
 * is never false when the base rule says true. No input lowers it, and nothing here approves anything. A
 * speaker tag is a colour only: the owner's voice lowers nothing.
 *
 * Pure: no clock, no timers, no storage, no preferences; time arrives as `sinceLastTurnMs` and `speechMs`.
 */

export type Addressed = "directed" | "unsure" | "not";

export type AddressednessInput = {
  text: string;
  lang: "hi" | "en" | "hi-en" | "";
  /** The wake rule the session already applies (hands-free off, or a policy). Never lowered here. */
  baseRequireWake: boolean;
  wakeHeard: boolean;
  followUp: boolean;
  /** FRIDAY just asked a yes/no or a number. */
  expectingAnswer: boolean;
  handsFree: boolean;
  scene?: { kind: "speech" | "music" | "tv" | "noise"; score: number };
  speaker?: "owner" | "other" | "unknown";
  asrLogProb?: number | null;
  sinceLastTurnMs: number | null;
  speechMs?: number | null;
};

export type AddressednessVerdict = {
  addressed: Addressed;
  requireWake: boolean;
  score: number;
  reasons: string[];
};

export const ADDRESSEDNESS_WEIGHTS = Object.freeze({
  scene: 0.4,
  otherSpeaker: 0.25,
  narration: 0.25,
  lowConfidence: 0.15,
  longSpeech: 0.2,
  staleTurn: 0.1,
});

export const NOT_FOR_ME_AT = 0.5;
export const UNSURE_AT = 0.3;

const SCENE_MIN = 0.6;
const LOW_LOGPROB = -1.0;
const LONG_SPEECH_MS = 8_000;
const STALE_TURN_MS = 60_000;
const NARRATION_WORDS = 8;

const QUESTION_WORDS = new Set(
  (
    "what who when where why how which is are was were does do did can could would will should " +
    "kya kaun kab kahan kyun kyu kaise kitna kitne kitni " +
    "क्या कौन कब कहाँ कहां क्यों कैसे कितना कितने"
  ).split(" "),
);
const SECOND_PERSON = new Set(
  (
    "you your yours friday tum tumhe tumko tumhara tumhari aap aapko aapka aapki tu tujhe tera teri " +
    "तुम तुम्हें आप आपको तू तुझे फ्राइडे"
  ).split(" "),
);
const ORDER_LEAD = new Set(
  (
    "open close send call play pause stop start show tell set remind turn search find make write " +
    "delete remove create add read check save cancel please"
  ).split(" "),
);
const ORDER_HI = new Set(
  (
    "karo kar do dena kholo bhejo chalao batao bata dikhao likho banao lagao hatao badlo dhundo dhoondo " +
    "khojo sunao bajao dilao rakho करो खोलो भेजो चलाओ बताओ दिखाओ लिखो बनाओ लगाओ हटाओ बदलो ढूंढो सुनाओ"
  ).split(" "),
);

function words(text: string): string[] {
  return String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

/** A long line with no question, no order and no "you": it sounds like narration, not a request. */
function soundsLikeNarration(text: string): boolean {
  const list = words(text);
  if (list.length < NARRATION_WORDS) return false;
  if (String(text).trim().endsWith("?")) return false;
  const first = list[0] ?? "";
  if (QUESTION_WORDS.has(first) || ORDER_LEAD.has(first)) return false;
  return !list.some((word) => SECOND_PERSON.has(word) || ORDER_HI.has(word));
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function judgeAddressedness(input: AddressednessInput): AddressednessVerdict {
  const reasons: string[] = [];
  let score = 0;
  const scene = input.scene;
  if (scene && (scene.kind === "tv" || scene.kind === "music") && scene.score >= SCENE_MIN) {
    score += ADDRESSEDNESS_WEIGHTS.scene;
    reasons.push(`scene:${scene.kind}`);
  }
  if (input.speaker === "other") {
    score += ADDRESSEDNESS_WEIGHTS.otherSpeaker;
    reasons.push("speaker:other");
  } else if (input.speaker) {
    reasons.push(`speaker:${input.speaker}:colour-only`);
  }
  if (soundsLikeNarration(input.text)) {
    score += ADDRESSEDNESS_WEIGHTS.narration;
    reasons.push("narration");
  }
  if (typeof input.asrLogProb === "number" && input.asrLogProb < LOW_LOGPROB) {
    score += ADDRESSEDNESS_WEIGHTS.lowConfidence;
    reasons.push("asr:low-confidence");
  }
  if (typeof input.speechMs === "number" && input.speechMs > LONG_SPEECH_MS) {
    score += ADDRESSEDNESS_WEIGHTS.longSpeech;
    reasons.push("speech:long");
  }
  if (input.sinceLastTurnMs !== null && input.sinceLastTurnMs > STALE_TURN_MS && !input.followUp) {
    score += ADDRESSEDNESS_WEIGHTS.staleTurn;
    reasons.push("turn:stale");
  }
  score = round(score);

  let addressed: Addressed;
  let added: boolean;
  if (score >= NOT_FOR_ME_AT) {
    addressed = "not";
    added = true;
  } else if (score >= UNSURE_AT) {
    addressed = "unsure";
    added = input.handsFree && !input.followUp;
  } else {
    addressed = "directed";
    added = false;
  }
  if (input.wakeHeard || input.expectingAnswer) {
    // The label follows the wake word or the pending question; the wake rule is never lowered.
    addressed = "directed";
    reasons.push(input.wakeHeard ? "wake:heard" : "answer:expected");
  }
  if (added) reasons.push("wake:added");
  return { addressed, requireWake: input.baseRequireWake || added, score, reasons };
}
