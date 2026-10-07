/**
 * FRIDAY · memory fabric
 *
 * One authority: the existing memory engine and knowledge base. This module
 * decides what may influence a turn. Indexes, fingerprints, and tombstones are
 * projections and can be rebuilt. A superseded fact stays stored for a
 * historical question and stays out of a current answer. Explicit corrections
 * outrank guesses. Sensitive attributes and identity are not inferred.
 * Deletion removes the record from authority, the knowledge projection, the
 * compiled lines, and a later restore of a backup that still lists it.
 *
 * Adapted from provenance-grounded memory (evidence before belief), from
 * separating what is stored from what is used, and from lifecycle links for
 * merge, supersession, contradiction, and coexistence. No second store.
 * No model owns this.
 */

import { readLocalState, writeState } from "../persist";
import {
  classifyMemoryKind,
  meaningsDisagree,
  memoriesSimilar,
  memory,
  memoryContentTokens,
  type MemoryItem,
  type MemoryKind,
  type MemoryScope,
  type MemoryTier,
} from "../self/memory-engine";
import { brainKnowledge, deriveKnowledgeFromMemory } from "./knowledge-base";
import { localNeighborhood } from "./knowledge-graph";
import { considerMemory } from "./memory-policy";

export const MEMORY_FABRIC_SCHEMA = 1;

const STORAGE_KEY = "friday.memory-fabric.v1";

export type RetrievalStrategy = "lexical" | "vector" | "graph" | "temporal" | "hybrid";

export type EvidenceClass =
  "direct" | "derived" | "corroborated" | "weak" | "stale" | "contradicted" | "unknown";

export type PreferenceAuthority = "explicit" | "confirmed" | "inferred" | "blocked";

export type LifecycleLink = "merge" | "supersession" | "contradiction" | "coexistence";

export type MemoryContractId =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural"
  | "experience"
  | "preference"
  | "identity-boundary";

export type MemoryContract = {
  id: MemoryContractId;
  tier: MemoryTier;
  kind: MemoryKind;
  durable: boolean;
  /** Durable contracts stay episodic until a record is verified. */
  requiresEvidence: boolean;
  /** Identity and sensitive attributes are never filled in from a guess. */
  inferSensitive: boolean;
};

export const MEMORY_CONTRACTS: readonly MemoryContract[] = [
  {
    id: "working",
    tier: "working",
    kind: "working",
    durable: false,
    requiresEvidence: false,
    inferSensitive: false,
  },
  {
    id: "episodic",
    tier: "episodic",
    kind: "episodic",
    durable: false,
    requiresEvidence: false,
    inferSensitive: false,
  },
  {
    id: "semantic",
    tier: "semantic",
    kind: "semantic",
    durable: true,
    requiresEvidence: true,
    inferSensitive: false,
  },
  {
    id: "procedural",
    tier: "semantic",
    kind: "procedural",
    durable: true,
    requiresEvidence: true,
    inferSensitive: false,
  },
  {
    id: "experience",
    tier: "episodic",
    kind: "experience",
    durable: false,
    requiresEvidence: true,
    inferSensitive: false,
  },
  {
    id: "preference",
    tier: "permanent",
    kind: "preference",
    durable: true,
    requiresEvidence: false,
    inferSensitive: false,
  },
  {
    id: "identity-boundary",
    tier: "permanent",
    kind: "preference",
    durable: true,
    requiresEvidence: true,
    inferSensitive: false,
  },
];

export type QueryPlan = {
  strategy: RetrievalStrategy;
  historical: boolean;
  personal: boolean;
  currentness: boolean;
  sensitive: boolean;
};

export type GovernedHit = {
  item: MemoryItem;
  score: number;
  evidence: EvidenceClass;
  authority: PreferenceAuthority;
};

export type FabricBundle = {
  schema: number;
  exportedAt: number;
  tombstones: string[];
  fingerprints: string[];
  memory: { version: number; exportedAt: number; items: MemoryItem[] };
};

