/**
 * The instant acknowledgement: a very short pre-rendered sound ("Mm.", "One moment.") that fills the gap between the
 * end of the owner's sentence and the first spoken clause of the real answer, so the pause is never silent for long.
 *
 * Pure and deterministic: no clock, no timer, no audio, no network. The conductor owns the timer and the playback;
 * this module only decides whether an acknowledgement may be said, which line, and when.
 *
 * Threat model (why it is built this way):
 *  - The line comes from a fixed catalogue and nothing else. The owner's transcript only chooses the language pool,
 *    it is never copied into the line (a busy reply embeds the task text; an acknowledgement must not).
 *  - No line is a yes-word. A confirmation prompt may be open next to it, and an echo of the line (the speaker heard
 *    by the microphone) must never read as "yes", "no" or any bound confirmation, in English, Devanagari or Roman Hindi.
 *  - It is silent whenever speech is not welcome (mute, pause, Stop everything, a call, quiet hours, whisper mode) or
 *    when it would add nothing (the first clause is ready, the answer is quick, a stop or a confirmation).
 *  - Local pre-rendered clips only: a line with no clip ready is not said, and nothing here calls a cloud voice.
 */
import { confirmationVerdict, mentionsConfirmWord } from "../voice-session";
import { ackWanted, type LadderLane } from "./brain-bridge";
import type { RouteKind } from "./utterance-router";
import type { VoiceStage } from "./latency-monitor";

export type AckLang = "en" | "hi" | "hinglish";

export type AckLineEntry = {
  /** Stable id; also the key of the pre-rendered clip in the acknowledgement memory. */
  id: string;
  text: string;
  /** The pool: `hi` is Devanagari, `hinglish` is Roman Hindi, `en` is English. */
  lang: AckLang;
  /** The voice language the clip is rendered in (Roman Hindi is spoken by the Hindi voice after Speech Prep). */
  ttsLang: "en" | "hi";
};

/** Wait this long after the end of the sentence is confirmed before the acknowledgement may start. */
export const ACK_DELAY_MS = 600;
/** At most this many acknowledgements in one turn. */
export const ACK_PER_TURN = 1;
/** Longest owner name appended to a line (the same cap the narrator's address name has). */
const NAME_MAX = 24;

/** The latency-monitor stage names the conductor stamps (a test pins them against the stage list). */
export const ackStamps = { armed: "ackArmed", audible: "ackAudible" } as const satisfies Record<
  string,
  VoiceStage
>;

/* ---------- the catalogue ---------- */

/**
 * Candidates per pool. Lines are gender-neutral on purpose. Every candidate goes through `isYesLike` when the module
 * loads: a candidate that is a yes-word, a no-word or a bound confirmation is dropped and listed in
 * `DROPPED_ACK_CANDIDATES` (so "Okay." and "Sure." never reach the owner's ears).
 */
const CANDIDATES: Record<AckLang, readonly string[]> = {
  en: [
    "Mm.",
    "Okay.",
    "Sure.",
    "One moment.",
    "On it.",
    "Let me check.",
    "Looking.",
    "One sec.",
    "Give me a second.",
    "Right, checking.",
  ],
  hi: ["ठीक है।", "हम्म।", "एक पल।", "एक मिनट।", "देखते हैं।", "अभी करते हैं।", "बस एक सेकंड।", "देख लेते हैं।"],
  hinglish: [
    "Hmm.",
    "Ek minute.",
    "Ek second.",
    "Dekhte hain.",
    "Abhi karte hain.",
    "Bas ek pal.",
    "Abhi dekhte hain.",
  ],
};

const TTS_LANG: Record<AckLang, "en" | "hi"> = { en: "en", hi: "hi", hinglish: "hi" };

/**
 * Hindi yes and no words in Devanagari. `confirmationVerdict` only knows Latin spellings, so a Devanagari line is
 * checked here as well: any of these inside a line makes it a yes-like or no-like line and it is dropped.
 */
const DEVANAGARI_ANSWER_WORDS =
  /(?<![\p{L}\p{M}])(?:हाँ|हां|हा|जी|जी हाँ|ठीक|ठीक है|बिल्कुल|ज़रूर|जरूर|ओके|ओके\s?है|करो|कर दो|कर दीजिए|चलाओ|नहीं|नही|मत|रुको|रुकिए|रहने दो|छोड़ दो|कैंसल|रद्द|स्टॉप)(?![\p{L}\p{M}])/u;

