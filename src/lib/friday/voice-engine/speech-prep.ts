/**
 * FRIDAY · Speech Prep: a pure text step on the reply right before the voice, so Hindi and Hinglish read correctly.
 *
 * (a) A Hindi (Devanagari) sentence: short English runs (three words or fewer) are written in Devanagari from a
 *     curated lexicon, so the Hindi voice does not spell them with an English accent.
 * (b) A Hinglish sentence (Latin letters, two or more unambiguous Roman Hindi words that are half or more of its
 *     Latin words) read by the Hindi voice: Roman Hindi and the English words around it are written in Devanagari.
 *     Ambiguous words ("do", "main", "to") change only inside such a sentence.
 * Never altered: English sentences, anything in quotes, code, paths, addresses, words with digits or symbols, and
 * words the lexicon does not know (names). Numbers are handled by `text-normalizer.ts`, not here.
 *
 * Cost: one pass over the text, the lexicon is parsed once and kept. No regex with nested repetition.
 */
import { scriptPolicy } from "./language-segmenter";
import { ENGLISH_IN_HINDI, ROMAN_HINDI_STRONG, ROMAN_HINDI_WEAK } from "./speech-prep-lexicon";

export type SpeechPrepOptions = {
  /** Speech Prep switch (Settings, Voice). Off leaves the reply as written. */
  enabled?: boolean;
  /** The owner's speaking voice is the Hindi voice: only then is Roman Hindi turned into Devanagari. */
  hindiVoice?: boolean;
};

/** English words in a Hindi sentence run: at most this many in a row are converted (a longer run is real English). */
export const MAX_ENGLISH_RUN = 3;

function parsePairs(source: string): Map<string, string> {
  const words = source.split(/\s+/).filter(Boolean);
  const table = new Map<string, string>();
  for (let i = 0; i + 1 < words.length; i += 2) {
    const key = words[i] as string;
    if (!table.has(key)) table.set(key, words[i + 1] as string);
  }
  return table;
}

let cached: {
  english: Map<string, string>;
  strong: Map<string, string>;
  weak: Map<string, string>;
} | null = null;

function tables() {
  cached ??= {
    english: parsePairs(ENGLISH_IN_HINDI),
    strong: parsePairs(ROMAN_HINDI_STRONG),
    weak: parsePairs(ROMAN_HINDI_WEAK),
  };
  return cached;
}

/** Sizes of the parsed tables (tests and the settings hint). */
export function speechPrepTableSizes(): { english: number; romanHindi: number; ambiguous: number } {
  const t = tables();
  return { english: t.english.size, romanHindi: t.strong.size, ambiguous: t.weak.size };
}

/** True when the speaking language is the Hindi voice (Hindi, Hinglish, or the default). */
export function usesHindiVoice(speechLang: string): boolean {
  const lang = (speechLang || "hi-IN").toLowerCase().replace("_", "-");
  return lang.startsWith("hi") || lang.includes("hinglish");
}

