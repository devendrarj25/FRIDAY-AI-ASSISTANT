/**
 * FRIDAY · the owner's personal vocabulary: what the ear is biased toward and what is fixed after it hears.
 *
 * Two tiers, kept apart on purpose:
 *   - hint: a word the ear is told to expect (`buildHints`, `streamHotwords`). It only biases recognition and never
 *     rewrites the transcript.
 *   - replace: a spelling the ear gets wrong in a known way. After a turn is heard, a whole word or whole phrase
 *     whose phonetic key equals a heard variant is written the owner's way (`applyReplacements`). The matcher never
 *     works inside another word, never touches digits, and returns what it changed so the caller can show it and
 *     undo it (`undoReplacements`).
 * The phonetic keys (`phoneticFold`, `replaceKey`) fold Devanagari, Roman Hindi and English spellings of one sound
 * to one key, so मीना, Meena and Mina are one name. Nothing here learns on its own: `proposeLearned` only suggests
 * a correction the owner made three times, and a learned entry does nothing until the owner accepts it. A string
 * that looks private (a password, a card number, an address, a key) is never listed or applied; when the injected
 * check throws, the string counts as private. Pure functions: no storage, no clock, no timers. The caller persists.
 *
 * `streamHotwords` (the first part of this file) builds the ear's list from the renderer's sources: each entry
 * is trimmed, control characters removed, at most 40 characters (longer ones are dropped, never cut mid-word),
 * deduplicated without regard to case, and the list stops at 64, in the order the sources are given (names first).
 * Hotwords are data: they only bias recognition and never become a command.
 */

import { lexiconKey } from "./hinglish-lexicon";

export const STREAM_HOTWORDS_MAX = 64;
export const STREAM_HOTWORD_CHARS = 40;

type Words = readonly (string | null | undefined)[] | null | undefined;

export type HotwordSources = {
  /** Her name, the wake word, the name the owner is called. */
  names?: Words;
  /** Contact names the owner keeps on this PC. */
  contacts?: Words;
  /** Application names FRIDAY can open. */
  apps?: Words;
  /** The owner's dictionary (Settings > Voice). */
  vocabulary?: Words;
};