const tombstones = new Set<string>();
const ingestFingerprints = new Set<string>();
const compiledLines = new Map<string, string[]>();

let hydrated = false;
let cacheEpoch = 1;
let fabricOn = true;

const HISTORICAL = /\b(previously|used to|before|history of|when did|what did i|earlier)\b/i;
const GRAPH = /\b(depends on|related to|who owns|part of|connected to)\b/i;
const CURRENT = /\b(latest|today|current|right now)\b/i;
const PERSONAL = /\b(i prefer|i like|my preference|remember that i)\b/i;
const WEAK_SENSITIVE =
  /\b(religion|diagnos(?:is|ed)|pregnan(?:t|cy)|sexuality|ethnicity|political party)\b/i;
const COVER_NOISE = new Set([
  "previously",
  "earlier",
  "before",
  "history",
  "prefer",
  "preference",
  "preferred",
  "remember",
  "current",
  "latest",
  "today",
  "right",
  "what",
  "when",
  "that",
  "this",
  "with",
  "have",
  "from",
  "about",
  "does",
  "used",
]);

type SavedFabric = {
  schema?: number;
  tombstones?: string[];
  fingerprints?: string[];
};

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const saved = readLocalState<SavedFabric>(STORAGE_KEY);
  if (!saved || (saved.schema ?? 0) > MEMORY_FABRIC_SCHEMA) return;
  for (const id of saved.tombstones ?? []) tombstones.add(id);
  for (const fp of saved.fingerprints ?? []) ingestFingerprints.add(fp);
}

function persist(): void {
  writeState(STORAGE_KEY, {
    schema: MEMORY_FABRIC_SCHEMA,
    tombstones: [...tombstones],
    fingerprints: [...ingestFingerprints].slice(-400),
  });
}

function touchCache(): void {
  cacheEpoch += 1;
  compiledLines.clear();
}

export function memoryCacheEpoch(): number {
  return cacheEpoch;
}

export function memoryFabricEnabled(): boolean {
  return fabricOn;
}

/** Rollback for this governance pass. The memory engine itself stays in place. */
export function setMemoryFabricEnabled(enabled: boolean): void {
  fabricOn = enabled;
  touchCache();
}

export function resetMemoryFabric(): void {
  tombstones.clear();
  ingestFingerprints.clear();
  fabricOn = true;
  hydrated = true;
  touchCache();
  persist();
}

export function contractFor(id: MemoryContractId): MemoryContract {
  const found = MEMORY_CONTRACTS.find((row) => row.id === id);
  if (!found) throw new Error(`unknown memory contract: ${id}`);
  return found;
}

export function classifyMemoryQuery(prompt: string): QueryPlan {
  const text = String(prompt || "");
  const historical = HISTORICAL.test(text);
  const personal = PERSONAL.test(text);
  const currentness = CURRENT.test(text);
  const graph = GRAPH.test(text);
  const sensitive = WEAK_SENSITIVE.test(text);
  let strategy: RetrievalStrategy = "lexical";
  if (historical || currentness) strategy = "temporal";
  else if (graph) strategy = "graph";
  else if (text.length > 140) strategy = "vector";
  if ((personal && (graph || currentness)) || (graph && currentness)) strategy = "hybrid";
  return { strategy, historical, personal, currentness, sensitive };
}

/**
 * Missing embeddings never fail the turn. Vector and hybrid plans fall back
 * to the lexical ranking the memory engine already computed.
 */
export function resolveStrategy(
  plan: QueryPlan,
  vectorsAvailable: boolean | undefined,
): { strategy: RetrievalStrategy; degraded: boolean } {
  if (vectorsAvailable === false && (plan.strategy === "vector" || plan.strategy === "hybrid")) {
    return { strategy: "lexical", degraded: true };
  }
  return { strategy: plan.strategy, degraded: false };
}

