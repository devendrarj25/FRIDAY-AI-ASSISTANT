/**
 * FRIDAY · intent memory
 *
 * The part of the intent engine that grows with the owner. Three things, all kept on this PC and all small:
 *
 *  1. Shortcuts he teaches in words ("jab main 'subah wala kaam' bolun to email check karo aur calendar dikhao"):
 *     the phrase is expanded into the full request next time, even when he spells it slightly differently.
 *  2. Phrasings that worked: after a request goes through and the next message does not correct it, the wording is
 *     remembered with what it meant, so the same wording is understood faster and with more confidence next time.
 *  3. A calibration table: how often a stated confidence was right, learned from his own corrections. A confidence is
 *     only as good as the record behind it, so the number the engine reports is pulled toward what actually happened.
 *
 * Nothing here acts. A shortcut only rewrites words, a remembered phrasing only adds weight, and the owner can read
 * and clear all of it. Method follows two ideas recorded in docs/FRIDAY_FEATURES.md: matching new wording against
 * example utterances with a threshold and a "no match" answer, and growing a memory only from what the owner
 * confirmed (a request he did not correct), never from a guess.
 */

import { readLocalState, restoreFromDisk, writeState } from "../persist";

const KEY = "friday.brain.intent-memory.v1";
const MAX_EXEMPLARS = 300;
const MAX_SHORTCUTS = 60;
const BANDS = 10;

export type Exemplar = {
  /** The wording as the owner said it. */
  phrase: string;
  norm: string;
  /** What it was understood as. */
  catalogId: string;
  action: string | null;
  uses: number;
  at: number;
};
export type Shortcut = { trigger: string; norm: string; expansion: string; at: number };
type Bucket = [right: number, total: number];
type Memory = { exemplars: Exemplar[]; shortcuts: Shortcut[]; buckets: Bucket[] };

const empty = (): Memory => ({
  exemplars: [],
  shortcuts: [],
  buckets: Array.from({ length: BANDS }, () => [0, 0] as Bucket),
});

let memory: Memory = normalise(readLocalState<Memory>(KEY));

function normalise(value: Partial<Memory> | null | undefined): Memory {
  const base = empty();
  if (!value) return base;
  return {
    exemplars: Array.isArray(value.exemplars) ? value.exemplars.slice(-MAX_EXEMPLARS) : [],
    shortcuts: Array.isArray(value.shortcuts) ? value.shortcuts.slice(-MAX_SHORTCUTS) : [],
    buckets:
      Array.isArray(value.buckets) && value.buckets.length === BANDS
        ? (value.buckets.map((row) => [Number(row?.[0]) || 0, Number(row?.[1]) || 0]) as Bucket[])
        : base.buckets,
  };
}

restoreFromDisk<Memory>(KEY, (value) => {
  memory = normalise(value);
});

const save = () => writeState(KEY, memory);

export function resetIntentMemory(): void {
  memory = empty();
}

/* ----------------------------------------------------------- similarity */

