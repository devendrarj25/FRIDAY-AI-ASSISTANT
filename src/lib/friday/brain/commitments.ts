/**
 * FRIDAY · promises she made in an answer
 *
 * "I'll remind you tomorrow", "main kal bata dungi". When an accepted answer promises something later, the
 * promise is kept in the conversation's commitments so the next turn, the digest and the open-loop list can see
 * it, and she does not forget what she said she would do. Only the first-person future in the answer counts; a
 * quoted line or a question does not.
 */

const PROMISE =
  /\b(?:i(?:'ll| will| am going to)|let me)\b[^.?!\n]{3,120}|\bmain\b[^.?!\n]{0,60}\b(?:dunga|dungi|karunga|karungi|bataunga|batati|bhejunga|bhejungi|yaad dilaunga|yaad dilaungi)\b[^.?!\n]{0,40}/gi;

/** Up to two promises, trimmed, from an accepted answer. */
export function promisesIn(answer: string): string[] {
  const text = String(answer || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^>.*$/gm, " ");
  const found: string[] = [];
  for (const match of text.matchAll(PROMISE)) {
    const line = match[0].replace(/\s+/g, " ").trim();
    if (line.length >= 12 && !found.includes(line)) found.push(line.slice(0, 160));
    if (found.length === 2) break;
  }
  return found;
}