export function preferenceAuthority(item: MemoryItem): PreferenceAuthority {
  const blob = `${item.title} ${item.text}`;
  const explicit =
    item.source === "user" || item.source === "teach" || (item.tags ?? []).includes("correction");
  if (WEAK_SENSITIVE.test(blob) && !explicit) return "blocked";
  if (explicit) return "explicit";
  if (item.verified) return "confirmed";
  if (item.kind === "preference" || (item.tags ?? []).includes("inferred")) return "inferred";
  return "confirmed";
}

/** Owner and taught records outrank a web or chat guess. */
export function sourceTrust(source: string): number {
  const from = String(source || "").toLowerCase();
  if (from === "user" || from === "teach" || from === "first-run") return 1;
  if (from === "document" || from.startsWith("docs")) return 0.72;
  if (from === "web" || from.startsWith("http")) return 0.32;
  if (from === "conversation" || from.startsWith("conversation") || from === "chat") return 0.48;
  return 0.5;
}

/**
 * A weaker source must not replace a verified owner preference that talks
 * about the same thing. Equal-trust paraphrases still consolidate.
 */
export function resistPoison(
  incoming: { title: string; text: string; source: string },
  items: MemoryItem[],
): { blocked: boolean; reason: string; item: MemoryItem | null } {
  hydrate();
  const incomingTrust = sourceTrust(incoming.source);
  const incomingKind = classifyMemoryKind(`${incoming.title} ${incoming.text}`);
  if (incomingKind !== "preference" && incomingKind !== "decision") {
    return { blocked: false, reason: "", item: null };
  }
  const incomingTokens = new Set(memoryContentTokens(`${incoming.title} ${incoming.text}`));
  for (const item of items) {
    if (item.supersededAt || item.tier === "archived" || tombstones.has(item.id)) continue;
    const itemKind = item.kind ?? classifyMemoryKind(item.text);
    if (itemKind !== incomingKind) continue;
    const trusted = item.verified || item.source === "user" || item.source === "teach";
    if (!trusted) continue;
    if (sourceTrust(item.source) - incomingTrust < 0.25) continue;
    if (item.text.trim().toLowerCase() === incoming.text.trim().toLowerCase()) {
      return { blocked: false, reason: "", item };
    }
    const shared = memoryContentTokens(item.text).filter((token) => incomingTokens.has(token));
    const kind = item.kind ? { kind: item.kind } : {};
    const prior = { title: item.text.slice(0, 48), text: item.text, ...kind };
    const rival = { title: incoming.text.slice(0, 48), text: incoming.text, ...kind };
    if (shared.length > 0 && !memoriesSimilar(prior, rival)) {
      return {
        blocked: true,
        reason: "a weaker source cannot replace a stronger record",
        item,
      };
    }
  }
  return { blocked: false, reason: "", item: null };
}

export function channelScores(
  prompt: string,
  item: MemoryItem,
  now: number,
  hops: { from: string; to: string }[],
): { lexical: number; graph: number; temporal: number } {
  const words = coverWords(prompt);
  const hay = `${item.title} ${item.text}`.toLowerCase();
  const lexical = words.length
    ? words.filter((word) => hay.includes(word)).length / words.length
    : 0;
  const graphHits = hops.filter(
    (hop) => hay.includes(hop.from.toLowerCase()) || hay.includes(hop.to.toLowerCase()),
  );
  const graph = hops.length ? Math.min(1, graphHits.length / Math.min(3, hops.length)) : 0;
  const at = item.freshnessAt ?? item.updatedAt;
  const ageDays = Math.max(0, (now - at) / 86_400_000);
  const temporal = 1 / (1 + ageDays / 14);
  return { lexical, graph, temporal };
}

