/**
 * FRIDAY · memory engine
 *
 * Six real memory tiers with their own retention rules, persisted locally and
 * retrieved by relevance + recency + usage. Nothing here is simulated: every
 * record is written by an actual FRIDAY event (a completed run, a user
 * correction, an approved improvement, an imported document).
 */

import { readLocalState, restoreFromDisk, writeState } from "../persist";
import {
  rankByRetrieval,
  retrievalTerms,
  type RankSignals,
  type VectorSnippet,
} from "../brain/retrieval";
import { coerceMemoryTier, shouldStoreLongTerm, shouldAutoClearMemory } from "../settings-runtime";

export type MemoryTier =
  "working" | "temporary" | "episodic" | "semantic" | "permanent" | "archived";

/** Distinguishable categories on the one memory store — not a second engine. */
export type MemoryKind =
  | "working"
  | "short-term"
  | "episodic"
  | "semantic"
  | "procedural"
  | "project"
  | "experience"
  | "decision"
  | "preference"
  | "failure";

export type MemoryScope = "owner" | "project" | "session";

export type MemoryItem = {
  id: string;
  tier: MemoryTier;
  title: string;
  text: string;
  tags: string[];
  source: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  uses: number;
  pinned: boolean;
  expiresAt?: number;
  kind?: MemoryKind;
  context?: string;
  verified?: boolean;
  freshnessAt?: number;
  scope?: MemoryScope;
  projectId?: string;
  relatedIds?: string[];
  relevance?: number;
  /** Set when a rival record disagrees — both are kept until one is superseded. */
  contradiction?: boolean;
  /** When set, this record is no longer current. Retrieval skips it. */
  supersededAt?: number;
};

export type MemoryTierSpec = {
  id: MemoryTier;
  label: string;
  note: string;
  /** 0 = never expires. */
  ttlMs: number;
  cap: number;
  weight: number;
};

export const memoryTiers: MemoryTierSpec[] = [
  {
    id: "working",
    label: "Working",
    note: "The current request: turns, intermediate results, active facts",
    ttlMs: 30 * 60 * 1000,
    cap: 40,
    weight: 1.25,
  },
  {
    id: "temporary",
    label: "Temporary",
    note: "Short-lived notes kept for the session or a few hours",
    ttlMs: 12 * 60 * 60 * 1000,
    cap: 120,
    weight: 1.0,
  },
  {
    id: "episodic",
    label: "Episodic",
    note: "What actually happened: tasks, runs, repairs, upgrades",
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    cap: 400,
    weight: 0.95,
  },
  {
    id: "semantic",
    label: "Semantic",
    note: "Learned patterns, workflows and how-to knowledge",
    ttlMs: 0,
    cap: 400,
    weight: 1.15,
  },
  {
    id: "permanent",
    label: "Permanent",
    note: "Owner identity, preferences and standing rules",
    ttlMs: 0,
    cap: 200,
    weight: 1.4,
  },
  {
    id: "archived",
    label: "Archived",
    note: "Retired records kept for audit and restore",
    ttlMs: 0,
    cap: 600,
    weight: 0.4,
  },
];

const tierSpec = new Map(memoryTiers.map((t) => [t.id, t]));

export type MemoryState = {
  items: MemoryItem[];
  counts: Record<MemoryTier, number>;
  lastWriteAt: number;
};

const STORAGE_KEY = "friday.memory.v1";
const BACKUP_KEY = "friday.memory.backup.v1";
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