/** Lower-case, letters and digits only, repeated letters squeezed, so "kholo", "khollo" and "khol do" sit close. */
export function normalisePhrase(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/(\p{L})\1+/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value.replace(/\s+/g, "  ")}  `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/**
 * Words that mean the same thing in the owner's languages, folded to one word, and filler that carries no meaning.
 * "file send karo" and "file bhej do" then read the same, which letters alone cannot see.
 */
const SAME_AS: [string, string[]][] = [
  ["open", ["open", "launch", "kholo", "khol", "kholna", "chalu", "start", "kholdo"]],
  ["send", ["send", "bhej", "bhejo", "bhejna", "forward", "share", "bhejdo"]],
  ["show", ["show", "dikhao", "dikha", "dikhana", "display", "dikhado"]],
  ["delete", ["delete", "remove", "hatao", "hata", "mita", "mitao", "saaf", "erase"]],
  ["find", ["find", "search", "dhundo", "dhoondo", "khojo", "dhund", "lookup"]],
  ["check", ["check", "dekho", "dekh", "jaanch", "verify"]],
  ["remind", ["remind", "reminder", "yaad", "alarm"]],
  ["make", ["make", "create", "banao", "bana", "generate", "prepare"]],
  ["tell", ["tell", "batao", "bata", "bataiye", "explain"]],
  ["mail", ["mail", "email", "gmail", "imel"]],
  ["file", ["file", "document", "doc", "dastavez"]],
  ["morning", ["morning", "subah", "subha", "savere"]],
  ["evening", ["evening", "shaam", "sham"]],
  ["work", ["work", "kaam", "kam", "task"]],
];
const FOLD = new Map(
  SAME_AS.flatMap(([head, words]) => words.map((word) => [word, head] as const)),
);
const FILLER = new Set(
  "do dena de karo kar kardo please plz pls zara jara na ji bhai yaar mujhe mere liye meri mera me mein ko ka ki ke se aur and the a an to for of wala wali".split(
    " ",
  ),
);

/** The phrase reduced to its meaning words, so a paraphrase lands near the original. */
export function canonicalPhrase(text: string): string {
  const words = normalisePhrase(text)
    .split(" ")
    .filter((word) => word && !FILLER.has(word))
    .map((word) => FOLD.get(word) ?? word);
  return words.join(" ");
}

function gramSimilarity(x: string, y: string): number {
  const a = trigrams(x);
  const b = trigrams(y);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** 0..1: the better of the letters (spelling variants) and the meaning words (paraphrases). */
export function phraseSimilarity(a: string, b: string): number {
  const letters = gramSimilarity(normalisePhrase(a), normalisePhrase(b));
  const ca = canonicalPhrase(a);
  const cb = canonicalPhrase(b);
  // Two phrases that fold to nothing but filler must not match each other.
  const meaning = ca && cb && ca.length >= 5 && cb.length >= 5 ? gramSimilarity(ca, cb) : 0;
  return Math.max(letters, meaning);
}

/* ------------------------------------------------------------ shortcuts */

const TEACH =
  /^(?:jab|when)\s+(?:main|mai|mein|i)\s+['"“‘]?(.{2,60}?)['"”’]?\s+(?:bolu|bolun|bolta|bolti|bolunga|bolungi|boloon|say|said)\b[\s,]*(?:to|then)?\s*(.{4,300})$/i;

/** "jab main 'subah wala kaam' bolun to email check karo aur calendar dikhao": the phrase and what it stands for. */
const TEACH_EN_QUOTED =
  /^when\s+i\s+(?:say|type)\s+['"“‘](.{2,60}?)['"”’][\s,]+(?:then\s+)?(.{4,300})$/i;
const TEACH_EN_PLAIN = /^when\s+i\s+(?:say|type)\s+(\S+(?:\s\S+){0,2}?)[\s,]+then\s+(.{4,300})$/i;

export function parseShortcutTeaching(text: string): { trigger: string; expansion: string } | null {
  const value = String(text || "").trim();
  if (value.length > 500) return null;
  const match = value.match(TEACH) ?? value.match(TEACH_EN_QUOTED) ?? value.match(TEACH_EN_PLAIN);
  const trigger = match?.[1]?.trim();
  const expansion = match?.[2]?.trim().replace(/[.!]+$/, "");
  if (!trigger || !expansion || normalisePhrase(trigger) === normalisePhrase(expansion))
    return null;
  return { trigger, expansion };
}

export function teachShortcut(trigger: string, expansion: string): Shortcut {
  const norm = normalisePhrase(trigger);
  const row: Shortcut = {
    trigger: trigger.trim(),
    norm,
    expansion: expansion.trim(),
    at: Date.now(),
  };
  memory.shortcuts = [...memory.shortcuts.filter((item) => item.norm !== norm), row].slice(
    -MAX_SHORTCUTS,
  );
  save();
  return row;
}

export function forgetShortcut(trigger: string): boolean {
  const norm = normalisePhrase(trigger);
  const before = memory.shortcuts.length;
  memory.shortcuts = memory.shortcuts.filter((item) => item.norm !== norm);
  if (memory.shortcuts.length !== before) save();
  return memory.shortcuts.length !== before;
}

export function listShortcuts(): Shortcut[] {
  return [...memory.shortcuts];
}

const SHORTCUT_MATCH = 0.75;

/** The full request a taught phrase stands for, when the whole message is (close to) that phrase. */
export function expandShortcut(text: string): { expansion: string; trigger: string } | null {
  const value = String(text || "").trim();
  if (!value || value.split(/\s+/).length > 8) return null;
  let best: { row: Shortcut; score: number } | null = null;
  for (const row of memory.shortcuts) {
    const score = phraseSimilarity(value, row.trigger);
    if (score >= SHORTCUT_MATCH && (!best || score > best.score)) best = { row, score };
  }
  return best ? { expansion: best.row.expansion, trigger: best.row.trigger } : null;
}

/* ------------------------------------------------------------ exemplars */

const EXEMPLAR_MATCH = 0.78;

/** Remember a wording that went through uncorrected. A repeat only adds to its count. */
export function rememberPhrasing(
  phrase: string,
  meaning: { catalogId: string; action: string | null },
): void {
  const norm = normalisePhrase(phrase);
  if (norm.split(" ").length < 2 || norm.length > 160) return;
  const found = memory.exemplars.find(
    (row) => row.norm === norm && row.catalogId === meaning.catalogId,
  );
  if (found) {
    found.uses += 1;
    found.at = Date.now();
  } else {
    memory.exemplars = [
      ...memory.exemplars,
      {
        phrase: phrase.trim().slice(0, 160),
        norm,
        catalogId: meaning.catalogId,
        action: meaning.action,
        uses: 1,
        at: Date.now(),
      },
    ].slice(-MAX_EXEMPLARS);
  }
  save();
}

/** A remembered wording close to this one, and what it meant. Nothing close enough is a clear "no match". */
export function recallPhrasing(
  text: string,
): { catalogId: string; action: string | null; score: number; uses: number } | null {
  let best: { row: Exemplar; score: number } | null = null;
  for (const row of memory.exemplars) {
    const score = phraseSimilarity(text, row.phrase);
    if (
      score >= EXEMPLAR_MATCH &&
      (!best || score > best.score || (score === best.score && row.uses > best.row.uses))
    )
      best = { row, score };
  }
  return best
    ? {
        catalogId: best.row.catalogId,
        action: best.row.action,
        score: Number(best.score.toFixed(2)),
        uses: best.row.uses,
      }
    : null;
}

export function forgetPhrasings(): number {
  const count = memory.exemplars.length;
  memory.exemplars = [];
  save();
  return count;
}

export function listPhrasings(): Exemplar[] {
  return [...memory.exemplars];
}

/* ---------------------------------------------------------- calibration */

const PRIOR = 10;
const MIN_RECORD = 8;
const MAX_DOWN = 0.25;
const MAX_UP = 0.15;

const bandOf = (confidence: number) =>
  Math.max(0, Math.min(BANDS - 1, Math.floor(confidence * BANDS)));

/** After a turn: was the stated confidence right? A correction by the owner counts as wrong. */
export function noteOutcome(confidence: number, right: boolean, weight = 1): void {
  const bucket = memory.buckets[bandOf(confidence)];
  if (!bucket) return;
  bucket[1] += weight;
  if (right) bucket[0] += weight;
  save();
}

/**
 * The confidence pulled toward what actually happened in its band. With no record the number is returned as it was;
 * the record counts for more as it grows, never more than the number of turns behind it.
 */
export function calibrate(confidence: number): number {
  const bucket = memory.buckets[bandOf(confidence)];
  // Too few turns in this band say nothing yet.
  if (!bucket || bucket[1] < MIN_RECORD) return confidence;
  const [right, total] = bucket;
  const pulled = (right + PRIOR * confidence) / (total + PRIOR);
  // However the record reads, one stretch of bad luck cannot move a number far.
  const bounded = Math.max(confidence - MAX_DOWN, Math.min(confidence + MAX_UP, pulled));
  return Math.round(Math.max(0, Math.min(1, bounded)) * 100) / 100;
}

export function calibrationTable(): { band: string; total: number; right: number }[] {
  return memory.buckets.map(([right, total], index) => ({
    band: `${index * 10}-${index * 10 + 10}%`,
    total,
    right,
  }));
}

/** Everything learned, in plain words, for the owner to read. */
export function describeIntentMemory(): string {
  const lines: string[] = [];
  if (memory.shortcuts.length) {
    lines.push("Shortcuts you taught me:");
    for (const row of memory.shortcuts) lines.push(`• "${row.trigger}" means: ${row.expansion}`);
  } else {
    lines.push(
      "You haven't taught me any shortcuts yet. Say: jab main 'subah wala kaam' bolun to <what to do>.",
    );
  }
  lines.push(`Wordings I remember as understood: ${memory.exemplars.length}.`);
  const seen = memory.buckets.reduce((sum, row) => sum + row[1], 0);
  lines.push(
    seen
      ? `How often my confidence was right is tracked over ${seen} turns, from your corrections.`
      : "I haven't tracked how often my confidence was right yet.",
  );
  return lines.join("\n");
}