/** True when the line could be heard as an answer to a question: a yes, a no, or a bound confirmation. */
export function isYesLike(line: string): boolean {
  const text = String(line ?? "");
  if (!text.trim()) return true;
  if (confirmationVerdict(text) !== "unclear" || mentionsConfirmWord(text)) return true;
  return DEVANAGARI_ANSWER_WORDS.test(text.normalize("NFC"));
}

const LANGS: readonly AckLang[] = ["en", "hi", "hinglish"];

function buildCatalogue(): { lines: AckLineEntry[]; dropped: string[] } {
  const lines: AckLineEntry[] = [];
  const dropped: string[] = [];
  for (const lang of LANGS) {
    let n = 0;
    for (const text of CANDIDATES[lang]) {
      if (isYesLike(text)) {
        dropped.push(text);
        continue;
      }
      n += 1;
      lines.push({ id: `ack-${lang}-${n}`, text, lang, ttsLang: TTS_LANG[lang] });
    }
  }
  return { lines, dropped };
}

const BUILT = buildCatalogue();

/** Every line that may be said, with its clip id. Frozen: nothing at run time adds a line. */
export const ACK_CATALOGUE: readonly AckLineEntry[] = Object.freeze(
  BUILT.lines.map((entry) => Object.freeze({ ...entry })),
);
/** Candidates removed because they read as a yes, a no or a confirmation. */
export const DROPPED_ACK_CANDIDATES: readonly string[] = Object.freeze([...BUILT.dropped]);

/** The lines of one pool, in catalogue order. */
export function ackPool(lang: AckLang): readonly AckLineEntry[] {
  return ACK_CATALOGUE.filter((entry) => entry.lang === lang);
}

/* ---------- language of the reply ---------- */

const DEVANAGARI_WORD = /[ऀ-ॣॱ-ॿ]+/gu;
const LATIN_WORD = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
const ROMAN_HINDI_MARKERS = new Set(
  (
    "aap ab abhi acha accha aur bahut baat bhi chahiye dena haan hai hain hoga hum kaam kab kaise kaun kar karo kare " +
    "karna kya ke ki ko kuch kyun mai mera meri mere mujhe nahi nahin naam par pehle phir raha rahi ruko suno tum " +
    "tumhe tumhara ye yeh wo woh yahan wahan zara jao batao bata bana banao bhej bhejo dekho khol kholo band dikhao " +
    "theek thik bhai yaar batana chalo bolo sun dekh gaya hua kitna ka kal aaj se mein tak liye"
  ).split(" "),
);

/**
 * The pool for the owner's last utterance. Devanagari wins when it is at least half of the words, so Hindi with an
 * English name stays Hindi; Roman Hindi (two or more common Hindi words, half or more of the Latin words) gets the
 * Roman pool; the rest is English. A line with no letters uses the fallback. One pool only: scripts never mix.
 */
export function ackLanguage(text: string, fallback: AckLang = "en"): AckLang {
  const heard = String(text ?? "").normalize("NFC");
  const deva = heard.match(DEVANAGARI_WORD) ?? [];
  const latin = heard.match(LATIN_WORD) ?? [];
  if (!deva.length && !latin.length) return fallback;
  if (deva.length && deva.length * 2 >= deva.length + latin.length) return "hi";
  const hits = latin.filter((w) => ROMAN_HINDI_MARKERS.has(w.toLowerCase())).length;
  if (hits >= 1 && hits * 2 >= latin.length && (hits >= 2 || latin.length <= 2)) return "hinglish";
  return "en";
}

/* ---------- the owner's name ---------- */

/**
 * The owner's address name, cleaned like `addressName` in assistant-conduct (a test pins that they agree on Latin names), but a
 * Devanagari name keeps its vowel signs: letters, marks, spaces, apostrophes and hyphens, 24 characters. It is the owner's own setting, never the transcript.
 */