function clean(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function streamHotwords(sources: HotwordSources | null | undefined): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  const groups = [sources?.names, sources?.contacts, sources?.apps, sources?.vocabulary];
  for (const group of groups) {
    for (const raw of group ?? []) {
      if (kept.length >= STREAM_HOTWORDS_MAX) return kept;
      const word = clean(raw);
      if (!word || [...word].length > STREAM_HOTWORD_CHARS) continue;
      const key = word.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(word);
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------------------------
// The personal vocabulary: entries, phonetic keys, hints, replacements, learned suggestions, the owner's list.
// ---------------------------------------------------------------------------------------------------------------

export type VocabTier = "hint" | "replace";
export type VocabSource = "owner" | "registry" | "learned";

export type VocabEntry = {
  id: string;
  /** Spellings the ear produces for this word (empty for a pure hint). */
  heard: string[];
  /** The way the owner wants it written. */
  written: string;
  tier: VocabTier;
  source: VocabSource;
  /** A learned entry is inactive until this is true. */
  learnedConsent?: boolean;
  uses: number;
  lastUsedFrame?: number;
};

/** "hi" and "hinglish" use the full phonetic fold; "en" only folds case, accents, spaces and invisible marks. */
export type FoldLang = "hi" | "en" | "hinglish";

export const DEFAULT_HINT_MAX = 60;
const WRITTEN_MAX_CHARS = 80;
const PHRASE_TOKENS_MAX = 6;
const MIN_KEY_CHARS = 2;
const SOURCE_RANK: Record<VocabSource, number> = { owner: 0, registry: 1, learned: 2 };

// --- phonetic fold ---------------------------------------------------------------------------------------------

const TOKEN = /[\p{L}\p{M}\p{N}\u200b-\u200d\u2060\ufeff]+(?:['\u2019\u02bc][\p{L}\p{M}]+)*/gu;
const DEVANAGARI = /[ऀ-ॿ]/;
const HAS_DIGIT = /\p{N}/u;
const VIRAMA = "\u094d";

const CONSONANT: Record<string, string> = {
  क: "k",
  ख: "kh",
  ग: "g",
  घ: "gh",
  ङ: "n",
  च: "ch",
  छ: "chh",
  ज: "j",
  झ: "jh",
  ञ: "n",
  ट: "t",
  ठ: "th",
  ड: "d",
  ढ: "dh",
  ण: "n",
  त: "t",
  थ: "th",
  द: "d",
  ध: "dh",
  न: "n",
  प: "p",
  फ: "ph",
  ब: "b",
  भ: "bh",
  म: "m",
  य: "y",
  र: "r",
  ल: "l",
  ळ: "l",
  व: "v",
  श: "sh",
  ष: "sh",
  स: "s",
  ह: "h",
};
const INDEPENDENT: Record<string, string> = {
  अ: "a",
  आ: "a",
  इ: "i",
  ई: "i",
  उ: "u",
  ऊ: "u",
  ऋ: "ri",
  ए: "e",
  ऐ: "ai",
  ओ: "o",
  औ: "au",
  ऑ: "o",
  ऍ: "e",
};
const MATRA: Record<string, string> = {
  "ा": "a",
  "ि": "i",
  "ी": "i",
  "ु": "u",
  "ू": "u",
  "ृ": "ri",
  "े": "e",
  "ै": "ai",
  "ो": "o",
  "ौ": "au",
  "ॉ": "o",
  "ॅ": "e",
};
const LABIAL = "पफबभम";

function devanagariToRoman(token: string): string {
  const chars = [...token];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    const next = chars[i + 1];
    const consonant = CONSONANT[c];
    if (consonant !== undefined) {
      out += consonant;
      if (next === VIRAMA) i++;
      else if (next !== undefined && MATRA[next] === undefined && DEVANAGARI.test(next)) out += "a";
      continue;
    }
    const vowel = INDEPENDENT[c] ?? MATRA[c];
    if (vowel !== undefined) out += vowel;
    else if (c === "\u0902") out += next !== undefined && LABIAL.includes(next) ? "m" : "n";
    else if (c === "\u0903") out += "h";
    else if (c >= "०" && c <= "९") out += String(c.charCodeAt(0) - 0x966);
    else if (!DEVANAGARI.test(c)) out += c;
  }
  return out;
}

function soundOf(token: string, loose: boolean): string {
  let s = token
    .replace(/ph/g, "f")
    .replace(/w/g, "v")
    .replace(/z/g, "j")
    .replace(/ck/g, "k")
    .replace(/ee/g, "i")
    .replace(/oo/g, "u")
    .replace(/ii+/g, "i")
    .replace(/uu+/g, "u")
    .replace(/aa+/g, "a");
  if (loose) s = s.replace(/th/g, "t");
  s = s
    .replace(/(\p{L})\1+/gu, "$1")
    .replace(/ahin$/, "ahi")
    .replace(/iy?a/g, "ya");
  if (s.length >= 3 && s.endsWith("a") && !HAS_DIGIT.test(s)) s = s.slice(0, -1);
  return s;
}

function foldToken(raw: string, lang: FoldLang, loose: boolean): string {
  const plain = raw.toLowerCase();
  if (/^[a-z0-9]+$/.test(plain)) return lang === "en" ? plain : soundOf(plain, loose);
  let s = lexiconKey(raw)
    .replace(/[\p{Cf}'\u2019\u02bc`]/gu, "")
    .normalize("NFC");
  if (DEVANAGARI.test(s)) s = devanagariToRoman(s);
  s = s.normalize("NFD").replace(/\p{M}/gu, "");
  return lang === "en" ? s : soundOf(s, loose);
}

function tokensOf(text: string): { raw: string; start: number; end: number }[] {
  const out: { raw: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(TOKEN)) {
    out.push({ raw: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

function foldText(text: unknown, lang: FoldLang, loose: boolean): string {
  if (typeof text !== "string") return "";
  const keys: string[] = [];
  for (const t of tokensOf(text)) {
    const key = foldToken(t.raw, lang, loose);
    if (key) keys.push(key);
  }
  return keys.join(" ");
}

/**
 * One key for the many ways a word is spelled: lower case, accents, zero-width joiners and the nukta dropped,
 * Devanagari written in Roman letters, then kya/kia, nahi/nahin, v/w, ph/f, z/j, aa/a, ee/i, oo/u, doubled letters
 * and a final "a" folded. Words are separated by one space; punctuation is dropped; digits are kept as they are.
 */
export function phoneticFold(text: string, lang: FoldLang = "hinglish"): string {
  return foldText(text, lang, false);
}

/** The key of the replace tier: `phoneticFold` plus th folded to t, so near spellings (thakur, takur) match. */
export function replaceKey(text: string, lang: FoldLang = "hinglish"): string {
  return foldText(text, lang, true);
}

// --- what counts as private ------------------------------------------------------------------------------------

const SENSITIVE_WORDS =
  /(?:password|passcode|passwd|\bpin\b|\botp\b|\bcvv\b|\bsecret\b|api[ _-]?key|\btoken\b|credential|private key|पासवर्ड|पासकोड|ओटीपी|पिन कोड|गुप्त कोड)/iu;
const SENSITIVE_DIGITS = /\p{Nd}(?:[\s.-]?\p{Nd}){7,}/u;
const SENSITIVE_MAIL = /\S@\S/u;
const SENSITIVE_KEY = /\b(?:sk|pk|ghp|gho|xox[abp]|akia)[-_][a-z0-9_-]{8,}/iu;
const SENSITIVE_BLOB = /[a-z0-9_-]{24,}/i;

/** A string that looks private: a secret word, a long number, a mail address, an API key or a long random token. */
export function looksSensitive(text: string): boolean {
  const s = String(text ?? "");
  if (!s) return false;
  if (
    SENSITIVE_WORDS.test(s) ||
    SENSITIVE_DIGITS.test(s) ||
    SENSITIVE_MAIL.test(s) ||
    SENSITIVE_KEY.test(s)
  ) {
    return true;
  }
  const blob = s.match(SENSITIVE_BLOB)?.[0];
  return blob !== undefined && /\d/.test(blob) && /[a-z]/i.test(blob);
}

type Check = (text: string) => boolean;

function privateString(text: string, injected: Check | undefined): boolean {
  if (looksSensitive(text)) return true;
  if (!injected) return false;
  try {
    return injected(text) !== false;
  } catch {
    return true;
  }
}

// --- entries ---------------------------------------------------------------------------------------------------

type Norm = {
  index: number;
  id: string;
  heard: string[];
  written: string;
  tier: VocabTier;
  source: VocabSource;
  consent: boolean;
  uses: number;
  last: number;
  entry: VocabEntry;
};

function normalise(
  entries: readonly VocabEntry[] | null | undefined,
  injected: Check | undefined,
): Norm[] {
  const out: Norm[] = [];
  (entries ?? []).forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || typeof raw.written !== "string") return;
    const written = clean(raw.written);
    const source: VocabSource = raw.source in SOURCE_RANK ? raw.source : "owner";
    const consent = source !== "learned" || raw.learnedConsent === true;
    if (!written || !consent || [...written].length > WRITTEN_MAX_CHARS) return;
    const heard = (Array.isArray(raw.heard) ? raw.heard : []).map(clean).filter(Boolean);
    if ([written, ...heard].some((s) => privateString(s, injected))) return;
    out.push({
      index,
      id: String(raw.id ?? ""),
      heard,
      written,
      tier: raw.tier === "replace" ? "replace" : "hint",
      source,
      consent,
      uses: Number.isFinite(raw.uses) ? raw.uses : 0,
      last: Number.isFinite(raw.lastUsedFrame) ? (raw.lastUsedFrame as number) : -1,
      entry: raw,
    });
  });
  return out;
}

function rank(list: Norm[], mode: "usage" | "recent" | "order"): Norm[] {
  return [...list].sort((a, b) => {
    const bySource = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    if (bySource) return bySource;
    if (mode === "recent") return b.last - a.last || b.uses - a.uses || a.index - b.index;
    if (mode === "usage") return b.uses - a.uses || b.last - a.last || a.index - b.index;
    return a.index - b.index;
  });
}

export type HintOptions = {
  max?: number;
  recentFirst?: boolean;
  /** An extra private-string check. When it throws, the string counts as private. */
  isSensitive?: Check;
};

/**
 * The ordered hotword list for the ear: the written form of every active hint and replace entry, owner entries
 * before registry before learned, most used first (or most recently used first), no duplicates, no private string,
 * at most `max` (default 60, never above the ear's 64) of at most 40 characters.
 */
export function buildHints(
  entries: readonly VocabEntry[] | null | undefined,
  opts: HintOptions = {},
): string[] {
  const asked =
    opts.max === undefined || !Number.isFinite(opts.max) ? DEFAULT_HINT_MAX : Math.trunc(opts.max);
  const cap = Math.max(0, Math.min(asked, STREAM_HOTWORDS_MAX));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of rank(
    normalise(entries, opts.isSensitive),
    opts.recentFirst ? "recent" : "usage",
  )) {
    if (out.length >= cap) break;
    if ([...e.written].length > STREAM_HOTWORD_CHARS) continue;
    const key = e.written.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e.written);
  }
  return out;
}

/** The command-name hint tier holds up to this many written names (the ear takes the first 64 it can use). */
export const COMMAND_HINTS_MAX = 100;

/**
 * The hint list for the command lane: the written form of each registry name, one per phonetic key (so Spotify and
 * Spotifi count once), in the order given, no private string, none over 40 characters, at most 100.
 */
export function commandHints(
  names: readonly string[] | null | undefined,
  max: number = COMMAND_HINTS_MAX,
): string[] {
  const cap = Math.max(0, Math.min(Math.trunc(max), COMMAND_HINTS_MAX));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of Array.isArray(names) ? names : []) {
    if (out.length >= cap) break;
    if (typeof raw !== "string") continue;
    const written = raw.trim();
    if (!written || [...written].length > STREAM_HOTWORD_CHARS || looksSensitive(written)) continue;
    const key = phoneticFold(written);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(written);
  }
  return out;
}

// --- replacements ----------------------------------------------------------------------------------------------

export type Replacement = {
  from: string;
  to: string;
  id: string;
  /** Where the written form starts in the returned text. */
  at: number;
};

export type ReplaceOptions = { lang?: FoldLang; isSensitive?: Check };

/**
 * Writes the owner's spelling for a heard variant. Only active replace entries act; a variant matches whole
 * tokens or a whole phrase (words apart by spaces only) on `replaceKey`, never part of a word, and never a token
 * with a digit. The longest phrase wins, then the entry that ranks first. `changes` is what was replaced, for the
 * owner to see and for `undoReplacements`.
 */
export function applyReplacements(
  transcript: string,
  entries: readonly VocabEntry[] | null | undefined,
  opts: ReplaceOptions = {},
): { text: string; changes: Replacement[] } {
  const text = typeof transcript === "string" ? transcript : "";
  const lang = opts.lang ?? "hinglish";
  const index = new Map<string, Norm>();
  let longest = 0;
  for (const e of rank(normalise(entries, opts.isSensitive), "order")) {
    if (e.tier !== "replace") continue;
    for (const variant of [...e.heard, e.written]) {
      const parts = tokensOf(variant);
      if (
        !parts.length ||
        parts.length > PHRASE_TOKENS_MAX ||
        parts.some((t) => HAS_DIGIT.test(t.raw))
      )
        continue;
      const keys = parts.map((t) => foldToken(t.raw, lang, true));
      if (keys.some((k) => !k) || keys.join("").length < MIN_KEY_CHARS) continue;
      const key = keys.join(" ");
      if (!index.has(key)) index.set(key, e);
      longest = Math.max(longest, keys.length);
    }
  }
  if (!text || !index.size) return { text, changes: [] };

  const words = tokensOf(text);
  const folded = words.map((w) => (HAS_DIGIT.test(w.raw) ? "" : foldToken(w.raw, lang, true)));
  const changes: Replacement[] = [];
  let out = "";
  let cursor = 0;
  for (let i = 0; i < words.length;) {
    let advanced = 0;
    for (let n = Math.min(longest, words.length - i); n >= 1 && !advanced; n--) {
      const window = folded.slice(i, i + n);
      if (window.some((k) => !k)) continue;
      let spaced = true;
      for (let k = i; k < i + n - 1; k++) {
        const gap = text.slice(
          (words[k] as { end: number }).end,
          (words[k + 1] as { start: number }).start,
        );
        if (!/^\s+$/u.test(gap)) spaced = false;
      }
      const hit = spaced ? index.get(window.join(" ")) : undefined;
      if (!hit) continue;
      const start = (words[i] as { start: number }).start;
      const end = (words[i + n - 1] as { end: number }).end;
      const from = text.slice(start, end);
      advanced = n;
      if (from === hit.written) continue;
      out += text.slice(cursor, start);
      changes.push({ from, to: hit.written, id: hit.id, at: out.length });
      out += hit.written;
      cursor = end;
    }
    i += advanced || 1;
  }
  return { text: out + text.slice(cursor), changes };
}

/** Puts the heard text back for each change whose written form is still where it was put (later edits are kept). */
export function undoReplacements(text: string, changes: readonly Replacement[]): string {
  let out = String(text ?? "");
  for (const c of [...changes].sort((a, b) => b.at - a.at)) {
    if (out.slice(c.at, c.at + c.to.length) === c.to)
      out = out.slice(0, c.at) + c.from + out.slice(c.at + c.to.length);
  }
  return out;
}

/** A copy of the list with the use count of each id raised (once per occurrence) and the frame noted. */
export function noteUses(
  entries: readonly VocabEntry[],
  ids: readonly string[],
  frame: number,
): VocabEntry[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return entries.map((e) => {
    const n = e && counts.get(e.id);
    return n ? { ...e, heard: [...e.heard], uses: (e.uses || 0) + n, lastUsedFrame: frame } : e;
  });
}

/** The owner said yes: a copy of the learned entry that is now active. */
export function acceptLearned(entry: VocabEntry): VocabEntry {
  return { ...entry, heard: [...entry.heard], learnedConsent: true };
}

// --- learning from the owner's corrections ---------------------------------------------------------------------

export type CorrectionPair = { heard: string; corrected: string };

export type LearnOptions = {
  /** How many times the same correction must be seen (default 3). */
  minCount?: number;
  /** The most proposals returned (default 20). */
  max?: number;
  /** Entries the owner already has; their corrections are not proposed again. */
  existing?: readonly VocabEntry[];
  /** How far apart (share of the longer key) the two spellings may sound to count as a mishearing. Default 0.5. */
  maxDistance?: number;
  isSensitive?: Check;
};

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] as number;
}

function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const spaceless = (text: string): string => replaceKey(text).replace(/ /g, "");

/**
 * Suggests entries from the owner's own corrections: a short span of the heard text that the owner changed to one
 * spelling at least `minCount` times, where both spellings sound alike. A rewrite, a digit change or a private
 * string is never proposed. Every proposal has `learnedConsent: false` and does nothing until `acceptLearned`.
 */
export function proposeLearned(
  history: readonly CorrectionPair[],
  opts: LearnOptions = {},
): VocabEntry[] {
  const minCount = Math.max(1, opts.minCount ?? 3);
  const limit = opts.maxDistance ?? 0.5;
  const known = new Set<string>();
  for (const e of opts.existing ?? []) {
    if (!e || typeof e.written !== "string") continue;
    for (const v of Array.isArray(e.heard) ? e.heard : [])
      known.add(`${spaceless(v)}|${clean(e.written)}`);
  }
  const groups = new Map<
    string,
    { heard: string[]; written: string; count: number; first: number }
  >();
  (history ?? []).forEach((pair, order) => {
    if (!pair || typeof pair.heard !== "string" || typeof pair.corrected !== "string") return;
    const a = tokensOf(pair.heard).map((t) => t.raw);
    const b = tokensOf(pair.corrected).map((t) => t.raw);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const heardSpan = a.slice(p, a.length - s);
    const writtenSpan = b.slice(p, b.length - s);
    if (!heardSpan.length || !writtenSpan.length || heardSpan.length > 3 || writtenSpan.length > 3)
      return;
    const heard = heardSpan.join(" ");
    const written = writtenSpan.join(" ");
    if (heard === written || HAS_DIGIT.test(heard) || HAS_DIGIT.test(written)) return;
    const heardKey = spaceless(heard);
    const writtenKey = spaceless(written);
    if (!heardKey || !writtenKey) return;
    if (distance(heardKey, writtenKey) / Math.max(heardKey.length, writtenKey.length) > limit)
      return;
    const key = `${heardKey}|${written}`;
    const group = groups.get(key) ?? { heard: [], written, count: 0, first: order };
    group.count++;
    if (!group.heard.some((h) => h.toLowerCase() === heard.toLowerCase())) group.heard.push(heard);
    groups.set(key, group);
  });
  const out: VocabEntry[] = [];
  const ordered = [...groups.entries()]
    .filter(([key, g]) => g.count >= minCount && !known.has(key))
    .sort((x, y) => y[1].count - x[1].count || x[1].first - y[1].first);
  for (const [key, g] of ordered) {
    if (out.length >= (opts.max ?? 20)) break;
    if ([g.written, ...g.heard].some((s) => privateString(s, opts.isSensitive))) continue;
    out.push({
      id: `learned-${fnv(key)}`,
      heard: g.heard,
      written: g.written,
      tier: "replace",
      source: "learned",
      learnedConsent: false,
      uses: 0,
    });
  }
  return out;
}

// --- the owner's list ------------------------------------------------------------------------------------------

export type OwnerRow = {
  id: string;
  heard: string[];
  written: string;
  tier: VocabTier;
  source: VocabSource;
  sourceLabel: string;
  status: "on" | "waiting" | "blocked";
  statusLabel: string;
  /** One plain line: the word itself, or "heard becomes written". */
  summary: string;
  uses: number;
};

export type OwnerGroup = { tier: VocabTier; title: string; detail: string; rows: OwnerRow[] };

const SOURCE_LABEL: Record<VocabSource, string> = {
  owner: "You added",
  registry: "From your contacts and apps",
  learned: "Noticed from your corrections",
};

/** What the owner sees in Settings: both tiers, each row with where it came from and whether it is in use. */
export function ownerView(
  entries: readonly VocabEntry[] | null | undefined,
  opts: { isSensitive?: Check } = {},
): OwnerGroup[] {
  const groups: OwnerGroup[] = [
    {
      tier: "hint",
      title: "Words I listen for",
      detail: "I expect to hear these, so I get them right more often.",
      rows: [],
    },
    {
      tier: "replace",
      title: "Words I fix after I hear them",
      detail: "When I hear the left side, I write the right side. Every change can be undone.",
      rows: [],
    },
  ];
  const rows: { norm: number; row: OwnerRow }[] = [];
  (entries ?? []).forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || typeof raw.written !== "string") return;
    const written = clean(raw.written);
    if (!written) return;
    const source: VocabSource = raw.source in SOURCE_RANK ? raw.source : "owner";
    const heard = (Array.isArray(raw.heard) ? raw.heard : []).map(clean).filter(Boolean);
    const tier: VocabTier = raw.tier === "replace" ? "replace" : "hint";
    const blocked = [written, ...heard].some((s) => privateString(s, opts.isSensitive));
    const waiting = source === "learned" && raw.learnedConsent !== true;
    const status = blocked ? "blocked" : waiting ? "waiting" : "on";
    const statusLabel = blocked
      ? "Looks private, so I never use it"
      : waiting
        ? "Waiting for your OK"
        : "On";
    const summary =
      tier === "replace" && heard.length ? `${heard.join(", ")} becomes ${written}` : written;
    const row: OwnerRow = {
      id: String(raw.id ?? ""),
      heard,
      written,
      tier,
      source,
      sourceLabel: SOURCE_LABEL[source],
      status,
      statusLabel,
      summary,
      uses: Number.isFinite(raw.uses) ? raw.uses : 0,
    };
    rows.push({ norm: index, row });
  });
  rows.sort(
    (a, b) =>
      SOURCE_RANK[a.row.source] - SOURCE_RANK[b.row.source] ||
      b.row.uses - a.row.uses ||
      a.norm - b.norm,
  );
  for (const { row } of rows) groups[row.tier === "hint" ? 0 : 1]?.rows.push(row);
  return groups;
}