/** The named strategy actually changes the score. Lexical stays the base. */
export function fuseChannels(
  strategy: RetrievalStrategy,
  channels: { lexical: number; graph: number; temporal: number },
  vector = 0,
): number {
  if (strategy === "graph") return channels.lexical * 0.2 + channels.graph * 0.8;
  if (strategy === "temporal") return channels.lexical * 0.25 + channels.temporal * 0.75;
  if (strategy === "vector")
    return vector > 0 ? channels.lexical * 0.35 + vector * 0.65 : channels.lexical;
  if (strategy === "hybrid") {
    const vectorChannel = vector > 0 ? vector : channels.lexical;
    return (channels.lexical + channels.graph + channels.temporal + vectorChannel) / 4;
  }
  return channels.lexical;
}

/** Owner explicit outranks a project guess, which outranks a session guess. */
export function preferredByScope(items: MemoryItem[]): MemoryItem | null {
  hydrate();
  const live = items.filter(
    (item) => !item.supersededAt && item.tier !== "archived" && !tombstones.has(item.id),
  );
  if (!live.length) return null;
  const rank = (item: MemoryItem) => {
    const scope = item.scope === "session" ? 1 : item.scope === "project" ? 2 : 3;
    return scope * 10 + authorityRank(preferenceAuthority(item));
  };
  return [...live].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

export function refuseInferredSensitive(text: string, source: string): boolean {
  const explicit = source === "user" || source === "teach";
  if (explicit) return false;
  return WEAK_SENSITIVE.test(text);
}

export function scopeAllows(
  item: MemoryItem,
  active?: { scope?: MemoryScope; projectId?: string },
): boolean {
  if (!active) return true;
  if (active.projectId && item.projectId && item.projectId !== active.projectId) return false;
  if (active.scope && item.scope && item.scope !== active.scope) return false;
  return true;
}

export function gateEvidence(
  item: MemoryItem,
  now: number,
): { klass: EvidenceClass; mayInfluence: boolean } {
  hydrate();
  if (tombstones.has(item.id)) return { klass: "unknown", mayInfluence: false };
  if (item.contradiction) return { klass: "contradicted", mayInfluence: false };
  if (item.expiresAt !== undefined && item.expiresAt <= now) {
    return { klass: "stale", mayInfluence: false };
  }
  if (item.supersededAt) return { klass: "stale", mayInfluence: false };
  const authority = preferenceAuthority(item);
  if (authority === "blocked") return { klass: "unknown", mayInfluence: false };
  if (!item.verified && item.confidence < 0.4) return { klass: "weak", mayInfluence: false };
  if (authority === "explicit" && item.verified) return { klass: "direct", mayInfluence: true };
  if (item.verified && item.confidence >= 0.75)
    return { klass: "corroborated", mayInfluence: true };
  if (item.confidence >= 0.5) return { klass: "derived", mayInfluence: true };
  return { klass: "weak", mayInfluence: false };
}

export function judgeLifecycle(
  prior: MemoryItem,
  incoming: { text: string; scope?: MemoryScope; projectId?: string; explicit?: boolean },
): LifecycleLink {
  const projectChanged =
    (prior.projectId || "") !== (incoming.projectId || "") &&
    Boolean(prior.projectId || incoming.projectId);
  if (projectChanged) return "coexistence";
  if (prior.scope && incoming.scope && prior.scope !== incoming.scope) return "coexistence";
  if (prior.text.trim().toLowerCase() === incoming.text.trim().toLowerCase()) return "merge";
  if (incoming.explicit) return "supersession";
  const priorBlob = `${prior.title} ${prior.text}`;
  const nextBlob = `${prior.title} ${incoming.text}`;
  if (meaningsDisagree(priorBlob, nextBlob)) return "contradiction";
  if (
    memoriesSimilar(prior, {
      title: prior.title,
      text: incoming.text,
      ...(prior.kind ? { kind: prior.kind } : {}),
    })
  ) {
    return "merge";
  }
  return "contradiction";
}

function authorityRank(authority: PreferenceAuthority): number {
  if (authority === "explicit") return 3;
  if (authority === "confirmed") return 2;
  if (authority === "inferred") return 1;
  return 0;
}

function coverWords(prompt: string): string[] {
  const words = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !COVER_NOISE.has(word));
  if (words.length) return words;
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
}

