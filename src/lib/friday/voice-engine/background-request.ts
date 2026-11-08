/**
 * FRIDAY · "do this in the background" in the owner's own words.
 *
 * Recognises a spoken request that asks for work to continue while the conversation goes on, and returns the
 * request without that wording so the Brain gets the work itself. It is deliberately narrow: a sentence that
 * merely contains the word "background" (a wallpaper, a background colour) is not a background task.
 * Hindi, English and Hinglish forms are covered.
 */

export type BackgroundRequest = { label: string; request: string };

const PATTERNS: RegExp[] = [
  /\b(?:in the background|in background)\b/i,
  /\bbackground\s+(?:mein|me|main)\s+(?:kaam|task|chalao|chala do|karo|kar do|kar dena|analy[sz]e|run)\b/i,
  /\b(?:background|peeche se|piche se)\s+(?:task|kaam)\b/i,
  /\bjab\s+tak\s+(?:tum|aap)\s+(?:kaam\s+)?kar\s+(?:rahi|rahe|raha)\s+ho(?:\s+tab\s+tak)?\b/i,
  /\bmain\s+(?:tumse|aapse)\s+(?:doosre|dusre)\s+(?:questions?|sawaal)\b/i,
  /\bwhile\s+you(?:'re|\s+are)?\s+(?:working|at it)\b/i,
];

const FILLER = /^[\s,.;:!?-]+|[\s,.;:!?-]+$/g;

export function parseBackgroundRequest(heard: string): BackgroundRequest | null {
  const text = heard.trim();
  if (text.split(/\s+/).length < 3) return null;
  if (!PATTERNS.some((pattern) => pattern.test(text))) return null;
  let request = text;
  for (const pattern of PATTERNS) request = request.replace(pattern, " ");
  request = request
    .replace(/\b(?:aur|and|but|lekin|ki)\b\s*(?=[,.;]|$)/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(FILLER, "");
  if (request.split(/\s+/).filter((w) => w.length > 1).length < 2) return null;
  return { label: request.slice(0, 80), request };
}

/** The first sentence of an answer, short enough to say as a completion line. */
export function completionLine(answer: string, max = 200): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const first = flat.split(/(?<=[.!?।])\s/)[0] ?? flat;
  return first.length <= max ? first : `${first.slice(0, max - 1).trim()}…`;
}