let seq = 0;
const newId = () => `mem-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

const terms = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

const FILLER = new Set([
  "always",
  "never",
  "prefer",
  "please",
  "whenever",
  "possible",
  "rather",
  "than",
  "over",
  "use",
  "using",
  "want",
  "would",
  "like",
  "instead",
  "not",
  "just",
  "really",
  "very",
  "also",
  "dont",
  "paid",
]);

/** Content tokens used to recognise paraphrases of the same fact/preference. */
export function memoryContentTokens(text: string): string[] {
  return terms(text).filter((word) => !FILLER.has(word));
}

export function tokenJaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let inter = 0;
  for (const word of left) if (right.has(word)) inter += 1;
  return inter / new Set([...left, ...right]).size;
}

/** Cheap paraphrase folding — not a second embedding model. */
const TOKEN_FOLD: Record<string, string> = {
  always: "prefer",
  whenever: "prefer",
  usually: "prefer",
  offline: "local",
  ondevice: "local",
  onprem: "local",
};

function foldedTokens(text: string): string[] {
  return memoryContentTokens(text).map((word) => TOKEN_FOLD[word] ?? word);
}

export function memoriesSimilar(
  a: { title: string; text: string; kind?: MemoryKind },
  b: { title: string; text: string; kind?: MemoryKind },
): boolean {
  if (a.kind && b.kind && a.kind !== b.kind) return false;
  const left = foldedTokens(`${a.title} ${a.text}`);
  const right = foldedTokens(`${b.title} ${b.text}`);
  const score = tokenJaccard(left, right);
  return score >= 0.5;
}

/** Importance from existing fields — not a second ranking store. */
export function memoryImportance(item: {
  pinned?: boolean;
  verified?: boolean;
  confidence: number;
  uses: number;
  contradiction?: boolean;
}): number {
  let score = item.confidence * 0.4;
  if (item.pinned) score += 0.3;
  if (item.verified) score += 0.2;
  score += Math.min(0.2, item.uses * 0.02);
  if (item.contradiction) score -= 0.15;
  return Math.max(0, Math.min(1, score));
}

/** True when two statements assert and negate the same content token. */
export function meaningsDisagree(a: string, b: string): boolean {
  const left = polarityTokens(a);
  const right = polarityTokens(b);
  if (!left.asserted.length || !right.asserted.length) return false;
  if (left.asserted.some((token) => right.negated.includes(token))) return true;
  if (right.asserted.some((token) => left.negated.includes(token))) return true;
  return false;
}

function polarityTokens(text: string): { asserted: string[]; negated: string[] } {
  const raw = String(text || "").toLowerCase();
  const negated: string[] = [];
  const patterns = [
    /\bnot\s+([a-z0-9+#.]+)/g,
    /\binstead\s+of\s+([a-z0-9+#.]+)/g,
    /\brather\s+than\s+([a-z0-9+#.]+)/g,
    /\bover\s+(?:paid\s+)?([a-z0-9+#.]+)/g,
    /\bnever\s+(?:use\s+)?([a-z0-9+#.]+)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(raw);
    while (match) {
      const word = match[1] ?? "";
      if (word.length > 2 && !FILLER.has(word) && !STOP.has(word)) negated.push(word);
      match = pattern.exec(raw);
    }
  }
  const asserted = memoryContentTokens(text).filter((token) => !negated.includes(token));
  return { asserted, negated };
}

export function classifyMemoryKind(text: string, hint?: MemoryKind): MemoryKind {
  if (hint) return hint;
  const value = String(text || "");
  if (/\b(prefer|always|never|rather than)\b/i.test(value)) return "preference";
  if (/\b(failed|failure|didn't work|did not work|error)\b/i.test(value)) return "failure";
  if (/\b(how to|procedure|steps?:)\b/i.test(value)) return "procedural";
  if (/\b(decided|chose|decision)\b/i.test(value)) return "decision";
  if (/\b(last time|worked when|experience)\b/i.test(value)) return "experience";
  if (/\b(project|repo|codebase|workspace)\b/i.test(value)) return "project";
  if (value.length < 40) return "working";
  return "episodic";
}

export function defaultTierForKind(kind: MemoryKind): MemoryTier {
  switch (kind) {
    case "working":
      return "working";
    case "short-term":
    case "failure":
      return "temporary";
    case "episodic":
    case "experience":
    case "decision":
      return "episodic";
    case "semantic":
    case "procedural":
    case "project":
      return "semantic";
    case "preference":
      return "permanent";
  }
}

export type RememberInput = {
  tier: MemoryTier;
  title: string;
  text: string;
  tags?: string[];
  source?: string;
  confidence?: number;
  pinned?: boolean;
  kind?: MemoryKind;
  context?: string;
  verified?: boolean;
  scope?: MemoryScope;
  projectId?: string;
  relatedIds?: string[];
  relevance?: number;
};

class MemoryEngine {
  private items: MemoryItem[] = [];
  private listeners = new Set<() => void>();
  private snapshot: MemoryState = { items: [], counts: emptyCounts(), lastWriteAt: 0 };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => {
    this.load();
    return this.snapshot;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (typeof window === "undefined") return;
    this.items = readLocalState<MemoryItem[]>(STORAGE_KEY) ?? [];
    // Fresh install / cleared cache: recover the durable desktop copy.
    restoreFromDisk<MemoryItem[]>(STORAGE_KEY, (disk) => {
      if (!Array.isArray(disk) || !disk.length) return;
      this.items = healVocativeOwnerSeed(disk);
      this.sweep();
      this.emit(false);
    });
    if (!this.items.length) this.items = seed();
    this.items = healVocativeOwnerSeed(this.items);
    this.sweep();
    this.emit(false);
  }

  /** Drops expired non-pinned records and enforces the per-tier cap. */
  private sweep() {
    const now = Date.now();
    const kept: MemoryItem[] = [];
    const perTier = new Map<MemoryTier, number>();
    for (const item of [...this.items].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const spec = tierSpec.get(item.tier);
      if (!spec) continue;
      const expired =
        !item.pinned &&
        shouldAutoClearMemory() &&
        ((item.expiresAt && item.expiresAt < now) ||
          (spec.ttlMs > 0 && now - item.updatedAt > spec.ttlMs));
      if (expired) {
        if (item.tier !== "archived" && item.uses > 0) {
          kept.push({ ...item, tier: "archived", updatedAt: now });
        }
        continue;
      }
      const used = perTier.get(item.tier) ?? 0;
      if (used >= spec.cap && !item.pinned) continue;
      perTier.set(item.tier, used + 1);
      kept.push(item);
    }
    this.items = kept;
  }

  private emit(persist = true) {
    const counts = emptyCounts();
    this.items.forEach((i) => (counts[i.tier] += 1));
    this.snapshot = {
      items: [...this.items].sort((a, b) => b.updatedAt - a.updatedAt),
      counts,
      lastWriteAt: Date.now(),
    };
    this.listeners.forEach((l) => l());
    if (!persist || typeof window === "undefined" || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeState(STORAGE_KEY, this.items);
    }, 500);
  }

  /* ------------------------------------------------------------- writing */

  remember(input: RememberInput): MemoryItem {
    this.load();
    const now = Date.now();
    const tier = coerceMemoryTier(input.tier);
    input = tier === input.tier ? input : { ...input, tier };
    const kind = input.kind ?? classifyMemoryKind(input.text);
    const sameScope = (item: MemoryItem) => (item.projectId || "") === (input.projectId || "");
    const sameTitle = this.items.filter(
      (i) =>
        i.tier === input.tier &&
        i.title.toLowerCase() === input.title.toLowerCase() &&
        sameScope(i),
    );
    const exactBody = sameTitle.find(
      (i) => i.text.trim().toLowerCase() === input.text.trim().toLowerCase(),
    );
    const mergeByMeaning =
      kind === "preference" || kind === "semantic" || kind === "procedural" || kind === "project";
    const similar = mergeByMeaning
      ? this.items.find(
          (i) =>
            i.tier !== "archived" &&
            sameScope(i) &&
            memoriesSimilar(
              { title: i.title, text: i.text, kind: i.kind ?? classifyMemoryKind(i.text) },
              { title: input.title, text: input.text, kind },
            ),
        )
      : undefined;
    const candidate = exactBody ?? similar ?? sameTitle[0];
    const clashes =
      Boolean(candidate) &&
      candidate!.text.trim().toLowerCase() !== input.text.trim().toLowerCase() &&
      (meaningsDisagree(`${candidate!.title} ${candidate!.text}`, `${input.title} ${input.text}`) ||
        !memoriesSimilar(
          { title: candidate!.title, text: candidate!.text, kind: candidate!.kind ?? kind },
          { title: input.title, text: input.text, kind },
        ));
    if (candidate && !clashes) {
      candidate.text = input.text.length >= candidate.text.length ? input.text : candidate.text;
      candidate.updatedAt = now;
      candidate.freshnessAt = now;
      candidate.uses += 1;
      candidate.kind = candidate.kind ?? kind;
      candidate.confidence = Math.min(
        1,
        Math.max(candidate.confidence, input.confidence ?? 0.6) + 0.05,
      );
      if (input.tags?.length) candidate.tags = [...new Set([...candidate.tags, ...input.tags])];
      if (input.context) candidate.context = input.context;
      if (input.verified) candidate.verified = true;
      if (input.scope) candidate.scope = input.scope;
      if (input.projectId) candidate.projectId = input.projectId;
      if (input.relatedIds?.length) {
        candidate.relatedIds = [...new Set([...(candidate.relatedIds ?? []), ...input.relatedIds])];
      }
      if (
        shouldStoreLongTerm() &&
        kind === "preference" &&
        candidate.tier !== "permanent" &&
        candidate.uses >= 2
      ) {
        candidate.tier = "permanent";
      }
      if (
        shouldStoreLongTerm() &&
        candidate.verified &&
        candidate.uses >= 3 &&
        (kind === "semantic" || kind === "procedural" || kind === "experience") &&
        candidate.tier === "episodic"
      ) {
        candidate.tier = "semantic";
      }
      this.emit();
      return candidate;
    }
    const item: MemoryItem = {
      id: newId(),
      tier: input.tier,
      title: input.title.slice(0, 120),
      text: input.text.slice(0, 4000),
      tags: input.tags ?? [],
      source: input.source ?? "friday",
      confidence: input.confidence ?? 0.6,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: 0,
      uses: 0,
      pinned: input.pinned ?? false,
      kind,
      freshnessAt: now,
      scope: input.scope ?? "owner",
      verified: input.verified ?? false,
    };
    if (input.context) item.context = input.context;
    if (input.projectId) item.projectId = input.projectId;
    if (input.relatedIds?.length) item.relatedIds = [...input.relatedIds];
    if (input.relevance !== undefined) item.relevance = input.relevance;
    const explicit =
      Boolean(input.verified) ||
      input.source === "user" ||
      (input.tags ?? []).includes("correction");
    const maySupersede =
      explicit &&
      candidate &&
      clashes &&
      candidate.source !== "first-run" &&
      (kind === "decision" ||
        kind === "preference" ||
        kind === "project" ||
        (input.tags ?? []).includes("correction"));
    if (candidate && clashes && !maySupersede) {
      item.contradiction = true;
      item.relatedIds = [...new Set([...(item.relatedIds ?? []), candidate.id])];
      candidate.contradiction = true;
      candidate.relatedIds = [...new Set([...(candidate.relatedIds ?? []), item.id])];
    }
    this.items = [item, ...this.items];
    if (maySupersede && candidate) this.supersede(candidate.id, item.id);
    this.sweep();
    this.emit();
    return item;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        MemoryItem,
        | "title"
        | "text"
        | "tags"
        | "tier"
        | "pinned"
        | "confidence"
        | "kind"
        | "context"
        | "verified"
        | "freshnessAt"
        | "scope"
        | "projectId"
        | "relatedIds"
        | "relevance"
        | "contradiction"
        | "supersededAt"
      >
    >,
  ) {
    this.items = this.items.map((i) =>
      i.id === id ? ({ ...i, ...patch, updatedAt: Date.now() } as MemoryItem) : i,
    );
    this.emit();
  }

  pin(id: string) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    this.update(id, { pinned: !item.pinned });
  }

  /**
   * Newest explicit record wins. The older row is archived (not deleted) so
   * provenance remains. Does not invent a resolution for weak clashes.
   */
  supersede(oldId: string, newerId?: string): boolean {
    this.load();
    const older = this.items.find((item) => item.id === oldId);
    if (!older || older.source === "first-run") return false;
    const now = Date.now();
    older.tier = "archived";
    older.supersededAt = now;
    older.contradiction = false;
    older.updatedAt = now;
    if (newerId) {
      older.relatedIds = [...new Set([...(older.relatedIds ?? []), newerId])];
      const newer = this.items.find((item) => item.id === newerId);
      if (newer) {
        newer.relatedIds = [...new Set([...(newer.relatedIds ?? []), oldId])];
        newer.contradiction = false;
        newer.verified = true;
        newer.freshnessAt = now;
        newer.updatedAt = now;
      }
    }
    this.emit();
    return true;
  }

  forget(id: string) {
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
  }

  archive(id: string) {
    this.update(id, { tier: "archived", pinned: false });
  }

  restore(id: string, tier: MemoryTier = "semantic") {
    this.update(id, { tier });
  }

  promote(id: string) {
    const order: MemoryTier[] = ["working", "temporary", "episodic", "semantic", "permanent"];
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    const idx = order.indexOf(item.tier);
    this.update(id, { tier: order[Math.min(order.length - 1, Math.max(0, idx) + 1)]! });
  }

  clearTier(tier: MemoryTier) {
    this.items = this.items.filter((i) => i.tier !== tier || i.pinned);
    this.emit();
  }

  /** Cap + expiry pass. Returns how many records were dropped. */
  optimize(): number {
    this.load();
    const before = this.items.length;
    this.sweep();
    const dropped = Math.max(0, before - this.items.length);
    this.emit();
    return dropped;
  }

  /** Decay unused records then compact caps. Same hygiene the idle job uses. */
  hygiene(): { archived: number; dropped: number } {
    const archived = this.decayStale();
    const dropped = this.optimize();
    return { archived, dropped };
  }

  /* ------------------------------------------------------------ retrieval */

  search(
    query: string,
    options: { tiers?: MemoryTier[]; k?: number; context?: string } = {},
  ): MemoryItem[] {
    this.load();
    const k = options.k ?? 20;
    const pool = this.items.filter((i) => !options.tiers || options.tiers.includes(i.tier));
    if (!retrievalTerms(query).length) return pool.slice(0, k);
    return rankByRetrieval(pool, query, memorySignals, {
      k,
      minScore: 0.05,
      taskHint: options.context ?? query,
    }).map((row) => row.item);
  }

  /** Context injected before planning. Marks the hits as used. */
  retrieve(
    query: string,
    k = 6,
    options: { context?: string; vectorHits?: VectorSnippet[]; projectId?: string } = {},
  ): { item: MemoryItem; score: number }[] {
    this.load();
    if (!retrievalTerms(query).length) return [];
    const pool = this.items.filter((i) => {
      if (i.tier === "archived" || i.supersededAt) return false;
      if (!i.projectId) return true;
      return Boolean(options.projectId && i.projectId === options.projectId);
    });
    const hits = rankByRetrieval(pool, query, memorySignals, {
      k,
      minScore: 0.22,
      taskHint: options.context ?? query,
      ...(options.vectorHits?.length ? { vectorHits: options.vectorHits } : {}),
    });
    if (hits.length) {
      const now = Date.now();
      hits.forEach((h) => {
        h.item.uses += 1;
        h.item.lastUsedAt = now;
      });
      this.emit();
    }
    return hits.map((h) => ({ item: h.item, score: Number(h.score.toFixed(2)) }));
  }

  /* ------------------------------------------------- export / backup / IO */

  export(): string {
    return JSON.stringify({ version: 1, exportedAt: Date.now(), items: this.items }, null, 2);
  }

  backup(): number {
    if (typeof window === "undefined") return 0;
    writeState(BACKUP_KEY, { at: Date.now(), items: this.items });
    return this.items.length;
  }

  lastBackupAt(): number | null {
    if (typeof window === "undefined") return null;
    try {
      return readLocalState<{ at: number }>(BACKUP_KEY)?.at ?? null;
    } catch {
      return null;
    }
  }

  restoreBackup(): number {
    if (typeof window === "undefined") return 0;
    try {
      const parsed = readLocalState<{ items: MemoryItem[] }>(BACKUP_KEY);
      if (!parsed) return 0;
      this.items = parsed.items ?? [];
      this.sweep();
      this.emit();
      return this.items.length;
    } catch {
      return 0;
    }
  }

  import(json: string): number {
    const parsed = JSON.parse(json) as { items?: MemoryItem[] };
    const incoming = parsed.items ?? [];
    const known = new Set(this.items.map((i) => `${i.tier}:${i.title.toLowerCase()}`));
    const added = incoming.filter((i) => !known.has(`${i.tier}:${i.title.toLowerCase()}`));
    this.items = [...added, ...this.items];
    this.sweep();
    this.emit();
    return added.length;
  }

  /**
   * Lower confidence on stale unused records and archive the weakest.
   * Permanent / pinned items are never decayed.
   */
  decayStale(now = Date.now()): number {
    this.load();
    const twoWeeks = 14 * 86_400_000;
    let archived = 0;
    for (const item of this.items) {
      if (item.pinned || item.tier === "permanent" || item.tier === "archived") continue;
      const age = now - (item.freshnessAt ?? item.updatedAt);
      if (age < twoWeeks) continue;
      item.confidence = Math.max(0.05, item.confidence * 0.9);
      if (item.confidence < 0.15 && item.uses < 2) {
        item.tier = "archived";
        item.updatedAt = now;
        archived += 1;
      }
    }
    if (archived) this.emit();
    return archived;
  }

  /** Test/reset hook. Never called from the UI. Restores first-run seed. */
  resetForTests(): void {
    this.loaded = true;
    this.items = seed();
    this.emit(false);
  }
}

function memorySignals(item: MemoryItem): RankSignals {
  const spec = tierSpec.get(item.tier);
  const signals: RankSignals = {
    id: item.id,
    title: item.title,
    text: item.text,
    tags: item.tags,
    source: item.source,
    confidence: item.confidence,
    updatedAt: item.updatedAt,
    pinned: item.pinned,
    permanent: item.tier === "permanent",
    uses: item.uses,
    tierWeight: spec?.weight ?? 1,
    importance: memoryImportance(item),
  };
  if (item.scope) signals.scope = item.scope;
  if (item.freshnessAt !== undefined) signals.freshnessAt = item.freshnessAt;
  if (item.verified !== undefined) signals.verified = item.verified;
  if (item.contradiction !== undefined) signals.contradiction = item.contradiction;
  if (
    (item.kind === "decision" || item.kind === "preference" || item.kind === "project") &&
    item.verified &&
    !item.contradiction &&
    !item.supersededAt
  ) {
    signals.preferred = true;
  }
  return signals;
}

function emptyCounts(): Record<MemoryTier, number> {
  return {
    working: 0,
    temporary: 0,
    episodic: 0,
    semantic: 0,
    permanent: 0,
    archived: 0,
  };
}

const PROJECT_OWNER_MEMORY =
  "Devendra Singh Meena (devendrarj25) is the creator and publisher of this FRIDAY project. Disclose only when asked who owns or made FRIDAY.";

function healVocativeOwnerSeed(items: MemoryItem[]): MemoryItem[] {
  return items.map((item) => {
    if (item.source === "first-run" && /Address him as Dev/i.test(item.text)) {
      return { ...item, text: PROJECT_OWNER_MEMORY, updatedAt: Date.now() };
    }
    return item;
  });
}

function seed(): MemoryItem[] {
  const now = Date.now();
  const base = {
    tags: ["identity"],
    source: "first-run",
    confidence: 1,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: 0,
    uses: 0,
    pinned: true,
  };
  return [
    {
      id: newId(),
      tier: "permanent",
      title: "Owner",
      text: PROJECT_OWNER_MEMORY,
      ...base,
    },
    {
      id: newId(),
      tier: "permanent",
      title: "Operating rules",
      text: "Never modify production code without a backup, validation and approval for risky changes. Never block the UI thread.",
      ...base,
      tags: ["policy"],
    },
  ];
}

export const memory = new MemoryEngine();