export function cleanAddressName(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/[^\p{L}\p{M}\s'-]/gu, "")
    .replace(/\s+/g, " ")
    .slice(0, NAME_MAX)
    .trim();
}

/**
 * "One moment." with the name "Asha" becomes "One moment, Asha." (the same shape the conduct lines use). A name that
 * would turn the line into a yes, a no or a confirmation (a name of "Haan", "ok", "nahi") is left off.
 */
export function addressedLine(line: string, address: string): string {
  const who = cleanAddressName(address);
  if (!who) return line;
  const named = `${line.replace(/[.।]\s*$/u, "")}, ${who}${/।\s*$/u.test(line) ? "।" : "."}`;
  return isYesLike(named) ? line : named;
}

/* ---------- rotation ---------- */

/** A small seeded generator: the same seed and the same turn give the same number, on every machine. */
function mix(seed: number, turn: number): number {
  let h =
    (Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^
      Math.imul((turn | 0) + 0x7f4a7c15, 0xc2b2ae35)) >>>
    0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * The line for this turn: seeded, and never the line used last (when the pool has more than one). The same inputs
 * always give the same line, so the rotation needs no hidden state: the conductor keeps `lastLineId` and `turn`.
 */
export function pickAckLine(
  pool: readonly AckLineEntry[],
  seed: number,
  turn: number,
  lastLineId = "",
): AckLineEntry | null {
  if (!pool.length) return null;
  const fresh = pool.length > 1 ? pool.filter((entry) => entry.id !== lastLineId) : pool;
  const options = fresh.length ? fresh : pool;
  return options[mix(seed, turn) % options.length] ?? null;
}

/* ---------- the decision ---------- */

/** What kind of turn this is. The router's kinds, plus the two the conductor knows about. */
export type AckTurnKind = RouteKind | "confirm-turn" | "control";

/** The turn kinds that are followed by real work, so a short sound before the answer makes sense. */
const ACK_TURN_KINDS: readonly AckTurnKind[] = ["foreground-turn", "new-task"];

export type AckContext = {
  /** The conductor mode. Only Auto speaks. */
  mode: "auto" | "manual" | "chat" | string;
  /** Spoken replies are on (the owner has not turned speech off). */
  speakReplies: boolean;
  /** Mute, pause or Stop everything is on. */
  held: boolean;
  turnKind: AckTurnKind;
  /** The owner's last utterance. Only its language is read; no part of it is ever spoken. */
  heard: string;
  /** The owner's settings: the language to use when the utterance has no letters. */
  fallbackLang?: AckLang;
  /** An approval or spoken confirmation is open. */
  pendingConfirmation: boolean;
  /** The first spoken clause of the real answer is already ready. */
  firstClauseReady: boolean;
  /** She is speaking right now. */
  speaking: boolean;
  /** The owner is speaking again (barge-in or a continued sentence). */
  ownerSpeaking: boolean;
  callHold: boolean;
  /** Quiet hours or Do Not Disturb. */
  quiet: boolean;
  whisperMode: boolean;
  /** Lines the narrator may still say this request; an acknowledgement uses one. */
  narratorLinesLeft: number;
  /** Acknowledgements already said in this turn. */
  ackedThisTurn: number;
  /** The brain-bridge lane of the turn; a command never gets an acknowledgement. Missing means the full lane. */
  lane?: LadderLane | undefined;
  /**
   * The expected time to the first spoken clause. An acknowledgement is opt-in by this value: the brain bridge's
   * `ackWanted` rule says yes only above its threshold (1500 ms), and a missing or odd value says no.
   */
  expectedAnswerMs?: number | undefined;
  /** When the end of the owner's sentence was confirmed. */
  endpointAtMs: number;
  /** The turn generation the decision is for, and the live one (a newer turn makes this one stale). */
  generation: number;
  liveGeneration: number;
  /** Seed (a session number) and the turn counter for the rotation, and the line said last. */
  seed: number;
  turn: number;
  lastLineId?: string | undefined;
  /** The ids of the clips already rendered locally. A line with no clip is not said. */
  readyClipIds: readonly string[];
  /** The owner's address name setting (may be empty). */
  addressName?: string | undefined;
  /** Override the delay (milliseconds after the confirmed endpoint). */
  delayMs?: number | undefined;
};

export type AckSkip =
  | "not-auto-mode"
  | "speech-off"
  | "held"
  | "stale-generation"
  | "turn-kind"
  | "pending-confirmation"
  | "first-clause-ready"
  | "speaking"
  | "owner-speaking"
  | "call-hold"
  | "quiet-hours"
  | "whisper-mode"
  | "narrator-budget"
  | "already-acked"
  | "quick-answer"
  | "command-lane"
  | "expected-unknown"
  | "no-clip-ready";

export type AckDecision =
  | { ack: false; reason: AckSkip }
  | {
      ack: true;
      /** What to say: the catalogue line, with the owner's name when that is safe. */
      line: string;
      /** The pre-rendered clip to play. */
      clipId: string;
      /** The voice language of the clip. */
      ttsLang: "en" | "hi";
      lang: AckLang;
      /** True when the line carries the name, so it has no ready clip and is rendered locally (never in the cloud). */
      named: boolean;
      /** When to start: the confirmed endpoint plus the delay. The conductor cancels it if the first clause is ready first. */
      atMs: number;
    };

/** Every gate, in order. The first one that fires is the reason. */
export function shouldAck(ctx: AckContext): AckDecision {
  const no = (reason: AckSkip): AckDecision => ({ ack: false, reason });
  if (ctx.mode !== "auto") return no("not-auto-mode");
  if (!ctx.speakReplies) return no("speech-off");
  if (ctx.held) return no("held");
  if (ctx.generation !== ctx.liveGeneration) return no("stale-generation");
  if (!ACK_TURN_KINDS.includes(ctx.turnKind)) return no("turn-kind");
  if (ctx.pendingConfirmation) return no("pending-confirmation");
  if (ctx.firstClauseReady) return no("first-clause-ready");
  if (ctx.speaking) return no("speaking");
  if (ctx.ownerSpeaking) return no("owner-speaking");
  if (ctx.callHold) return no("call-hold");
  if (ctx.quiet) return no("quiet-hours");
  if (ctx.whisperMode) return no("whisper-mode");
  if (ctx.narratorLinesLeft <= 0) return no("narrator-budget");
  if (ctx.ackedThisTurn >= ACK_PER_TURN) return no("already-acked");
  const lane = ctx.lane ?? "full";
  if (lane === "command") return no("command-lane");
  const expectedMs = ctx.expectedAnswerMs;
  if (typeof expectedMs !== "number" || !Number.isFinite(expectedMs)) return no("expected-unknown");
  if (!ackWanted({ lane, expectedMs })) return no("quick-answer");
  const lang = ackLanguage(ctx.heard, ctx.fallbackLang ?? "en");
  const ready = new Set(ctx.readyClipIds);
  const pool = ackPool(lang).filter((entry) => ready.has(entry.id));
  const entry = pickAckLine(pool, ctx.seed, ctx.turn, ctx.lastLineId ?? "");
  if (!entry) return no("no-clip-ready");
  const line = addressedLine(entry.text, ctx.addressName ?? "");
  return {
    ack: true,
    line,
    clipId: entry.id,
    ttsLang: entry.ttsLang,
    lang,
    named: line !== entry.text,
    atMs: ctx.endpointAtMs + (ctx.delayMs ?? ACK_DELAY_MS),
  };
}

/**
 * Asked again just before the sound starts and after every await (the timer firing, the clip loading): false means
 * cancel at once, nothing is played. Covers a newer turn, the first clause arriving, barge-in, and a hold starting.
 */
export function ackStillDue(
  armed: { generation: number },
  live: {
    generation: number;
    firstClauseReady: boolean;
    speaking: boolean;
    ownerSpeaking: boolean;
    held: boolean;
    pendingConfirmation: boolean;
    callHold: boolean;
  },
): { due: true } | { due: false; reason: AckSkip } {
  if (armed.generation !== live.generation) return { due: false, reason: "stale-generation" };
  if (live.held) return { due: false, reason: "held" };
  if (live.pendingConfirmation) return { due: false, reason: "pending-confirmation" };
  if (live.ownerSpeaking) return { due: false, reason: "owner-speaking" };
  if (live.firstClauseReady) return { due: false, reason: "first-clause-ready" };
  if (live.speaking) return { due: false, reason: "speaking" };
  if (live.callHold) return { due: false, reason: "call-hold" };
  return { due: true };
}

/** The lines the acknowledgement phase of Prewarm renders into memory, in the shape its `AckLine` has. */
export function ackPrewarmLines(): Array<{ id: string; text: string; lang: "en" | "hi" }> {
  return ACK_CATALOGUE.map((entry) => ({ id: entry.id, text: entry.text, lang: entry.ttsLang }));
}
