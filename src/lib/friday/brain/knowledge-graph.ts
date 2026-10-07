/**
 * FRIDAY · knowledge graph queries
 *
 * Query helpers over the existing Brain knowledge store. Not a second graph
 * database — every edge is a subject/predicate/object belief already stored
 * by `brainKnowledge.assertBelief`.
 */

import { brainKnowledge, type BrainEntry } from "./knowledge-base";
import { retrievalEntities, retrievalTerms, termJaccard } from "./retrieval";

/** Canonical ops-graph predicates (hyphen form; underscores match too). */
export const GRAPH_CHAIN = [
  "owned-by",
  "works-on",
  "contains",
  "depends-on",
  "changed-by",
] as const;

export type GraphHop = {
  predicate: string;
  from: string;
  to: string;
  confidence: number;
  freshnessAt?: number;
  contradiction: boolean;
  source: string;
};

function toHop(entry: BrainEntry): GraphHop {
  return {
    predicate: String(entry.predicate ?? ""),
    from: String(entry.subject ?? ""),
    to: String(entry.object ?? ""),
    confidence: entry.confidence,
    contradiction: Boolean(entry.contradiction),
    source: entry.source,
    ...(entry.freshnessAt !== undefined ? { freshnessAt: entry.freshnessAt } : {}),
  };
}

export function relatedEntities(entity: string, predicate?: string): GraphHop[] {
  return brainKnowledge.related(entity, predicate).map(toHop);
}

export function incomingEntities(entity: string, predicate?: string): GraphHop[] {
  return brainKnowledge.pointedAt(entity, predicate).map(toHop);
}

export function walkGraph(start: string, predicates: readonly string[]): GraphHop[] {
  return brainKnowledge.walk(start, [...predicates]).map(toHop);
}

export function dependentsOf(entity: string): GraphHop[] {
  return brainKnowledge.dependents(entity).map(toHop);
}

/**
 * FRIDAY → owned-by → Owner → works-on → Project → contains → Component
 * → depends-on → Dependency → changed-by → Commit
 */
export function walkOpsChain(start = "FRIDAY"): GraphHop[] {
  return walkGraph(start, GRAPH_CHAIN);
}

/**
 * GraphRAG-style *local* search (Edge et al. 2024): fan out from entities
 * named in the query over the existing Brain store. Not a second graph
 * database and not community-summary global search (that needs a corpus LLM).
 */
export function localNeighborhood(query: string, limit = 12): GraphHop[] {
  const seeds = [
    ...retrievalEntities(query),
    ...retrievalTerms(query).filter((word) => word.length > 3),
  ].slice(0, 8);
  const hops: GraphHop[] = [];
  const seen = new Set<string>();
  const pushHop = (hop: GraphHop): boolean => {
    const key = `${hop.from}|${hop.predicate}|${hop.to}`;
    if (seen.has(key)) return hops.length >= limit;
    seen.add(key);
    hops.push(hop);
    return hops.length >= limit;
  };
  for (const seed of seeds) {
    for (const hop of [...relatedEntities(seed), ...incomingEntities(seed)]) {
      if (pushHop(hop)) break;
    }
    if (hops.length >= limit) break;
  }
  // Optional 2-hop fan-out (GraphRAG local search). Community summaries are
  // not built — that needs a corpus LLM and a second graph store.
  for (const hop of hops.slice(0, 6)) {
    if (hops.length >= limit * 2) break;
    for (const next of [...relatedEntities(hop.to), ...incomingEntities(hop.to)]) {
      if (pushHop(next)) break;
    }
  }
  const mass = personalizedRank(query, hops);
  return hops
    .map((hop) => {
      const fromMass = mass.get(hop.from.toLowerCase()) ?? 0;
      const toMass = mass.get(hop.to.toLowerCase()) ?? 0;
      return { hop, rank: fromMass + toMass + hop.confidence };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map((row) => row.hop);
}

/**
 * HippoRAG 2-style synonym seeding (Gutiérrez et al. 2025, lexical only):
 * entities whose terms overlap the query join the PPR seed set.
 */
export function synonymSeeds(query: string, hops: GraphHop[]): string[] {
  const seeds = [
    ...retrievalEntities(query),
    ...retrievalTerms(query).filter((word) => word.length > 3),
  ];
  const extra: string[] = [];
  for (const hop of hops) {
    for (const node of [hop.from, hop.to]) {
      const terms = retrievalTerms(node);
      if (!terms.length) continue;
      const hit = seeds.some((seed) => {
        const seedTerms = retrievalTerms(seed);
        return (
          termJaccard(seedTerms, terms) >= 0.5 || terms.some((term) => seedTerms.includes(term))
        );
      });
      if (hit) extra.push(node);
    }
  }
  return [...new Set([...seeds, ...extra].map((name) => name.toLowerCase()))].slice(0, 12);
}

/**
 * HippoRAG-lite Personalized PageRank (Gutiérrez et al. 2024): seed the query
 * entities, spread mass along existing SPO edges. Not a second graph DB.
 */
export function personalizedRank(query: string, hops: GraphHop[]): Map<string, number> {
  const seeds = synonymSeeds(query, hops);
  const mass = new Map<string, number>();
  for (const seed of seeds) mass.set(seed, 1);
  for (let step = 0; step < 2; step += 1) {
    const next = new Map(mass);
    for (const hop of hops) {
      const share = (mass.get(hop.from.toLowerCase()) ?? 0) * 0.85 * Math.max(0.2, hop.confidence);
      if (!share) continue;
      const to = hop.to.toLowerCase();
      next.set(to, (next.get(to) ?? 0) + share);
    }
    mass.clear();
    for (const [key, value] of next) mass.set(key, value);
  }
  return mass;
}

/** BFS over the existing Brain store. */
export function shortestPath(from: string, to: string, maxHops = 4): GraphHop[] {
  const start = String(from || "").trim();
  const goal = String(to || "")
    .trim()
    .toLowerCase();
  if (!start || !goal) return [];
  if (start.toLowerCase() === goal) return [];
  const queue: { node: string; path: GraphHop[] }[] = [{ node: start, path: [] }];
  const seen = new Set<string>([start.toLowerCase()]);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.path.length >= maxHops) continue;
    const edges = [...relatedEntities(cur.node), ...incomingEntities(cur.node)];
    for (const hop of edges) {
      const next = hop.from.toLowerCase() === cur.node.toLowerCase() ? hop.to : hop.from;
      const key = next.toLowerCase();
      if (seen.has(key)) continue;
      const path = [...cur.path, hop];
      if (key === goal) return path;
      seen.add(key);
      queue.push({ node: next, path });
    }
  }
  return [];
}

/**
 * Compose a stored path between two named entities. The result is an
 * inference over existing edges — never a new FACT row.
 */
export function inferMultiHop(query: string): { hops: GraphHop[]; note: string } | null {
  const entities = retrievalEntities(query).filter((name) => name.length > 2);
  if (entities.length < 2) return null;
  const path = shortestPath(entities[0]!, entities[1]!);
  if (path.length < 2) return null;
  return {
    hops: path,
    note: `${entities[0]} relates to ${entities[1]} via ${path.length} stored hops (inference, not a stored fact)`,
  };
}
