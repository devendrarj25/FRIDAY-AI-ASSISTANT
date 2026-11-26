/**
 * FRIDAY · the words the streaming ear is biased toward.
 *
 * The ear's hotword boost helps names it would otherwise spell as everyday words: her name and wake word, the
 * owner's contacts, the apps on this PC and the owner's own dictionary. This list is built here from what the
 * renderer already holds and nothing else; with no source it is empty and the ear runs unbiased. Each entry is
 * trimmed, control characters removed, at most 40 characters (longer ones are dropped, never cut mid-word),
 * deduplicated without regard to case, and the list stops at 64, in the order the sources are given (names first).
 * Hotwords are data: they only bias recognition and never become a command.
 */

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
