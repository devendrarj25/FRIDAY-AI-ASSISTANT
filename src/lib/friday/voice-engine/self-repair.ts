/**
 * FRIDAY · spoken self-repair ("do nahi nahi teen", "Rahul I mean Rohan").
 *
 * Finds a mid-sentence repair cue, takes the span just before it (`from`, one to four words) and the words
 * after it (`to`), and builds the repaired line with `from` replaced by `to`. The raw transcript is returned
 * unchanged next to the repaired one, so the audit trail and the transcript keep what was said.
 *
 * A leading cue with nothing before it is the router's job (`stripChange` and the supersede window), and a
 * bare stop word is a stop (`isImmediateStop`), never a repair. A repair of a consequential command, or one
 * that changes a number, a name or a target, carries a `readBack` question: the caller asks, never acts.
 *
 * Transcripts are data: nothing is executed and no transcript text is built into a regular expression.
 * Pure: no clock, no timers, no storage.
 */

import { spokenNumberValue } from "./hinglish-itn";
import { isImmediateStop } from "./interruption-controller";
import { stripChange } from "./utterance-router";
import { confirmQuestion, voiceConfirmKind } from "../voice-session";

export type SelfRepair = {
  raw: string;
  repaired: string;
  from: string;
  to: string;
  cue: string;
  consequential: boolean;
  readBack?: string;
};

export type SelfRepairOptions = { lang?: string };

const MAX_INPUT_CHARS = 2_000;
const MAX_FROM_WORDS = 4;
const AUDIT_MAX = 80;

type Cue = { keys: readonly string[]; strong: boolean };

/** Mid-sentence cues. Strong cues repair on their own; weak ones need a parallel span (an anchor word or a number). */
const CUES: readonly Cue[] = [
  { keys: ["nahi", "nahi"], strong: true },
  { keys: ["nahin", "nahin"], strong: true },
  { keys: ["नहीं", "नहीं"], strong: true },
  { keys: ["i", "mean"], strong: true },
  { keys: ["mera", "matlab"], strong: true },
  { keys: ["no", "wait"], strong: true },
  { keys: ["wait", "no"], strong: true },
  { keys: ["matlab"], strong: false },
  { keys: ["मतलब"], strong: false },
  { keys: ["sorry"], strong: false },
  { keys: ["actually"], strong: false },
];
const HINDI_ONLY = new Set(["matlab", "मतलब", "nahi", "nahin", "नहीं", "mera"]);

/** Words whose swap changes where an action lands (the target of a send, a delete, a move). */
const TARGET_ANCHORS = new Set(
  "the a an to in on at from into this that my your ko me mein par pe se wala wali ye yeh wo woh".split(
    " ",
  ),
);

const key = (word: string): string =>
  word
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "");

const isNumber = (word: string): boolean =>
  /\p{N}/u.test(word) || spokenNumberValue(key(word)) !== null;

const isName = (word: string): boolean => /^\p{Lu}\p{Ll}/u.test(word);

type CueHit = { at: number; cue: Cue };

function findCue(keys: readonly string[], lang: string | undefined, first: number): CueHit | null {
  for (let at = first; at < keys.length; at += 1) {
    for (const cue of CUES) {
      if (lang === "en" && HINDI_ONLY.has(cue.keys[0] ?? "")) continue;
      if (cue.keys.every((k, i) => keys[at + i] === k)) return { at, cue };
    }
  }
  return null;
}

/** Where the replaced span starts inside `before`, or -1 when there is no parallel span. */
function spanStart(before: readonly string[], after: readonly string[], strong: boolean): number {
  const floor = Math.max(0, before.length - MAX_FROM_WORDS);
  const head = key(after[0] ?? "");
  for (let i = before.length - 1; i >= floor; i -= 1) if (key(before[i] ?? "") === head) return i;
  if (isNumber(after[0] ?? "")) {
    for (let i = before.length - 1; i >= floor; i -= 1) if (isNumber(before[i] ?? "")) return i;
  }
  return strong ? before.length - 1 : -1;
}

/** How many words a leading change cue takes (the router's list, `stripChange`; a trailing "instead" is ignored). */
function leadingCueWords(tokens: readonly string[]): number {
  const strip = stripChange(tokens.join(" "));
  if (!strip.changed || !strip.rest) return strip.changed ? tokens.length : 0;
  for (let i = 0; i < tokens.length; i += 1)
    if (tokens.slice(i).join(" ").startsWith(strip.rest)) return i;
  return 0;
}

export function detectSelfRepair(raw: string, options: SelfRepairOptions = {}): SelfRepair | null {
  const text = String(raw ?? "");
  if (!text.trim() || text.length > MAX_INPUT_CHARS) return null;
  if (isImmediateStop(text)) return null;
  const tokens = text.trim().split(/\s+/u);
  const keys = tokens.map(key);
  // A leading change cue is the router's (supersede); only a cue with words of this turn before it is a repair.
  const lead = leadingCueWords(tokens);
  const hit = findCue(keys, options.lang, lead + 1);
  if (!hit) return null;
  const before = tokens.slice(lead, hit.at);
  const after = tokens.slice(hit.at + hit.cue.keys.length);
  if (!after.length || !before.length) return null;
  const start = spanStart(before, after, hit.cue.strong);
  if (start < 0) return null;
  const fromWords = before.slice(start);
  const from = fromWords.join(" ");
  const to = after.join(" ");
  const repaired = [...tokens.slice(0, lead), ...before.slice(0, start), ...after].join(" ");
  const cue = tokens.slice(hit.at, hit.at + hit.cue.keys.length).join(" ");

  const numberChanged = fromWords.some(isNumber) || after.some(isNumber);
  const nameChanged =
    fromWords.some((w, i) => isName(w) && start + i > 0) || after.some((w) => isName(w));
  const targetChanged = TARGET_ANCHORS.has(key(fromWords[0] ?? ""));
  const consequential =
    voiceConfirmKind(repaired) !== "none" || numberChanged || nameChanged || targetChanged;
  return {
    raw: text,
    repaired,
    from,
    to,
    cue,
    consequential,
    ...(consequential ? { readBack: confirmQuestion(repaired) } : {}),
  };
}

/** One short audit line for a repair (never longer than 80 characters). */
export function repairAuditLine(repair: SelfRepair): string {
  const line = `repair "${repair.cue}": ${repair.from} -> ${repair.to}`;
  return line.length <= AUDIT_MAX ? line : `${line.slice(0, AUDIT_MAX - 1)}…`;
}
