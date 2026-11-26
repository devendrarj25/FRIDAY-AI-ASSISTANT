/**
 * FRIDAY · Delivery tags: small bracket cues ([warm], [pause:300]) that the voice-mode reply may carry so the
 * speech worker can shape tone and pacing. The kernel parses and strips them for the engine; this file is the
 * renderer side:
 *
 * - `stripDeliveryTags` removes them from anything shown on screen (bubbles, transcripts, notifications, copy).
 * - `keepForSpeech` keeps only allow-listed, well-formed tags (one per sentence) on the way to the speech path.
 * - `tagsForSpeech` decides by origin: only assistant-written text in voice mode keeps tags. Tool output, web
 *   text, files and anything else is data, so a tag in it is removed and can never steer the voice.
 *
 * Tags inside code fences, inline code and URLs, or touching a digit (an index, a number), are left alone: they
 * are not delivery cues. Pure text, no regex with nested repetition.
 */
import type { Feeling, FeelingLabel } from "../brain/affect";

/** The allow-listed words. `pause` also takes `:ms`. Keep in step with the kernel parser. */
export const DELIVERY_TAG_WORDS = [
  "warm",
  "soft",
  "excited",
  "calm",
  "pause",
  "breath",
  "sigh",
  "laugh-soft",
  "slow",
  "fast",
] as const;

export type DeliveryTagWord = (typeof DELIVERY_TAG_WORDS)[number];

/** Longest pause a tag can ask for, in milliseconds. A larger number is clamped. */
export const MAX_PAUSE_MS = 2000;

/** At most this many tags are kept in one sentence. */
export const MAX_TAGS_PER_SENTENCE = 1;

const WORD_SET: ReadonlySet<string> = new Set(DELIVERY_TAG_WORDS);

/** A canonical tag as written for the speech path: `[warm]`, `[pause]`, `[pause:300]`. */
const CANONICAL_TAG =
  /^\[(?:warm|soft|excited|calm|breath|sigh|laugh-soft|slow|fast|pause(?::\d{1,4})?)\]$/;

