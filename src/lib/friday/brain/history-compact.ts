/**
 * FRIDAY · what the model is shown of an old conversation
 *
 * The whole transcript stays on this PC. The model is sent the recent turns in full and, for older long
 * answers, their opening and a note of how much was left out. Old, bulky turns (tool listings, long
 * outputs) are what fill the context without helping the next answer; a later turn can still ask for them.
 * Nothing is rewritten in the stored thread.
 */

export type HistoryLine = { role: "user" | "friday"; text: string; sensitive?: boolean };

export function compactHistory(
  lines: readonly HistoryLine[],
  options: { keepRecent?: number; maxOld?: number } = {},
): HistoryLine[] {
  const keepRecent = Math.max(2, options.keepRecent ?? 8);
  const maxOld = Math.max(80, options.maxOld ?? 400);
  const cut = Math.max(0, lines.length - keepRecent);
  return lines.map((line, index) => {
    if (index >= cut || line.role !== "friday" || line.text.length <= maxOld * 2) return line;
    const left = line.text.length - maxOld;
    return {
      ...line,
      text: `${line.text.slice(0, maxOld).trimEnd()}… (${left} more characters of this earlier answer are kept on this PC)`,
    };
  });
}
