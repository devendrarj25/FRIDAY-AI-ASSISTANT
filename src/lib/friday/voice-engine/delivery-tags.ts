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