/** Code and links are never touched: a fenced block (even an unclosed one), inline code, and a URL. */
const PROTECTED = /```[\s\S]*?(?:```|$)|`[^`\n]+`|\bhttps?:\/\/\S+/g;

/** Any bracket token shaped like a tag: a word, an optional `:argument`, no spaces inside the argument. */
const TAG_SHAPE = /([ \t]*)\[\s*([A-Za-z][A-Za-z-]{0,15})\s*(?::\s*([^\]\s]{0,12}))?\s*\](?!\()/g;

/** True for a canonical tag token (`[warm]`, `[pause:300]`) exactly as `keepForSpeech` writes it. */
export function isDeliveryTag(token: string): boolean {
  return CANONICAL_TAG.test(token);
}

/** The text of a tag after the allow-list check: canonical `[word]` or `[pause:ms]`, or "" when it is not one. */
function canonicalTag(word: string, arg: string | undefined): string {
  const name = word.toLowerCase();
  if (!WORD_SET.has(name)) return "";
  if (arg === undefined) return `[${name}]`;
  if (name !== "pause" || !/^\d{1,4}$/.test(arg)) return "";
  const ms = Math.min(MAX_PAUSE_MS, Number(arg));
  return ms > 0 ? `[pause:${ms}]` : "";
}

function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(PROTECTED)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function insideRange(ranges: Array<[number, number]>, at: number, end: number): boolean {
  return ranges.some(([from, to]) => at < to && end > from);
}

/** A tag that touches a digit is part of a number or an index (`a[0]`, `5[soft]`), not a cue. */
function touchesDigit(text: string, start: number, end: number): boolean {
  return /\d/.test(text[start - 1] ?? "") || /\d/.test(text[end] ?? "");
}

type Found = { start: number; end: number; lead: string; word: string; arg: string | undefined };

function findTags(text: string): Found[] {
  const ranges = protectedRanges(text);
  const found: Found[] = [];
  for (const m of text.matchAll(TAG_SHAPE)) {
    const lead = m[1] ?? "";
    const start = m.index + lead.length;
    const end = m.index + m[0].length;
    if (insideRange(ranges, start, end) || touchesDigit(text, start, end)) continue;
    found.push({ start: m.index, end, lead, word: m[2] as string, arg: m[3] });
  }
  return found;
}

function isDeliveryShaped(found: Found): boolean {
  return canonicalTag(found.word, found.arg) !== "" || found.word.toLowerCase() === "pause";
}

/** Join the text before and after a removed tag with one space, or none at an edge or before punctuation. */
function closeGap(before: string, after: string): string {
  if (!before || !after) return "";
  if (/^[.,;:!?)\]…।॥\r\n]/.test(after)) return "";
  return /[ \t\n(]$/.test(before) ? "" : " ";
}

function rewrite(
  text: string,
  replacement: (found: Found, index: number) => string | null,
): string {
  const found = findTags(text);
  if (!found.length) return text;
  let out = "";
  let cursor = 0;
  found.forEach((tag, index) => {
    const swap = replacement(tag, index);
    if (swap === null) return;
    out += text.slice(cursor, tag.start);
    cursor = tag.end;
    if (swap !== "") {
      out += swap;
      return;
    }
    const after = text.slice(tag.end);
    const spaces = /^[ \t]*/.exec(after)?.[0].length ?? 0;
    cursor += spaces;
    out += closeGap(out, after.slice(spaces));
  });
  return out + text.slice(cursor);
}

/**
 * The text with every delivery tag removed, for anything shown on screen. A tag is one of the allow-list words
 * (any case), or `[pause:...]` with any argument. Other bracket text, such as `[note]` or `[1]`, stays.
 */
export function stripDeliveryTags(text: string): string {
  if (!text || !text.includes("[")) return text;
  return rewrite(text, (found) => (isDeliveryShaped(found) ? "" : null));
}

/**
 * The text for the speech path: allow-listed tags are kept (written in canonical form), unknown or malformed
 * tag-shaped tokens are dropped, and a sentence keeps at most `MAX_TAGS_PER_SENTENCE`. Use only for text the
 * assistant wrote in voice mode (see `tagsForSpeech`).
 */
export function keepForSpeech(text: string): string {
  if (!text || !text.includes("[")) return text;
  let lastKept = 0;
  let inSentence = 0;
  return rewrite(text, (found) => {
    const tag = canonicalTag(found.word, found.arg);
    if (!tag) return "";
    if (/[.!?।॥]/.test(text.slice(lastKept, found.start))) inSentence = 0;
    lastKept = found.end;
    if (inSentence >= MAX_TAGS_PER_SENTENCE) return "";
    inSentence += 1;
    return `${found.lead.length ? " " : ""}${tag}`;
  });
}

/** A `[` with no `]` yet is held back from the screen while it is shorter than this (it may be a tag still arriving). */
export const OPEN_TAG_HOLD_CHARS = 40;

/**
 * `stripDeliveryTags` for a reply that is still arriving. The text is the whole reply so far, so a tag split across
 * two chunks is whole by the time it is read. An unfinished `[...` at the end (no `]`, under `OPEN_TAG_HOLD_CHARS`)
 * is held back until it closes or grows past the limit; once the reply is over, call `stripDeliveryTags`.
 */
export function stripDeliveryTagsLive(raw: string): string {
  if (!raw || !raw.includes("[")) return raw;
  const at = raw.lastIndexOf("[");
  const tail = raw.slice(at);
  const held = !tail.includes("]") && tail.length <= OPEN_TAG_HOLD_CHARS;
  return stripDeliveryTags(held ? raw.slice(0, at) : raw);
}

/** A kept tag and where it sat: the number of non-space characters of the stripped text before it. */
export type TagAnchor = { at: number; tag: string };

const squash = (text: string): string => text.replace(/\s+/g, "");

/**
 * The canonical tags of a tagged reply, each anchored to the stripped text by the count of non-space characters
 * before it. Stripping only moves white space, so the anchors still fit the text that was shown (and cut into
 * sentences) on screen.
 */
export function tagAnchors(raw: string): TagAnchor[] {
  if (!raw || !raw.includes("[")) return [];
  const out: TagAnchor[] = [];
  let cursor = 0;
  let count = 0;
  for (const found of findTags(raw).filter(isDeliveryShaped)) {
    count += squash(raw.slice(cursor, found.start)).length;
    cursor = found.end;
    const tag = canonicalTag(found.word, found.arg);
    if (tag) out.push({ at: count, tag });
  }
  return out;
}

/**
 * The anchors of `script` when its stripped words are the words of `shown` (or start with them, while the reply is
 * still arriving); none when the shown text was rewritten after the model wrote it, so no tag lands in a wrong place.
 */
export function alignedAnchors(script: string, shown: string): TagAnchor[] {
  if (!script || !script.includes("[")) return [];
  const words = squash(stripDeliveryTags(script));
  const have = squash(shown);
  return have && words.startsWith(have) ? tagAnchors(script) : [];
}

/**
 * Put the tags back into one piece of the shown text. `base` is the count of non-space characters before the piece
 * in the whole shown reply; a tag at the very start belongs to the piece, a tag at its end to the next piece (to
 * this one when `last`).
 */
export function reinsertTags(
  piece: string,
  base: number,
  anchors: readonly TagAnchor[],
  last = false,
): string {
  const size = squash(piece).length;
  const mine = anchors.filter(
    (a) => a.at >= base && (a.at < base + size || (last && a.at <= base + size)),
  );
  if (!mine.length) return piece;
  let out = "";
  let from = 0;
  let seen = 0;
  const cut = (until: number): number => {
    // The index in `piece` after `until` non-space characters.
    let i = from;
    while (i < piece.length && seen < until) {
      if (!/\s/.test(piece[i] ?? "")) seen += 1;
      i += 1;
    }
    return i;
  };
  let group: string[] = [];
  let groupAt = -1;
  const flush = (end: number) => {
    if (!group.length) return;
    const before = piece.slice(from, end).replace(/\s+$/, "");
    const rest = piece.slice(end).replace(/^\s+/, "");
    out += `${before}${before ? " " : ""}${group.join(" ")}${rest ? " " : ""}`;
    from = piece.length - rest.length;
    group = [];
  };
  for (const anchor of mine) {
    if (anchor.at !== groupAt) {
      if (group.length) flush(cut(groupAt - base));
      groupAt = anchor.at;
    }
    group.push(anchor.tag);
  }
  if (group.length) flush(cut(groupAt - base));
  return out + piece.slice(from);
}

/** The number of non-space characters of a text: the unit the anchors count in. */
export function wordChars(text: string): number {
  return squash(text).length;
}

/**
 * `reinsertTags` for the pieces one cut of the shown reply was split into (`before` is the shown text before the
 * cut). The pieces keep their order, so each one starts where the one before it ended.
 */
export function reinsertParts(
  parts: readonly string[],
  before: string,
  anchors: readonly TagAnchor[],
  last = false,
): string[] {
  if (!anchors.length) return [...parts];
  let base = wordChars(before);
  return parts.map((part, index) => {
    const out = reinsertTags(part, base, anchors, last && index === parts.length - 1);
    base += wordChars(part);
    return out;
  });
}

/** Where a line of text came from. Only the assistant's own voice-mode text may carry delivery tags. */
export type DeliveryOrigin = {
  author: "assistant" | "user" | "tool" | "web" | "file" | "other";
  voiceMode: boolean;
};

/** `keepForSpeech` for assistant-written voice-mode text, `stripDeliveryTags` for everything else. */
export function tagsForSpeech(text: string, origin: DeliveryOrigin): string {
  return origin.author === "assistant" && origin.voiceMode
    ? keepForSpeech(text)
    : stripDeliveryTags(text);
}

/** The allow-list as the model is told it: `[warm] [soft] ... [pause:ms] ...`. */
export function deliveryTagList(): string {
  return DELIVERY_TAG_WORDS.map((word) =>
    word === "pause" ? "[pause] [pause:ms]" : `[${word}]`,
  ).join(" ");
}

const MASK_OPEN = "";
const MASK_CLOSE = "";
const MASK_BASE = 0xe500;
const MASK_MAX = 0x100;

export type MaskedTags = { text: string; restore: (spoken: string) => string };

/** Hide kept tags behind private-use marks so number and pronunciation steps cannot touch or spell them. */
export function maskDeliveryTags(text: string): MaskedTags {
  const saved: string[] = [];
  const masked = text.replace(/\[[a-z-]+(?::\d{1,4})?\]/g, (token, at: number) => {
    if (
      !isDeliveryTag(token) ||
      saved.length >= MASK_MAX ||
      touchesDigit(text, at, at + token.length)
    ) {
      return token;
    }
    saved.push(token);
    return `${MASK_OPEN}${String.fromCharCode(MASK_BASE + saved.length - 1)}${MASK_CLOSE}`;
  });
  const pattern = new RegExp(
    `${MASK_OPEN}([${String.fromCharCode(MASK_BASE)}-${String.fromCharCode(MASK_BASE + MASK_MAX - 1)}])${MASK_CLOSE}`,
    "g",
  );
  return {
    text: masked,
    restore: (spoken) =>
      saved.length
        ? spoken.replace(pattern, (_m, ch: string) => saved[ch.charCodeAt(0) - MASK_BASE] ?? "")
        : spoken,
  };
}

/** The owner's mood mapped to one delivery tag. Mood changes how FRIDAY sounds (tag and pace), never what she says. */
const MOOD_TAGS: Readonly<Record<FeelingLabel, DeliveryTagWord | null>> = {
  neutral: null,
  sarcasm: null,
  anger: "calm",
  anxiety: "calm",
  overwhelm: "calm",
  distress: "soft",
  sadness: "soft",
  disappointment: "soft",
  tiredness: "soft",
  confusion: "slow",
  hurry: "fast",
  excitement: "excited",
  gratitude: "warm",
  relief: "warm",
};

/** A reading below these floors is too weak to change the voice. */
export const MOOD_MIN_CONFIDENCE = 0.6;
export const MOOD_MIN_INTENSITY = 0.4;

/** The same mood tag is used on at most this many replies in a row. */
export const MOOD_TAG_MAX_RUN = 2;

/** The tag for a reading of the owner's turn, or null when it is weak or neutral. Reads labels only, never text. */
export function moodToDeliveryTag(feeling: Feeling): DeliveryTagWord | null {
  if (!(feeling.confidence >= MOOD_MIN_CONFIDENCE) || !(feeling.intensity >= MOOD_MIN_INTENSITY)) {
    return null;
  }
  return MOOD_TAGS[feeling.label] ?? null;
}

/** What the last replies carried, newest last; the caller keeps one per conversation. */
export type MoodTagState = { recent: Array<DeliveryTagWord | null> };

/** Start a fresh run tracker. */
export function newMoodTagState(): MoodTagState {
  return { recent: [] };
}

function firstSentenceHasTag(text: string): boolean {
  const end = text.search(/[.!?।\n]/);
  const head = end < 0 ? text : text.slice(0, end + 1);
  return TAG_SHAPE_ANY.test(head);
}

const TAG_SHAPE_ANY = /\[\s*[A-Za-z][A-Za-z-]{0,15}\s*(?::\s*[^\]\s]{0,12})?\s*\](?!\()/;

/**
 * Put the mood tag at the start of the reply's first sentence. Only FRIDAY's own voice-mode text gets one; tool,
 * web, file, user and other text is stripped of tags and nothing is added. No tag goes into a code fence or URL, a
 * sentence that already has one, or a third reply in a row with the same tag.
 */
export function applyMoodTag(
  reply: string,
  tag: DeliveryTagWord | null,
  origin: DeliveryOrigin,
  state?: MoodTagState,
): string {
  const base = tagsForSpeech(reply, origin);
  if (origin.author !== "assistant" || !origin.voiceMode) return base;
  const note = (used: DeliveryTagWord | null) => {
    if (state) state.recent = [...state.recent, used].slice(-MOOD_TAG_MAX_RUN);
  };
  const lead = base.length - base.trimStart().length;
  const body = base.slice(lead);
  const blocked =
    !tag ||
    !body ||
    /^(?:```|`|https?:\/\/)/i.test(body) ||
    firstSentenceHasTag(body) ||
    (state?.recent.length === MOOD_TAG_MAX_RUN && state.recent.every((t) => t === tag));
  if (blocked) {
    note(null);
    return base;
  }
  const tagged = `${base.slice(0, lead)}[${tag}] ${body}`;
  if (keepForSpeech(tagged) !== tagged) {
    note(null);
    return base;
  }
  note(tag);
  return tagged;
}
