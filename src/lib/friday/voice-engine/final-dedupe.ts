/**
 * FRIDAY · one final utterance, one turn.
 *
 * The final transcript reaches the conductor along several roads (the local ear, the cloud caption's own final,
 * a provisional line the Brain already drafted from, an IPC call that was sent again). Whatever the road, the
 * same words said once must run one turn. `createFinalDeduper` is the pure rule for that, asked at the single
 * accept point. Time is injected; nothing here reads a clock, a store or a device.
 *
 * What counts as the same utterance:
 *   - the same utterance id from the same source, whenever it arrives inside the id memory (an id is never a
 *     second utterance);
 *   - otherwise the same words (case, punctuation, spacing, digit script and Devanagari spelling variants
 *     folded) inside a short window, when no reply began in between.
 * What never counts: a deliberate repeat after FRIDAY began to answer, a repeat after the window, two
 * different ids from one source, a short line while an approval is open (a yes or no always passes once; only a
 * copy inside `APPROVAL_COPY_MS` is held back) and a line the caller marks `alwaysPass` (a stop word).
 * A suppressed copy does not extend the window, so a storm of copies cannot keep a real repeat out.
 */

export const FINAL_DEDUPE_WINDOW_MS = 4000;
/** An id is remembered this long; the same id inside it is the same utterance, however late the copy came. */
export const FINAL_ID_MEMORY_MS = 30_000;
const MAX_ENTRIES = 24;
const MAX_KEY_CHARS = 400;
/** A line this short, while an approval is open, is an answer to it and always passes (once per id). */
export const APPROVAL_ANSWER_MAX_WORDS = 5;
/**
 * The same answer to the same open prompt, delivered again this soon after the first, is a copy (a retried call),
 * not a second answer: nobody says yes twice inside this time, and a new prompt takes longer than this to sound.
 */
export const APPROVAL_COPY_MS = 700;

/** Zero code points of the decimal digit blocks that matter here (Devanagari, Arabic-Indic, Bengali, Gurmukhi, Gujarati). */
const DIGIT_ZEROS = [0x0966, 0x0660, 0x06f0, 0x09e6, 0x0a66, 0x0ae6];

function foldDigit(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  for (const zero of DIGIT_ZEROS) {
    if (code >= zero && code <= zero + 9) return String(code - zero);
  }
  return ch;
}

/**
 * The comparison key of a transcript: NFKC and lower case, format and zero-width marks gone, the Devanagari
 * candrabindu read as the anusvara (the two spellings of one sound), digits of every script as ASCII digits,
 * and everything that is not a letter, a mark or a digit removed. Empty when nothing is left to say.
 */
export function finalTextKey(text: string): string {
  const folded = String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Cf}/gu, "")
    .replace(/ँ/g, "ं")
    .replace(/\p{Nd}/gu, foldDigit)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
  return folded.length > MAX_KEY_CHARS
    ? `${folded.slice(0, MAX_KEY_CHARS)}#${folded.length}`
    : folded;
}

export type FinalCandidate = {
  text: string;
  /** The engine's own id for this utterance (a Sarvam turn id, an IPC request id), when it has one. */
  utteranceId?: string;
  /** Which engine delivered it; ids are only compared inside one source. */
  source?: string;
  /** An approval prompt is open: a short line is an answer to it and is never held back. */
  approvalOpen?: boolean;
  /** When FRIDAY's latest reply began to sound (ms). A repeat after that is a deliberate one. */
  replyStartedAt?: number | null;
  /** A line that must never be held back as a copy (a stop word: the owner may need to say it again). */
  alwaysPass?: boolean;
};

export type FinalVerdict =
  | { pass: true; key: string; approval: boolean; exempt: boolean }
  | {
      pass: false;
      key: string;
      reason: "same-utterance-id" | "same-text-in-window";
      ageMs: number;
    };

type Entry = { key: string; at: number; source: string; id: string; approval: boolean };

export type FinalDeduper = {
  /** Decide and, when it passes, remember. A suppressed copy is not remembered. */
  check(candidate: FinalCandidate): FinalVerdict;
  reset(): void;
  size(): number;
};

export function createFinalDeduper(
  options: { windowMs?: number; idMemoryMs?: number; now?: () => number } = {},
): FinalDeduper {
  const windowMs = Math.max(0, options.windowMs ?? FINAL_DEDUPE_WINDOW_MS);
  const idMemoryMs = Math.max(windowMs, options.idMemoryMs ?? FINAL_ID_MEMORY_MS);
  const now = options.now ?? (() => Date.now());
  let entries: Entry[] = [];

  const prune = (at: number) => {
    entries = entries.filter((entry) => at - entry.at < idMemoryMs && at - entry.at >= -1000);
  };

  return {
    check(candidate) {
      const at = now();
      prune(at);
      const key = finalTextKey(candidate.text);
      const source = String(candidate.source ?? "");
      const id = String(candidate.utteranceId ?? "").trim();
      const words = String(candidate.text ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      const approval =
        candidate.approvalOpen === true && words > 0 && words <= APPROVAL_ANSWER_MAX_WORDS;

      const exempt = approval || candidate.alwaysPass === true;
      // Nothing sayable is not this rule's business: the gates after it already drop an empty line.
      if (!key) return { pass: true, key, approval, exempt };

      if (id) {
        const sameId = entries.find((entry) => entry.id === id && entry.source === source);
        if (sameId) {
          return { pass: false, key, reason: "same-utterance-id", ageMs: at - sameId.at };
        }
      }

      // An approval answer passes once: the same answer again within a blink, with no reply between, is a copy.
      if (approval && candidate.alwaysPass !== true) {
        const copy = [...entries].reverse().find((entry) => entry.key === key && entry.approval);
        const replyStartedAt = candidate.replyStartedAt ?? null;
        if (
          copy &&
          at - copy.at < APPROVAL_COPY_MS &&
          !(replyStartedAt !== null && replyStartedAt >= copy.at)
        ) {
          return { pass: false, key, reason: "same-text-in-window", ageMs: at - copy.at };
        }
      }

      if (!exempt) {
        const replyStartedAt = candidate.replyStartedAt ?? null;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          if (!entry || entry.key !== key) continue;
          const age = at - entry.at;
          if (age >= windowMs) break;
          // Two different ids from one source are two utterances that happen to share words.
          if (id && entry.id && entry.source === source && entry.id !== id) continue;
          // A reply began after the first copy: the owner said it again on purpose.
          if (replyStartedAt !== null && replyStartedAt >= entry.at) break;
          return { pass: false, key, reason: "same-text-in-window", ageMs: age };
        }
      }

      entries.push({ key, at, source, id, approval });
      if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
      return { pass: true, key, approval, exempt };
    },
    reset() {
      entries = [];
    },
    size: () => entries.length,
  };
}
