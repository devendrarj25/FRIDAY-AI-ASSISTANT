/**
 * FRIDAY · a question about the past is answered from what was true then
 *
 * "What did I decide in June" or "pichhle mahine kya tay hua" names a period. Ordinary recall reads only
 * records that are current, so it would answer with today's version of a plan that changed. This reads the
 * records that were true during the named period, including ones since replaced, and says why a replaced one
 * stopped being current. It returns nothing for a question about now, so the normal path is untouched.
 */

import { asOfWindow, memory, type MemoryItem } from "../self/memory-engine";

export type PastEvidence = { label: string; lines: string[]; ids: string[] };

export function pastEvidence(
  prompt: string,
  now = Date.now(),
  k = 6,
  store: Pick<typeof memory, "retrieveAsOf"> = memory,
): PastEvidence | null {
  const window = asOfWindow(prompt, now);
  if (!window) return null;
  const hits = store.retrieveAsOf(prompt, window, k);
  if (!hits.length) return null;
  const line = (item: MemoryItem) => {
    const ended = item.invalidReason ? ` (no longer current: ${item.invalidReason})` : "";
    return `[as of ${window.label}] ${item.title}: ${item.text.slice(0, 280)}${ended}`;
  };
  return {
    label: window.label,
    lines: hits.map((hit) => line(hit.item)),
    ids: hits.map((hit) => hit.item.id),
  };
}
