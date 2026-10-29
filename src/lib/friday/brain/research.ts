/**
 * FRIDAY · web research helpers
 *
 * Wraps the existing browser-engine search. Marks sources as unverified
 * until the owner or a second source backs them. Does not browse on its own.
 *
 * Adaptive retrieve follows Self-RAG (Asai et al., ICLR 2024): do not search
 * when stored knowledge is already known and fresh. CRAG (Yan et al., 2024)
 * grades retrieved web snippets before they become evidence.
 */

import type { SearchResult } from "../browser-engine";
import type { KnowledgeStatus } from "./knowledge-base";
import { claimLabel, externalTextIsData } from "../knowledge-claim";
import { expandQuery, gradeRetrieval, retrievalTerms, type RetrievalGrade } from "./retrieval";

export type RankedSource = {
  title: string;
  url: string;
  snippet: string;
  verified: false;
  score: number;
};

const TRUSTED = /\.(gov|edu)(\/|$)|wikipedia\.org|github\.com|learn\.microsoft\.com|arxiv\.org/i;

export function rankSources(results: SearchResult[]): RankedSource[] {
  return (results || []).map((result) => {
    const url = String(result.url || "");
    let score = 0.4;
    if (TRUSTED.test(url)) score += 0.35;
    if (url.startsWith("https://")) score += 0.1;
    if ((result.snippet || "").length > 80) score += 0.1;
    return {
      title: result.title,
      url,
      snippet: result.snippet,
      verified: false as const,
      score: Math.min(1, score),
    };
  });
}

export function researchNote(sources: RankedSource[]): string {
  if (!sources.length) return "No live sources — say that instead of guessing.";
  const freshness = claimLabel(null, 1);
  return [
    "Live web results. Treat them as unverified until cited. Prefer https sources. Do not present a single snippet as fact.",
    ...sources
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((s, i) => {
        const snippet = externalTextIsData(s.snippet).text;
        return `${i + 1}. ${s.title} — ${s.url} (score ${s.score.toFixed(2)}, ${freshness})\n   ${snippet}`;
      }),
  ].join("\n");
}

const LIVE_FACT =
  /\b(search|google|look ?up|latest|news|today'?s|current(?:ly)?|right now|price|weather|release[sd]?)\b/i;
const CREATIVE_ASK = /\b(haiku|poem|joke|hello|hi\b|thanks|write a)\b/i;
const KNOWLEDGE_ASK =
  /\b(who|what|when|where|which|how many|how much|capital of|meaning of|definition of)\b/i;

export function looksLikeLiveFact(text: string): boolean {
  return LIVE_FACT.test(String(text || ""));
}

/**
 * Self-RAG Retrieve=Yes analogue for factual grounding (Asai et al., ICLR 2024).
 * Creative asks stay Retrieve=No so a haiku does not become a web search.
 */
export function looksLikeKnowledgeAsk(text: string): boolean {
  const value = String(text || "");
  if (CREATIVE_ASK.test(value)) return false;
  return KNOWLEDGE_ASK.test(value);
}

/**
 * Self-RAG retrieve-or-not. Known+fresh knowledge is used. Live facts, stale
 * knowledge, and knowledge-asks whose store is unknown or CRAG-incorrect may
 * research. Never research just because a model is available.
 */
export function shouldResearch(input: {
  status?: KnowledgeStatus | string;
  liveFact?: boolean;
  retrievalGrade?: RetrievalGrade;
  knowledgeAsk?: boolean;
}): boolean {
  if (input.liveFact) return true;
  const status = String(input.status || "");
  if (status === "stale") return true;
  if (status === "contradicted" && input.retrievalGrade === "incorrect") return true;
  if (input.knowledgeAsk && (status === "unknown" || input.retrievalGrade === "incorrect")) {
    return true;
  }
  return false;
}

/** CRAG evaluator over ranked web sources. */
export function evaluateSources(
  sources: RankedSource[],
  query = "",
): {
  grade: RetrievalGrade;
  usable: RankedSource[];
  reason: string;
} {
  const ranked = triangulateSources([...sources].sort((a, b) => b.score - a.score));
  const judged = gradeRetrieval(ranked);
  if (judged.grade === "incorrect") {
    return { grade: "incorrect", usable: [], reason: judged.reason };
  }
  const usable =
    judged.grade === "correct"
      ? ranked.slice(0, 6)
      : ranked.filter((row) => row.score >= 0.5).slice(0, 4);
  return {
    grade: judged.grade,
    usable: usable.map((row) => ({
      ...row,
      snippet: knowledgeStrips(row.snippet, query || row.title),
    })),
    reason: judged.reason,
  };
}

/**
 * CRAG decompose-then-recompose (Yan et al. 2024): keep sentences that overlap
 * the ask. Filler is not evidence. Empty overlap keeps the first sentence.
 */
export function knowledgeStrips(snippet: string, query: string): string {
  const text = String(snippet || "").trim();
  if (!text) return "";
  const terms = new Set(retrievalTerms(query));
  const sentences = text.split(/(?<=[.!?])\s+/).filter((line) => line.trim().length > 0);
  if (!terms.size || sentences.length <= 1) return text.slice(0, 400);
  const kept = sentences.filter((line) => retrievalTerms(line).some((term) => terms.has(term)));
  return (kept.length ? kept : sentences.slice(0, 1)).join(" ").slice(0, 400);
}

/** Multi-query research (same idea as RAG query expansion). First item is the live search. */
export function formulateQueries(ask: string): string[] {
  const base = String(ask || "")
    .replace(/^\s*(search|google|look ?up)\s+/i, "")
    .trim()
    .slice(0, 200);
  if (!base) return [];
  return [...new Set([base, ...expandQuery(base)])].slice(0, 4);
}

/**
 * Independent-host triangulation: a term that appears in two+ hosts is stronger
 * than a single blog, still unverified.
 */
export function triangulateSources(sources: RankedSource[]): RankedSource[] {
  const hosts = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const byHost = new Map<string, RankedSource[]>();
  for (const row of sources) {
    const host = hosts(row.url);
    if (!host) continue;
    const list = byHost.get(host) ?? [];
    list.push(row);
    byHost.set(host, list);
  }
  if (byHost.size < 2) return sources;
  return sources.map((row) => {
    const terms = new Set(
      `${row.title} ${row.snippet}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 4),
    );
    let others = 0;
    const self = hosts(row.url);
    for (const [host, list] of byHost) {
      if (host === self) continue;
      if (
        list.some((peer) =>
          `${peer.title} ${peer.snippet}`
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .some((word) => terms.has(word)),
        )
      ) {
        others += 1;
      }
    }
    if (!others) return row;
    return { ...row, score: Math.min(1, row.score + 0.08 * others) };
  });
}
