/**
 * FRIDAY · "Correct what I heard": the owner's fix of one heard line becomes a corrected owner row for the
 * glossary (`kernelApi.glossary.learn`), and the Learn panel list refreshes from one event.
 *
 * Only a finished line the owner spoke to her can be corrected: her own lines, room talk and a line still being
 * recognised are refused here, and the kernel gates the rest (setting, privacy class, word filters). Rows are built
 * from the caption and the owner's typed text only, never from anything else on the screen.
 */
import type { Caption } from "./assistant-mode";
import { kernelApi } from "./kernel-api";

type HeardLine = Pick<Caption, "who" | "text" | "partial" | "tag" | "tidy">;

export type CorrectionRow = { source: "owner"; corrected: true; heard: string; text: string };

export type CorrectionResult =
  { ok: true; terms: string[]; learning: boolean } | { ok: false; error: string };

/** True for a finished line the owner said to her (addressed or untagged), with some text. */
export function canCorrect(line: HeardLine): boolean {
  if (line.who !== "user" || line.partial) return false;
  if (line.tag === "ambient" || line.tag === "self") return false;
  return line.text.trim().length > 0;
}

/** What the ear heard: the raw words when Tidy edited the shown line, otherwise the line itself. */
export function heardOf(line: HeardLine): string {
  return (line.tidy?.raw ?? line.text).trim();
}

/** The row for the kernel, or null for a line that cannot be corrected, an empty fix, or no change. */
export function correctionRow(line: HeardLine, corrected: string): CorrectionRow | null {
  if (!canCorrect(line)) return null;
  const text = corrected.trim();
  const heard = heardOf(line);
  if (!text || text === heard) return null;
  return { source: "owner", corrected: true, heard, text };
}

const listeners = new Set<() => void>();

/** Called after a correction was stored; the Learn panel re-reads its list from it. Returns the unsubscribe. */
export function onGlossaryLearned(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Send the correction. `glossaryOn` is the owner's stored setting: the kernel learns nothing while it is off, and the
 * result says so. An offline or failing kernel is an error, never a silent success.
 */
export async function saveCorrection(
  line: HeardLine,
  corrected: string,
  glossaryOn: boolean,
): Promise<CorrectionResult> {
  const row = correctionRow(line, corrected);
  if (!row) return { ok: false, error: "There is nothing to save: change at least one word." };
  try {
    const out = await kernelApi.glossary.learn([row], glossaryOn);
    if (!out) return { ok: false, error: "The kernel is offline. Try again when it is back." };
    for (const listener of [...listeners]) listener();
    return { ok: true, terms: out.terms, learning: glossaryOn };
  } catch (failure) {
    return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
  }
}