function covers(prompt: string, item: MemoryItem): boolean {
  const words = coverWords(prompt);
  if (!words.length) return false;
  const hay = `${item.title} ${item.text}`.toLowerCase();
  const hits = words.filter((word) => hay.includes(word)).length;
  return hits >= Math.min(2, words.length);
}

export function governRecall(input: {
  prompt: string;
  hits: { item: MemoryItem; score: number }[];
  archive?: MemoryItem[];
  now?: number;
  budget?: number;
  scope?: MemoryScope;
  projectId?: string;
  vectorsAvailable?: boolean;
  hops?: { from: string; to: string }[];
  vectorScore?: number;
}): {
  plan: QueryPlan;
  strategy: RetrievalStrategy;
  degraded: boolean;
  admitted: GovernedHit[];
  withheld: { id: string; reason: string }[];
} {
  hydrate();
  const now = input.now ?? Date.now();
  const plan = classifyMemoryQuery(input.prompt);
  const resolved = resolveStrategy(plan, input.vectorsAvailable);
  const active =
    input.scope || input.projectId
      ? {
          ...(input.scope ? { scope: input.scope } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
        }
      : undefined;
  const withheld: { id: string; reason: string }[] = [];
  let hops = input.hops;
  if (!hops && resolved.strategy !== "lexical") {
    try {
      hops = localNeighborhood(input.prompt, 8).map((hop) => ({ from: hop.from, to: hop.to }));
    } catch {
      hops = [];
    }
  }
  hops = hops ?? [];
  const pool = [...input.hits];
  if (plan.historical) {
    for (const item of input.archive ?? []) {
      if (!item.supersededAt || tombstones.has(item.id)) continue;
      if (pool.some((row) => row.item.id === item.id)) continue;
      if (covers(input.prompt, item)) pool.push({ item, score: 0.3 });
    }
  }
  const admitted: GovernedHit[] = [];
  for (const row of pool) {
    if (tombstones.has(row.item.id)) {
      withheld.push({ id: row.item.id, reason: "deleted" });
      continue;
    }
    if (active && !scopeAllows(row.item, active)) {
      withheld.push({ id: row.item.id, reason: "out of scope" });
      continue;
    }
    const authority = preferenceAuthority(row.item);
    if (authority === "blocked") {
      withheld.push({ id: row.item.id, reason: "sensitive inference is not used" });
      continue;
    }
    const gate = gateEvidence(row.item, now);
    const historicalOk =
      plan.historical && Boolean(row.item.supersededAt) && !row.item.contradiction;
    if (!gate.mayInfluence && !historicalOk) {
      withheld.push({ id: row.item.id, reason: gate.klass });
      continue;
    }
    if (!plan.historical && row.item.supersededAt) {
      withheld.push({ id: row.item.id, reason: "superseded" });
      continue;
    }
    const channels = channelScores(input.prompt, row.item, now, hops);
    const fused = fuseChannels(resolved.strategy, channels, input.vectorScore ?? 0);
    const score =
      resolved.strategy === "lexical"
        ? row.score + authorityRank(authority) * 0.01
        : row.score * 0.45 + fused + authorityRank(authority) * 0.01;
    admitted.push({
      item: row.item,
      score,
      evidence: historicalOk ? "stale" : gate.klass,
      authority,
    });
  }
  admitted.sort(
    (a, b) => authorityRank(b.authority) - authorityRank(a.authority) || b.score - a.score,
  );
  const budget = input.budget ?? admitted.length;
  const kept = admitted.slice(0, Math.max(0, budget));
  for (const extra of admitted.slice(kept.length)) {
    withheld.push({ id: extra.item.id, reason: "over budget" });
  }
  return {
    plan,
    strategy: resolved.strategy,
    degraded: resolved.degraded,
    admitted: kept,
    withheld,
  };
}

function projectBelief(item: MemoryItem): void {
  try {
    deriveKnowledgeFromMemory(item);
  } catch {
    /* the knowledge projection is optional; the memory row remains authoritative */
  }
}

export function admitMemory(input: {
  title: string;
  text: string;
  source: string;
  tier?: MemoryTier;
  kind?: MemoryKind;
  verified?: boolean;
  inferred?: boolean;
  now?: number;
  contract?: MemoryContractId;
  scope?: MemoryScope;
  projectId?: string;
}): { stored: boolean; duplicate: boolean; item: MemoryItem | null; reason: string } {
  hydrate();
  const text = input.text.trim();
  const title = input.title.trim().slice(0, 120);
  const contract = input.contract ? contractFor(input.contract) : undefined;
  if (input.contract === "identity-boundary" && (input.inferred || !input.verified)) {
    return {
      stored: false,
      duplicate: false,
      item: null,
      reason: "identity is not inferred",
    };
  }
  if (input.inferred && WEAK_SENSITIVE.test(`${title} ${text}`)) {
    return {
      stored: false,
      duplicate: false,
      item: null,
      reason: "sensitive attributes are not inferred",
    };
  }
  const verdict = considerMemory({
    text,
    title,
    ...(input.verified !== undefined ? { ok: input.verified } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
  });
  if (!verdict.keep) {
    return { stored: false, duplicate: false, item: null, reason: verdict.reason };
  }
  const poison = resistPoison({ title, text, source: input.source }, memory.getSnapshot().items);
  if (poison.blocked) {
    return { stored: false, duplicate: false, item: poison.item, reason: poison.reason };
  }
  const fingerprint = `${input.source}\n${title.toLowerCase()}\n${text.toLowerCase()}`;
  const existing = memory
    .getSnapshot()
    .items.find(
      (item) =>
        item.title.toLowerCase() === title.toLowerCase() &&
        item.text.trim().toLowerCase() === text.toLowerCase() &&
        !item.supersededAt &&
        !tombstones.has(item.id),
    );
  if (ingestFingerprints.has(fingerprint) && existing) {
    return {
      stored: false,
      duplicate: true,
      item: existing,
      reason: "replay kept the original record",
    };
  }
  let tier = input.tier ?? contract?.tier ?? verdict.tier;
  if (contract?.requiresEvidence && contract.durable && !input.verified) tier = "episodic";
  const kind = input.kind ?? contract?.kind ?? (input.inferred ? "preference" : undefined);
  const item = memory.remember({
    tier,
    title,
    text,
    source: input.source,
    ...(kind ? { kind } : {}),
    confidence: input.verified ? Math.max(verdict.confidence, 0.8) : verdict.confidence,
    verified: Boolean(input.verified),
    tags: input.inferred ? ["inferred"] : input.verified ? ["explicit"] : [],
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  });
  if (input.now) memory.update(item.id, { freshnessAt: input.now });
  ingestFingerprints.add(fingerprint);
  if (!existing && input.verified) projectBelief(item);
  touchCache();
  persist();
  return {
    stored: !existing,
    duplicate: Boolean(existing),
    item,
    reason: verdict.reason,
  };
}

function identityLocked(item: MemoryItem): boolean {
  return item.source === "first-run" || (item.tags ?? []).includes("identity");
}

export function applyOwnerCorrection(input: {
  title: string;
  text: string;
  scope?: MemoryScope;
  projectId?: string;
}): { item: MemoryItem; supersededId: string | null; reason: string } {
  hydrate();
  const title = input.title.trim();
  const text = input.text.trim();
  const prior = memory
    .getSnapshot()
    .items.find(
      (item) =>
        item.title.toLowerCase() === title.toLowerCase() &&
        !item.supersededAt &&
        item.tier !== "archived" &&
        !tombstones.has(item.id),
    );
  if (prior && identityLocked(prior)) {
    return {
      item: prior,
      supersededId: null,
      reason: "identity boundary is not overwritten by a preference correction",
    };
  }
  const link = prior
    ? judgeLifecycle(prior, {
        text,
        explicit: true,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      })
    : "supersession";
  let supersededId: string | null = null;
  if (link === "supersession" && prior && prior.text.trim().toLowerCase() !== text.toLowerCase()) {
    memory.supersede(prior.id);
    supersededId = prior.id;
  }
  const item = memory.remember({
    tier: "permanent",
    title,
    text,
    source: "user",
    kind: "preference",
    verified: true,
    confidence: 1,
    tags: ["correction"],
    pinned: true,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  });
  if (supersededId) memory.supersede(supersededId, item.id);
  projectBelief(item);
  touchCache();
  persist();
  const reason =
    link === "coexistence"
      ? "different scope kept both records"
      : link === "merge"
        ? "same meaning kept"
        : supersededId
          ? "older record superseded"
          : "correction stored";
  return { item, supersededId, reason };
}

export function forgetEverywhere(id: string): { removed: boolean; knowledgeIds: string[] } {
  hydrate();
  const knowledgeIds = brainKnowledge
    .getSnapshot()
    .entries.filter(
      (entry) =>
        entry.source === `memory:${id}` ||
        entry.source === `memory/${id}` ||
        entry.derivedFromMemoryId === id,
    )
    .map((entry) => entry.id);
  for (const entryId of knowledgeIds) brainKnowledge.forget(entryId);
  const before = memory.getSnapshot().items.some((item) => item.id === id);
  memory.forget(id);
  tombstones.add(id);
  touchCache();
  persist();
  return { removed: before, knowledgeIds };
}

export function rebuildProjection(
  items: MemoryItem[],
  now = 0,
): {
  records: { id: string; text: string }[];
  edges: { from: string; to: string }[];
  omitted: string[];
} {
  hydrate();
  const omitted: string[] = [];
  const records: { id: string; text: string }[] = [];
  const live = new Set<string>();
  for (const item of items) {
    if (tombstones.has(item.id) || item.supersededAt || item.tier === "archived") {
      omitted.push(item.id);
      continue;
    }
    if (item.expiresAt !== undefined && item.expiresAt <= now) {
      omitted.push(item.id);
      continue;
    }
    records.push({ id: item.id, text: item.text });
    live.add(item.id);
  }
  const edges: { from: string; to: string }[] = [];
  for (const item of items) {
    if (!live.has(item.id)) continue;
    for (const to of item.relatedIds ?? []) {
      if (live.has(to) && !tombstones.has(to)) edges.push({ from: item.id, to });
    }
  }
  return { records, edges, omitted };
}

export function projectLifecycle(
  items: MemoryItem[],
): { from: string; to: string; link: LifecycleLink }[] {
  hydrate();
  const links: { from: string; to: string; link: LifecycleLink }[] = [];
  for (const item of items) {
    if (tombstones.has(item.id)) continue;
    for (const to of item.relatedIds ?? []) {
      const other = items.find((row) => row.id === to);
      if (!other || tombstones.has(to)) continue;
      let link: LifecycleLink = "merge";
      if (item.supersededAt || other.supersededAt) link = "supersession";
      else if (item.contradiction || other.contradiction) link = "contradiction";
      else if (
        (item.projectId || "") !== (other.projectId || "") &&
        (item.projectId || other.projectId)
      ) {
        link = "coexistence";
      }
      links.push({ from: item.id, to, link });
    }
  }
  return links;
}

/** True the first time this exact source text is seen. False on a replay. */
export function claimIngestFingerprint(source: string, text: string): boolean {
  hydrate();
  const fingerprint = `${source}\n${text.trim().toLowerCase().replace(/\s+/g, " ")}`;
  if (ingestFingerprints.has(fingerprint)) return false;
  ingestFingerprints.add(fingerprint);
  persist();
  return true;
}

export function promoteIfEvidenced(item: MemoryItem): { promoted: boolean; reason: string } {
  hydrate();
  if (tombstones.has(item.id)) return { promoted: false, reason: "deleted" };
  if (item.contradiction || item.supersededAt) return { promoted: false, reason: "not settled" };
  if (!item.verified || item.confidence < 0.7) {
    return { promoted: false, reason: "evidence is not enough" };
  }
  if (item.tier === "episodic") {
    memory.update(item.id, { tier: "semantic", freshnessAt: item.freshnessAt ?? item.updatedAt });
    const stored = memory.getSnapshot().items.find((row) => row.id === item.id);
    if (stored) projectBelief(stored);
    touchCache();
    return { promoted: true, reason: "verified episodic memory promoted to semantic" };
  }
  return { promoted: false, reason: "already durable" };
}

export function takeCompiledMemory(
  key: string,
  build: () => string[],
): { lines: string[]; reused: boolean } {
  hydrate();
  const found = compiledLines.get(key);
  if (found) return { lines: found, reused: true };
  const lines = build();
  compiledLines.set(key, lines);
  return { lines, reused: false };
}

type LooseBundle = {
  schema?: number;
  exportedAt?: number;
  tombstones?: unknown;
  fingerprints?: unknown;
  items?: unknown;
  memory?: { items?: unknown; exportedAt?: number };
};

export function migrateFabricBundle(raw: unknown): FabricBundle {
  if (!raw || typeof raw !== "object") throw new Error("memory fabric backup is not an object");
  const body = raw as LooseBundle;
  const schema = typeof body.schema === "number" ? body.schema : 0;
  if (schema > MEMORY_FABRIC_SCHEMA) {
    throw new Error("memory fabric backup is newer than this FRIDAY");
  }
  const memoryRaw = body.memory && typeof body.memory === "object" ? body.memory : body;
  const items = Array.isArray(memoryRaw.items) ? (memoryRaw.items as MemoryItem[]) : [];
  const tombstoneIds = Array.isArray(body.tombstones)
    ? body.tombstones.filter((id): id is string => typeof id === "string")
    : [];
  const fingerprints = Array.isArray(body.fingerprints)
    ? body.fingerprints.filter((id): id is string => typeof id === "string")
    : [];
  return {
    schema: MEMORY_FABRIC_SCHEMA,
    exportedAt: typeof body.exportedAt === "number" ? body.exportedAt : 0,
    tombstones: tombstoneIds,
    fingerprints,
    memory: {
      version: 1,
      exportedAt: typeof memoryRaw.exportedAt === "number" ? memoryRaw.exportedAt : 0,
      items,
    },
  };
}

export function exportFabricBundle(): string {
  hydrate();
  const parsed = JSON.parse(memory.export()) as {
    version?: number;
    exportedAt?: number;
    items?: MemoryItem[];
  };
  const bundle: FabricBundle = {
    schema: MEMORY_FABRIC_SCHEMA,
    exportedAt: Date.now(),
    tombstones: [...tombstones],
    fingerprints: [...ingestFingerprints],
    memory: {
      version: parsed.version ?? 1,
      exportedAt: parsed.exportedAt ?? 0,
      items: (parsed.items ?? []).filter((item) => !tombstones.has(item.id)),
    },
  };
  return JSON.stringify(bundle);
}

export function restoreFabricBundle(json: string): { restored: number; removed: number } {
  const bundle = migrateFabricBundle(JSON.parse(json) as unknown);
  tombstones.clear();
  for (const id of bundle.tombstones) tombstones.add(id);
  ingestFingerprints.clear();
  for (const fp of bundle.fingerprints) ingestFingerprints.add(fp);
  const live = bundle.memory.items.filter((item) => item?.id && !tombstones.has(item.id));
  const restored = memory.import(JSON.stringify({ version: 1, items: live }));
  let removed = 0;
  for (const id of [...tombstones]) {
    if (memory.getSnapshot().items.some((item) => item.id === id)) {
      memory.forget(id);
      removed += 1;
    }
  }
  hydrated = true;
  touchCache();
  persist();
  return { restored, removed };
}
