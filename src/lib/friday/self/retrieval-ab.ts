/**
 * FRIDAY · which way of finding a memory is actually better, on the owner's own memories
 *
 * Leave-one-out: for each of his memories a query is made from its body with the title's words taken out, so
 * the title cannot simply be matched, and the answer is that memory's id. Every retrieval way is asked the same
 * queries: the word index (what FRIDAY has always used), the kernel's hashed vectors alone, the hashed vectors
 * re-ordered by the local embedding model, and re-ordered by the local rerank judge. A way whose model is not
 * running is listed as unavailable instead of being scored as a failure. This is a proxy built from his own
 * notes, not a human-labelled set; a few real "question and the note that answers it" pairs from him are
 * better and can be added as cases of the same shape.
 */

import { comparePaired, wilson } from "./eval-stats";

export type RetrievalCase = { query: string; expectId: string };

export type RetrievalWay = {
  id: string;
  label: string;
  /** Ids in ranked order, or null when this way cannot run now (its model is not up). */
  rank: (query: string) => Promise<string[] | null>;
};

export type WayResult = {
  id: string;
  label: string;
  available: boolean;
  cases: number;
  hit1: number;
  hit3: number;
  mrr: number;
  interval: { low: number; high: number };
  outcomes: boolean[];
};

const STOP = new Set(
  "the a an and or of to in on for with is are was were be this that it as at by from have has had not but".split(
    " ",
  ),
);

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word.length > 2 && !STOP.has(word));

/** A query from the body of a memory that does not reuse its title's words. Null when too little is left. */
export function queryFor(title: string, text: string): string | null {
  const taken = new Set(words(title));
  const left = [...new Set(words(text))].filter((word) => !taken.has(word));
  if (left.length < 4) return null;
  return left
    .sort((a, b) => b.length - a.length)
    .slice(0, 6)
    .join(" ");
}

export function casesFrom(
  items: readonly { id: string; title: string; text: string }[],
  limit = 40,
): RetrievalCase[] {
  const out: RetrievalCase[] = [];
  for (const item of items) {
    const query = queryFor(item.title, item.text);
    if (query) out.push({ query, expectId: item.id });
    if (out.length >= limit) break;
  }
  return out;
}

export async function evaluateWays(
  cases: readonly RetrievalCase[],
  ways: readonly RetrievalWay[],
): Promise<WayResult[]> {
  const out: WayResult[] = [];
  for (const way of ways) {
    const outcomes: boolean[] = [];
    let hit3 = 0;
    let rr = 0;
    let available = true;
    for (const item of cases) {
      let ranked: string[] | null = null;
      try {
        ranked = await way.rank(item.query);
      } catch {
        ranked = null;
      }
      if (ranked === null) {
        available = false;
        break;
      }
      const at = ranked.indexOf(item.expectId);
      outcomes.push(at === 0);
      if (at >= 0 && at < 3) hit3 += 1;
      if (at >= 0) rr += 1 / (at + 1);
    }
    const n = outcomes.length;
    const hit1 = outcomes.filter(Boolean).length;
    out.push({
      id: way.id,
      label: way.label,
      available: available && n > 0,
      cases: n,
      hit1,
      hit3,
      mrr: n ? rr / n : 0,
      interval: wilson(hit1, n),
      outcomes,
    });
  }
  return out;
}

export function describeWays(results: readonly WayResult[]): string {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const live = results.filter((row) => row.available);
  const lines = results.map((row) =>
    row.available
      ? `${row.label}: first place ${row.hit1}/${row.cases} [${pct(row.interval.low)}–${pct(row.interval.high)}], top three ${row.hit3}/${row.cases}, mean reciprocal rank ${row.mrr.toFixed(2)}`
      : `${row.label}: not run (its model is not running or nothing to ask)`,
  );
  const base = live[0];
  const notes: string[] = [];
  if (base) {
    for (const other of live.slice(1)) {
      const diff = comparePaired(base.outcomes, other.outcomes);
      const verdict =
        diff.p < 0.05 ? (diff.delta > 0 ? "better" : "worse") : "no measurable difference";
      notes.push(
        `${other.label} against ${base.label}: ${verdict} (p=${diff.p.toFixed(2)}, ${diff.onlyB} won, ${diff.onlyA} lost)`,
      );
    }
  }
  return [...lines, ...notes].join("\n");
}
