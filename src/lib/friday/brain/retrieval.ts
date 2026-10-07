/**
 * FRIDAY · retrieval ranking
 *
 * Shared scoring for Memory (`memory.retrieve`) and Knowledge
 * (`brainKnowledge.recall`). Not a second store or a second retriever —
 * those methods still own read/write. Ranking is the piece that actually
 * differs from storage, so it lives here once.
 *
 * Pipeline: query understanding → candidate generation → ranking →
 * filtering → context assembly. Signals: keyword overlap, term Jaccard
 * (paraphrase-ish), entity tokens, recency, importance/confidence, source
 * reliability, task/conversation hint, verification. Low-value hits are
 * dropped so context is not flooded. Not a second store.
 */

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "your",
  "you",
  "are",
  "was",
  "its",
  "into",
  "what",
  "when",
  "how",
  "can",
  "please",
  "friday",
]);

const FOLD: Record<string, string> = {
  owns: "owned",
  owner: "owned",
  owned: "owned",
};

export function retrievalTerms(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((word) => word.length > 2 && !STOP.has(word))
    .map((word) => FOLD[word] ?? word);
}

/** Proper-noun / identifier tokens for entity retrieval. */
export function retrievalEntities(text: string): string[] {
  const named = String(text || "").match(/\b[A-Z][a-zA-Z0-9+.#_-]{2,}\b/g) ?? [];
  const extra = retrievalTerms(text).filter((word) => word.length > 4);
  return [...new Set([...named.map((word) => word.toLowerCase()), ...extra])];
}

export function termJaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let inter = 0;
  for (const word of left) if (right.has(word)) inter += 1;
  return inter / new Set([...left, ...right]).size;
}

/** Query understanding: terms + entities (not a second parser). */
export function understandQuery(query: string): { terms: string[]; entities: string[] } {
  return { terms: retrievalTerms(query), entities: retrievalEntities(query) };
}

/**
 * HyDE-lite / multi-query without an LLM (Gao et al. 2022 idea, lexical only):
 * rewrite the ask into phrases that look like stored beliefs, then retrieve those.
 */
export function expandQuery(query: string): string[] {
  const text = String(query || "").trim();
  if (!text) return [];
  const variants = new Set<string>([text]);
  const whoOwns = text.match(/\bwho owns\s+(.+?)(?:[?.!]|$)/i);
  if (whoOwns?.[1]) {
    const target = whoOwns[1].trim();
    variants.add(`${target} owned-by`);
    variants.add(`${target} owner`);
  }
  const whatIs = text.match(/\bwhat(?: is|'s)\s+(.+?)(?:[?.!]|$)/i);
  if (whatIs?.[1]) {
    const target = whatIs[1].trim();
    variants.add(`${target} is-a`);
    variants.add(`${target} definition`);
  }
  const latest = text.match(/\b(?:latest|current)\s+(.+?)(?:[?.!]|$)/i);
  if (latest?.[1]) variants.add(`${latest[1].trim()} release`);
  const why = text.match(/\bwhy (?:did|does|is)\s+(.+?)(?:[?.!]|$)/i);
  if (why?.[1]) {
    const target = why[1].trim();
    variants.add(`${target} failed`);
    variants.add(`${target} cause`);
  }
  const whoIs = text.match(/\bwho is\s+(.+?)(?:[?.!]|$)/i);
  if (whoIs?.[1]) variants.add(`${whoIs[1].trim()} identity`);
  const whereIs = text.match(/\bwhere (?:is|are)\s+(.+?)(?:[?.!]|$)/i);
  if (whereIs?.[1]) variants.add(`${whereIs[1].trim()} located-in`);
  const howTo = text.match(/\bhow (?:do I|to|can I)\s+(.+?)(?:[?.!]|$)/i);
  if (howTo?.[1]) {
    const target = howTo[1].trim();
    variants.add(`${target} steps`);
    variants.add(`${target} method`);
  }
  const related = text.match(/\bhow is\s+(.+?)\s+related to\s+(.+?)(?:[?.!]|$)/i);
  if (related?.[1] && related[2]) {
    variants.add(`${related[1].trim()} ${related[2].trim()}`);
    variants.add(`${related[1].trim()} owned-by`);
  }
  return [...variants].slice(0, 8);
}

/**
 * ColBERT-style late interaction without embeddings (Khattab & Zaharia 2020
 * idea): each query term scores its best exact/prefix match in the document.
 */
export function lateInteraction(queryTerms: string[], docTerms: string[]): number {
  if (!queryTerms.length || !docTerms.length) return 0;
  let sum = 0;
  for (const query of queryTerms) {
    let best = 0;
    for (const doc of docTerms) {
      if (doc === query) {
        best = 1;
        break;
      }
      if (doc.startsWith(query) || query.startsWith(doc)) best = Math.max(best, 0.6);
    }
    sum += best;
  }
  return sum / queryTerms.length;
}

/**
 * Maximal Marginal Relevance (Carbonell & Goldstein 1998). λ near 1 keeps
 * relevance; lower λ spreads hits so identity rows do not flood the window.
 */
export function mmrRerank<T>(
  hits: RankedHit<T>[],
  textOf: (hit: RankedHit<T>) => string,
  k: number,
  lambda = 0.72,
): RankedHit<T>[] {
  if (hits.length <= 1) return hits.slice(0, k);
  const picked: RankedHit<T>[] = [];
  const rest = [...hits];
  while (picked.length < k && rest.length) {
    let bestIdx = 0;
    let best = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < rest.length; i += 1) {
      const cand = rest[i]!;
      const candTerms = retrievalTerms(textOf(cand));
      let maxSim = 0;
      for (const have of picked) {
        maxSim = Math.max(maxSim, termJaccard(candTerms, retrievalTerms(textOf(have))));
      }
      const mmr = lambda * cand.score - (1 - lambda) * maxSim;
      if (mmr > best) {
        best = mmr;
        bestIdx = i;
      }
    }
    picked.push(rest.splice(bestIdx, 1)[0]!);
  }
  return picked;
}

export type EvidenceRef = {
  source: string;
  provenance?: string;
  confidence: number;
  freshnessAt?: number;
  updatedAt: number;
  verified?: boolean;
};

export type BeliefJudgment = {
  winner: "existing" | "incoming" | "ambiguous";
  sufficient: boolean;
  reason: string;
};

/** How much to trust a source. Owner/user outranks unverified chat. */
export function sourceReliability(source: string, provenance?: string): number {
  const origin = String(provenance || "").toLowerCase();
  if (origin === "user") return 1;
  if (origin === "verified") return 0.85;
  const from = String(source || "").toLowerCase();
  if (from.startsWith("library:")) return 0.9;
  if (/\b(identity|first-run|owner)\b/.test(from) || from === "user") return 0.95;
  if (/\b(governance|verified)\b/.test(from)) return 0.8;
  if (/^memory\//.test(from)) return 0.7;
  if (/\b(unverified|guess|chat)\b/.test(from)) return 0.35;
  if (origin === "observed") return 0.5;
  return 0.55;
}

/**
 * Decide whether new evidence is enough to treat as the current belief.
 * Never invents a resolution: ambiguous pairs stay both-preserved.
 */
export function compareBeliefs(existing: EvidenceRef, incoming: EvidenceRef): BeliefJudgment {
  const existingQ = sourceReliability(existing.source, existing.provenance);
  const incomingQ = sourceReliability(incoming.source, incoming.provenance);
  if (incomingQ >= 0.9 && existingQ < 0.8) {
    return {
      winner: "incoming",
      sufficient: true,
      reason: "owner/user source outranks weaker stored evidence",
    };
  }
  if (existingQ >= 0.9 && incomingQ < 0.8) {
    return {
      winner: "existing",
      sufficient: true,
      reason: "stored owner/user belief outranks weaker new evidence",
    };
  }
  const existingAt = existing.freshnessAt ?? existing.updatedAt;
  const incomingAt = incoming.freshnessAt ?? incoming.updatedAt;
  const newer = incomingAt - existingAt > 60_000;
  const gap = incoming.confidence - existing.confidence;
  if (incoming.verified && newer && gap >= 0.25 && incomingQ >= existingQ) {
    return {
      winner: "incoming",
      sufficient: true,
      reason: "newer verified evidence with a clear confidence gap",
    };
  }
  if (existing.verified && incoming.verified !== true && existingQ >= incomingQ) {
    return {
      winner: "existing",
      sufficient: true,
      reason: "stored verified belief; incoming is unverified",
    };
  }
  return {
    winner: "ambiguous",
    sufficient: false,
    reason: "both sides stay with provenance; FRIDAY will not invent a resolution",
  };
}

export type RankSignals = EvidenceRef & {
  /** Stable id for hybrid fusion (memory/knowledge row id). */
  id?: string;
  title: string;
  text: string;
  tags?: string[];
  pinned?: boolean;
  permanent?: boolean;
  contradiction?: boolean;
  uses?: number;
  hits?: number;
  tierWeight?: number;
  /** True when this record is the current belief among a resolved pair. */
  preferred?: boolean;
  scope?: string;
  /** Optional graph-neighborhood boost (0–1) from the knowledge store. */
  relatedBoost?: number;
  /** Conversation / temporal hint already tokenized into `text` by the caller. */
  importance?: number;
};

/** Optional kernel/vector snippet to fuse with lexical ranking (Cormack RRF). */
export type VectorSnippet = {
  title: string;
  snippet: string;
  score: number;
  /** Canonical memory/knowledge row id when the kernel echoed it. */
  id?: string;
};

export type RankedHit<T> = { item: T; score: number };

export function recencyScore(at: number, now = Date.now()): number {
  const ageDays = Math.max(0, (now - at) / 86_400_000);
  return 1 / (1 + ageDays / 14);
}

export function retrievalScore(
  item: RankSignals,
  query: string,
  taskHint = "",
  now = Date.now(),
): number {
  const understood = understandQuery(query);
  const words = understood.terms;
  const taskWords = retrievalTerms(taskHint);
  const hay = `${item.title} ${item.text} ${(item.tags ?? []).join(" ")}`.toLowerCase();
  const hayTerms = retrievalTerms(hay);
  const overlap = words.filter((word) => hay.includes(word)).length;
  const jaccard = termJaccard(words, hayTerms);
  const late = lateInteraction(words, hayTerms);
  const semantic = words.length ? 0.55 * (overlap / words.length) + 0.25 * jaccard + 0.2 * late : 0;
  const entities = understood.entities.filter((token) => hay.includes(token));
  const entity = understood.entities.length ? entities.length / understood.entities.length : 0;
  const taskOverlap = taskWords.filter((word) => hay.includes(word)).length;
  const task = taskWords.length ? taskOverlap / taskWords.length : 0;
  if (!overlap && !item.pinned && !item.permanent) return 0;
  if (!overlap) {
    // Pinned/permanent identity is a prior, not a retrieval hit — keep it
    // below the default minScore so it does not flood unrelated turns.
    return 0.12;
  }

  const freshAt = item.freshnessAt ?? item.updatedAt;
  const recency = recencyScore(freshAt, now);
  const quality = sourceReliability(item.source, item.provenance);
  const scope =
    item.scope === "owner"
      ? 1
      : item.scope === "project"
        ? 0.7
        : item.scope === "session"
          ? 0.4
          : 0.65;
  const verified =
    item.verified || item.provenance === "verified" || item.provenance === "user" || item.permanent
      ? 1
      : 0.45;
  const usage = Math.min(0.18, ((item.uses ?? 0) + (item.hits ?? 0)) * 0.02);
  const pin = item.pinned || item.permanent ? (semantic >= 0.35 ? 0.1 : 0.02) : 0;
  const preferred = item.preferred ? 0.12 : 0;
  const related = Math.min(0.12, item.relatedBoost ?? 0);
  const importance = Math.min(0.08, item.importance ?? 0);
  const contradictionPenalty = item.contradiction && !item.preferred ? 0.08 : 0;
  const weight = item.tierWeight ?? 1;
  const mixed =
    semantic * 0.32 +
    entity * 0.08 +
    task * 0.12 +
    recency * 0.12 +
    item.confidence * 0.1 +
    quality * 0.1 +
    scope * 0.04 +
    verified * 0.08 +
    usage +
    pin +
    preferred +
    related +
    importance;
  return Math.max(0, Math.min(1, mixed * weight - contradictionPenalty));
}

export function rankByRetrieval<T>(
  items: T[],
  query: string,
  map: (item: T) => RankSignals,
  options: {
    k?: number;
    minScore?: number;
    taskHint?: string;
    now?: number;
    vectorHits?: VectorSnippet[];
  } = {},
): RankedHit<T>[] {
  const k = options.k ?? 6;
  const minScore = options.minScore ?? 0.22;
  const taskHint = options.taskHint ?? "";
  const now = options.now ?? Date.now();
  const variants = expandQuery(query);
  const used = variants.length ? variants : [query];
  const queryTerms = [...new Set(used.flatMap((variant) => retrievalTerms(variant)))];
  const rows = items.map((item, index) => {
    const signals = map(item);
    const score = Math.max(
      ...used.map((variant) => retrievalScore(signals, variant, taskHint, now)),
    );
    return {
      item,
      signals,
      id: signals.id || `${index}:${signals.title}`,
      score,
      bm25: bm25Lite(queryTerms, retrievalTerms(`${signals.title} ${signals.text}`)),
    };
  });

  const lexical = rows.filter((row) => row.score >= minScore).sort((a, b) => b.score - a.score);

  const vectorIds = new Set<string>();
  if (options.vectorHits?.length) {
    for (const hit of options.vectorHits) {
      if (hit.id) {
        for (const row of rows) {
          if (row.id === hit.id) vectorIds.add(row.id);
        }
      }
      const hay = `${hit.title} ${hit.snippet}`.toLowerCase();
      for (const row of rows) {
        const needle = row.signals.title.toLowerCase();
        if (needle && hay.includes(needle.slice(0, Math.min(24, needle.length)))) {
          vectorIds.add(row.id);
        } else if (termJaccard(queryTerms, retrievalTerms(hay)) >= 0.2 && row.score > 0.08) {
          vectorIds.add(row.id);
        }
      }
    }
  }

  const pool = rows.filter((row) => row.score >= minScore || vectorIds.has(row.id));
  if (!pool.length) return lexical.slice(0, k).map((row) => ({ item: row.item, score: row.score }));

  const bm25List = [...pool].sort((a, b) => b.bm25 - a.bm25);
  const lists: { id: string }[][] = [
    lexical.map((row) => ({ id: row.id })),
    bm25List.map((row) => ({ id: row.id })),
  ];
  if (vectorIds.size) {
    lists.push(pool.filter((row) => vectorIds.has(row.id)).map((row) => ({ id: row.id })));
  }
  const fused = reciprocalRankFusion(lists);
  const byId = new Map(pool.map((row) => [row.id, row]));
  const fusedHits = fused
    .map((row) => {
      const hit = byId.get(row.id);
      if (!hit) return null;
      const vectorBoost = vectorIds.has(row.id) ? 0.06 : 0;
      return { item: hit.item, score: Math.min(1, hit.score + vectorBoost), id: hit.id };
    })
    .filter((row): row is RankedHit<T> & { id: string } => Boolean(row));
  const textOf = (hit: RankedHit<T> & { id?: string }) => {
    const row = typeof hit.id === "string" ? byId.get(hit.id) : undefined;
    return row ? `${row.signals.title} ${row.signals.text}` : "";
  };
  return mmrRerank(fusedHits, textOf, k).map((hit) => ({ item: hit.item, score: hit.score }));
}

/** Cap assembled context so a turn is not flooded with near-misses. */
export function assembleRetrievalContext<T>(
  hits: RankedHit<T>[],
  line: (hit: RankedHit<T>) => string,
  maxChars = 1800,
): { lines: string[]; dropped: number } {
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const hit of hits) {
    const text = line(hit);
    if (used + text.length > maxChars && lines.length) {
      dropped += 1;
      continue;
    }
    lines.push(text);
    used += text.length;
  }
  return { lines, dropped };
}

export type EvidenceCard = {
  source: string;
  when: number;
  reliability: number;
  verified: boolean;
  contradiction: boolean;
  newerEvidence: boolean;
  /** true = current belief, false = not current, null = no rival to compare */
  current: boolean | null;
};

/** Where it came from, when, how reliable, and whether newer evidence exists. */
export function describeEvidence(item: RankSignals, peers: RankSignals[] = []): EvidenceCard {
  const when = item.freshnessAt ?? item.updatedAt;
  const reliability = sourceReliability(item.source, item.provenance);
  const verified = Boolean(
    item.verified || item.provenance === "verified" || item.provenance === "user",
  );
  const newerEvidence = peers.some((peer) => {
    if (peer === item) return false;
    const peerWhen = peer.freshnessAt ?? peer.updatedAt;
    return peerWhen > when;
  });
  const rivals = peers.filter((peer) => peer !== item);
  let current: boolean | null = null;
  if (rivals.length) {
    const judgment = compareBeliefs(item, rivals[0]!);
    if (!judgment.sufficient) current = null;
    else current = judgment.winner === "existing";
  }
  return {
    source: item.source,
    when,
    reliability,
    verified,
    contradiction: Boolean(item.contradiction),
    newerEvidence,
    current: rivals.length ? current : null,
  };
}

export function formatEvidenceLine(card: EvidenceCard): string {
  const when = new Date(card.when).toISOString();
  const bits = [
    `source: ${card.source}`,
    `at: ${when}`,
    `reliability: ${card.reliability.toFixed(2)}`,
    `confidence-class: ${card.verified ? "verified" : "observed"}`,
  ];
  if (card.newerEvidence) bits.push("newer evidence exists");
  if (card.contradiction) {
    bits.push(
      card.current === true
        ? "current belief (rival preserved)"
        : card.current === false
          ? "not current (preserved)"
          : "unresolved contradiction",
    );
  }
  return bits.join(", ");
}

/**
 * Robertson/Sparck Jones BM25 (k1=1.2, b=0.75) with a collection-free IDF
 * prior. Used as a second ranker so hybrid fusion is not Jaccard-only.
 */
export function bm25Lite(queryTerms: string[], docTerms: string[], avgDl = 40): number {
  if (!queryTerms.length || !docTerms.length) return 0;
  const tf = new Map<string, number>();
  for (const term of docTerms) tf.set(term, (tf.get(term) ?? 0) + 1);
  const dl = docTerms.length;
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of new Set(queryTerms)) {
    const freq = tf.get(term) ?? 0;
    if (!freq) continue;
    const idf = Math.log(1 + 1.5);
    score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (dl / Math.max(1, avgDl)))));
  }
  return score;
}

/**
 * Reciprocal Rank Fusion (Cormack, Clarke, Buettcher, SIGIR 2009).
 * Combines rank lists without mixing incompatible raw scores. k=60 is the
 * published default later used by Elasticsearch hybrid search.
 */
export function reciprocalRankFusion(
  lists: { id: string }[][],
  k = 60,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((row, index) => {
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/** CRAG-style retrieval evaluator (Yan et al. 2024) — grades hits, not the model. */
export type RetrievalGrade = "correct" | "ambiguous" | "incorrect";

export function gradeRetrieval(hits: { score: number }[]): {
  grade: RetrievalGrade;
  reason: string;
} {
  if (!hits.length) {
    return { grade: "incorrect", reason: "no retrieval hits" };
  }
  const top = hits[0]?.score ?? 0;
  if (top >= 0.45) return { grade: "correct", reason: "top hit is strong enough to use" };
  if (top >= 0.22) return { grade: "ambiguous", reason: "hits exist but are weak" };
  return { grade: "incorrect", reason: "hits below usefulness" };
}