const DEVANAGARI = /[ऀ-ॣॱ-ॿ]/;
const PURE_WORD = /^[A-Za-z]+(?:-[A-Za-z]+)*$/;
const HARD_PROTECTED = /[\\/@_#=<>~|^*]|[A-Za-z]\.[A-Za-z]|[A-Za-z]\d|\d[A-Za-z]|:\/\//;
const LEAD = /^[("'“‘«[{<]+/;
const TRAIL = /[.,;:!?)\]}"'”’»>…।॥]+$/;

type Chunk = { pre: string; core: string; post: string; word: boolean };

function splitChunk(raw: string): Chunk {
  const pre = LEAD.exec(raw)?.[0] ?? "";
  const rest = raw.slice(pre.length);
  const post = TRAIL.exec(rest)?.[0] ?? "";
  const core = rest.slice(0, rest.length - post.length);
  const word = core.length > 0 && PURE_WORD.test(core) && !HARD_PROTECTED.test(raw);
  return { pre, core, post, word };
}

const OPEN_QUOTES: Record<string, string> = { '"': '"', "“": "”", "«": "»", "「": "」" };
const SINGLE_QUOTE_REACH = 160;

/** A single quote opens a quotation only after a space or bracket and only when a closing one follows soon. */
function singleQuoteCloser(text: string, at: number): string {
  const open = text[at];
  if (open !== "'" && open !== "‘") return "";
  const before = at === 0 ? " " : (text[at - 1] as string);
  if (!/[\s([{]/.test(before)) return "";
  const closer = open === "'" ? "'" : "’";
  const end = Math.min(text.length, at + SINGLE_QUOTE_REACH);
  for (let k = at + 2; k < end; k += 1) {
    if (text[k] === closer && !/[A-Za-z]/.test(text[k + 1] ?? " ")) return closer;
  }
  return "";
}

/** Parts of a sentence, in order, each flagged as inside a quotation. An unclosed quote protects the rest. */
function splitQuotes(text: string): { text: string; quoted: boolean }[] {
  const parts: { text: string; quoted: boolean }[] = [];
  let buffer = "";
  let closer = "";
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at] as string;
    if (closer) {
      buffer += ch;
      if (ch === closer) {
        parts.push({ text: buffer, quoted: true });
        buffer = "";
        closer = "";
      }
      continue;
    }
    const opens = OPEN_QUOTES[ch] ?? singleQuoteCloser(text, at);
    if (opens) {
      if (buffer) parts.push({ text: buffer, quoted: false });
      buffer = ch;
      closer = opens;
    } else buffer += ch;
  }
  if (buffer) parts.push({ text: buffer, quoted: Boolean(closer) });
  return parts;
}

const PLURAL_FIX = (stem: string): string => (/[ािीुूेैोौ]$/.test(stem) ? `${stem}ज़` : `${stem}्स`);

/** One English word in Devanagari, or "" when the lexicon does not know it. */
function englishToDevanagari(core: string): string {
  const english = tables().english;
  const lower = core.toLowerCase();
  const direct = english.get(lower.replace(/-/g, ""));
  if (direct) return direct;
  if (lower.includes("-")) {
    const parts = lower.split("-").map((part) => english.get(part) ?? "");
    return parts.every(Boolean) ? parts.join("-") : "";
  }
  if (lower.length > 3 && lower.endsWith("s")) {
    const stem =
      english.get(lower.slice(0, -1)) ??
      (lower.endsWith("es") ? english.get(lower.slice(0, -2)) : undefined);
    if (stem) return PLURAL_FIX(stem);
  }
  return "";
}

type Mode = "none" | "devanagari" | "hinglish";

function sentenceMode(unquoted: string, chunks: Chunk[], hindiVoice: boolean): Mode {
  const policy = scriptPolicy(unquoted);
  if (policy.lang === "hi" || policy.lang === "mixed") return "devanagari";
  if (!hindiVoice) return "none";
  const { strong } = tables();
  let latin = 0;
  let hits = 0;
  for (const chunk of chunks) {
    if (!chunk.word) continue;
    latin += 1;
    if (strong.has(chunk.core.toLowerCase())) hits += 1;
  }
  return hits >= 2 && hits * 2 >= latin ? "hinglish" : "none";
}

function toChunks(text: string): { pieces: string[]; chunks: Chunk[] } {
  const pieces = text.split(/(\s+)/);
  const chunks = pieces.map((piece, i) =>
    i % 2 === 0 && piece ? splitChunk(piece) : { pre: "", core: piece, post: "", word: false },
  );
  return { pieces, chunks };
}

function convertPart(text: string, mode: Mode, hindiVoice: boolean): string {
  const { pieces, chunks } = toChunks(text);
  const { strong, weak } = tables();
  const out = pieces.slice();
  // Roman Hindi first (only for the Hindi voice), then the English runs.
  const romanDone = new Set<number>();
  if (hindiVoice) {
    for (let i = 0; i < chunks.length; i += 2) {
      const chunk = chunks[i];
      if (!chunk?.word) continue;
      const lower = chunk.core.toLowerCase();
      const hindi = strong.get(lower) ?? (mode === "hinglish" ? weak.get(lower) : undefined);
      if (hindi) {
        out[i] = `${chunk.pre}${hindi}${chunk.post}`;
        romanDone.add(i);
      }
    }
  }
  let i = 0;
  while (i < chunks.length) {
    if (!chunks[i]?.word || romanDone.has(i)) {
      i += 2;
      continue;
    }
    // A run: consecutive English candidates with only spaces between them. Spelled letters ("A P I") are a run
    // of their own; a lone "a" before a word is the article.
    const isLetter = (k: number): boolean => {
      const chunk = chunks[k] as Chunk;
      if (chunk.core.length !== 1) return false;
      const next = chunks[k + 2];
      return !(
        chunk.core.toLowerCase() === "a" &&
        chunk.post === "" &&
        next?.word &&
        next.core.length > 1
      );
    };
    const letters = isLetter(i);
    const run: number[] = [i];
    let j = i;
    while (chunks[j]?.post === "") {
      const next = chunks[j + 2];
      if (!next?.word || romanDone.has(j + 2) || isLetter(j + 2) !== letters) break;
      run.push(j + 2);
      j += 2;
    }
    if (letters || run.length <= MAX_ENGLISH_RUN) {
      run.forEach((k) => {
        const chunk = chunks[k] as Chunk;
        const article = !letters && chunk.core.toLowerCase() === "a";
        const deva = article ? "एक" : englishToDevanagari(chunk.core);
        if (deva) out[k] = `${chunk.pre}${deva}${chunk.post}`;
      });
    }
    i = j + 2;
  }
  return out.join("");
}

/** The whole reply text after Speech Prep. Empty and off inputs come back unchanged. */
export function prepareSpeechText(text: string, options: SpeechPrepOptions = {}): string {
  if (!text || options.enabled === false) return text;
  const hindiVoice = options.hindiVoice !== false;
  return text
    .split(/(?<=[.!?।॥])(\s+)/)
    .map((piece, i) => {
      if (i % 2 === 1 || !piece) return piece;
      const parts = splitQuotes(piece);
      const unquoted = parts
        .filter((p) => !p.quoted)
        .map((p) => p.text)
        .join(" ");
      const mode = unquoted.trim()
        ? sentenceMode(unquoted, toChunks(unquoted).chunks, hindiVoice)
        : "none";
      if (mode === "none") return piece;
      return parts.map((p) => (p.quoted ? p.text : convertPart(p.text, mode, hindiVoice))).join("");
    })
    .join("");
}

/** Inline code that looks technical is hidden before markdown is stripped, so it is never transliterated. */
const CODE_MARK_OPEN = "\uE000";
const CODE_MARK_CLOSE = "\uE001";
const CODE_BASE = 0xe100;
const CODE_MAX = 0x400;

export type MaskedCode = { text: string; restore: (spoken: string) => string };

export function maskInlineCode(text: string): MaskedCode {
  const saved: string[] = [];
  const masked = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]+)`/g, (whole, body: string) => {
      if (!/[\s/\\._=:()<>-]|[a-z][A-Z]/.test(body) || saved.length >= CODE_MAX) return whole;
      saved.push(body);
      return `${CODE_MARK_OPEN}${String.fromCharCode(CODE_BASE + saved.length - 1)}${CODE_MARK_CLOSE}`;
    });
  const pattern = new RegExp(
    `${CODE_MARK_OPEN}([${String.fromCharCode(CODE_BASE)}-${String.fromCharCode(CODE_BASE + CODE_MAX - 1)}])${CODE_MARK_CLOSE}`,
    "g",
  );
  return {
    text: masked,
    restore: (spoken) =>
      saved.length
        ? spoken.replace(pattern, (_m, ch: string) => saved[ch.charCodeAt(0) - CODE_BASE] ?? "")
        : spoken,
  };
}
