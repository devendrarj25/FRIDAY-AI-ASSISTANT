/**
 * FRIDAY · Brain knowledge base
 *
 * The Brain is FRIDAY's own persistent memory — independent of any AI model.
 * A model can be swapped, removed or unavailable; what FRIDAY has learned stays.
 *
 * Stored here (durable across restart, shared by browser and Windows EXE
 * through the one persistence layer in ../persist):
 *   preferences · validated knowledge · skills · tool knowledge · project and
 *   source knowledge · debugging solutions · successful workflows · previous
 *   solutions · task history · pending and long-running task state.
 *
 * Consent rule: nothing personal becomes permanent on its own. An entry can be
 * `permanent` only after the owner explicitly approves it, and every permanent
 * entry keeps the approval timestamp so it can be reviewed or withdrawn.
 */

import { readLocalState, restoreFromDisk, writeState } from "../persist";
import { notifications } from "../notifications";
import {
  compareBeliefs,
  describeEvidence,
  formatEvidenceLine,
  rankByRetrieval,
  type RankSignals,
  type VectorSnippet,
} from "./retrieval";

export type KnowledgeKind =
  | "preference"
  | "knowledge"
  | "skill"
  | "tool"
  | "project"
  | "debugging"
  | "workflow"
  | "solution"
  | "personal";

/** How an entry earned its place in the Brain. */
export type Provenance = "observed" | "verified" | "user";

/** Structured belief shape — still stored in this one knowledge base. */
export type KnowledgeShape = "fact" | "entity" | "relation" | "note";

/** Honest knowledge freshness class — never invents a resolution. */
export type KnowledgeStatus = "known" | "unknown" | "stale" | "contradicted" | "uncertain";

export const KNOWLEDGE_STALE_MS = 14 * 86_400_000;

export type BrainEntry = {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string[];
  /** Where it came from: a task id, a file path, "user", a subsystem name. */
  source: string;
  provenance: Provenance;
  /** 0–1. Rises when the entry is reused successfully, falls when it misleads. */
  confidence: number;
  /** Permanent entries survive pruning. Personal ones need explicit approval. */
  permanent: boolean;
  approvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  uses: number;
  hits: number;
  misses: number;
  shape?: KnowledgeShape;
  subject?: string;
  predicate?: string;
  object?: string;
  freshnessAt?: number;
  contradiction?: boolean;
  contradictedBy?: string[];
  /** Memory id this belief was derived from — not a duplicated memory record. */
  derivedFromMemoryId?: string;
  /** Inclusive start of a temporal claim. Absent means no start bound. */
  validFrom?: number;
  /** Exclusive end of a temporal claim. Absent means still current. */
  validUntil?: number;
};

/** A task the Brain must still finish — survives a restart. */
export type BrainTask = {
  id: string;
  title: string;
  goal: string;
  stage: string;
  status: "pending" | "running" | "waiting-approval" | "done" | "failed";
  progress: number;
  /** Free-form checkpoint written by the runner so work resumes mid-flight. */
  checkpoint: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  error?: string;
};

/** A permanent-memory request waiting for the owner's yes or no. */
export type ConsentRequest = {
  id: string;
  entryId: string;
  title: string;
  body: string;
  reason: string;
  at: number;
};

export type BrainKnowledgeState = {
  entries: BrainEntry[];
  tasks: BrainTask[];
  consent: ConsentRequest[];
  updatedAt: number | null;
};

export type RememberInput = {
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags?: string[];
  source: string;
  provenance?: Provenance;
  confidence?: number;
  /** Ask the owner to keep this forever instead of storing it silently. */
  requestPermanent?: boolean;
  reason?: string;
  shape?: KnowledgeShape;
  subject?: string;
  predicate?: string;
  object?: string;
  freshnessAt?: number;
  derivedFromMemoryId?: string;
  validFrom?: number;
  validUntil?: number;
};

const STORAGE_KEY = "friday.brain.knowledge.v1";
const MAX_ENTRIES = 600;
const MAX_TASKS = 120;

let seq = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

const norm = (value: string) => value.trim().toLowerCase();
/** owned-by and owned_by are the same predicate. */
const predNorm = (value: string) => norm(value).replace(/[_]+/g, "-");

const empty = (): BrainKnowledgeState => ({
  entries: [],
  tasks: [],
  consent: [],
  updatedAt: null,
});

class BrainKnowledgeBase {
  private state: BrainKnowledgeState = empty();
  private snapshot: BrainKnowledgeState = empty();
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): BrainKnowledgeState => {
    this.load();
    return this.snapshot;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (typeof window === "undefined") return;
    const local = readLocalState<BrainKnowledgeState>(STORAGE_KEY);
    if (local?.entries) this.state = this.settle(local);
    restoreFromDisk<BrainKnowledgeState>(STORAGE_KEY, (disk) => {
      if (!disk?.entries?.length && !disk?.tasks?.length) return;
      // The desktop copy is the durable one: it wins over a stale browser cache.
      this.state = this.settle(disk);
      this.emit(false);
    });
    this.emit(false);
  }

  /** A task that was mid-flight when FRIDAY stopped goes back to pending. */
  private settle(state: BrainKnowledgeState): BrainKnowledgeState {
    return {
      entries: (state.entries ?? []).slice(0, MAX_ENTRIES),
      consent: state.consent ?? [],
      updatedAt: state.updatedAt ?? null,
      tasks: (state.tasks ?? []).map((task) =>
        task.status === "running"
          ? { ...task, status: "pending", stage: task.stage || "resume", updatedAt: Date.now() }
          : task,
      ),
    };
  }

  private emit(persist = true) {
    this.state.updatedAt = Date.now();
    this.snapshot = {
      entries: [...this.state.entries],
      tasks: [...this.state.tasks],
      consent: [...this.state.consent],
      updatedAt: this.state.updatedAt,
    };
    this.listeners.forEach((fn) => fn());
    if (!persist || typeof window === "undefined") return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeState(STORAGE_KEY, {
        ...this.state,
        entries: this.state.entries.slice(0, MAX_ENTRIES),
        tasks: this.state.tasks.slice(0, MAX_TASKS),
      });
    }, 500);
  }

  /* ------------------------------------------------------------ knowledge */

  /**
   * Stores or reinforces one piece of knowledge.
   *
   * Personal information is never made permanent here: it is written as a
   * normal entry and a consent request is queued for the owner.
   */
  remember(input: RememberInput): BrainEntry {
    this.load();
    const now = Date.now();
    const exactSpo =
      input.subject && input.predicate
        ? this.state.entries.find(
            (entry) =>
              norm(entry.subject ?? "") === norm(input.subject ?? "") &&
              predNorm(entry.predicate ?? "") === predNorm(input.predicate ?? "") &&
              norm(entry.object ?? "") === norm(input.object ?? ""),
          )
        : undefined;
    const existing =
      exactSpo ??
      this.state.entries.find(
        (entry) =>
          entry.kind === input.kind && norm(entry.title) === norm(input.title) && !entry.subject,
      );

    if (existing) {
      existing.body = input.body || existing.body;
      existing.tags = Array.from(new Set([...existing.tags, ...(input.tags ?? [])]));
      existing.updatedAt = now;
      existing.freshnessAt = now;
      existing.uses += 1;
      existing.confidence = Math.min(
        0.99,
        Math.max(existing.confidence, input.confidence ?? existing.confidence) + 0.03,
      );
      if (input.provenance === "user") existing.provenance = "user";
      if (input.validFrom !== undefined) existing.validFrom = input.validFrom;
      if (input.validUntil !== undefined) existing.validUntil = input.validUntil;
      if (input.requestPermanent && !existing.permanent)
        this.requestConsent(existing, input.reason);
      this.emit();
      return existing;
    }

    const spoRival =
      input.subject && input.predicate
        ? this.state.entries.find(
            (entry) =>
              norm(entry.subject ?? "") === norm(input.subject ?? "") &&
              predNorm(entry.predicate ?? "") === predNorm(input.predicate ?? "") &&
              norm(entry.object ?? entry.body) !== norm(input.object ?? input.body),
          )
        : undefined;
    if (spoRival) {
      return this.flagContradiction(spoRival, input, now);
    }

    const entry: BrainEntry = {
      id: nextId("kn"),
      kind: input.kind,
      title: input.title.slice(0, 120),
      body: input.body,
      tags: input.tags ?? [],
      source: input.source,
      provenance: input.provenance ?? "observed",
      confidence: input.confidence ?? (input.provenance === "user" ? 1 : 0.5),
      // Only a user-stated, non-personal rule may be permanent immediately.
      permanent:
        input.provenance === "user" && input.kind !== "personal" && !input.requestPermanent,
      approvedAt: input.provenance === "user" && input.kind !== "personal" ? now : null,
      createdAt: now,
      updatedAt: now,
      uses: 0,
      hits: 0,
      misses: 0,
      freshnessAt: input.freshnessAt ?? now,
      contradiction: false,
    };
    if (input.shape) entry.shape = input.shape;
    if (input.subject) entry.subject = input.subject;
    if (input.predicate) entry.predicate = input.predicate;
    if (input.object) entry.object = input.object;
    if (input.derivedFromMemoryId) entry.derivedFromMemoryId = input.derivedFromMemoryId;
    if (input.validFrom !== undefined) entry.validFrom = input.validFrom;
    if (input.validUntil !== undefined) entry.validUntil = input.validUntil;
    this.state.entries = [entry, ...this.state.entries].slice(0, MAX_ENTRIES);
    if (input.requestPermanent || input.kind === "personal") {
      this.requestConsent(entry, input.reason);
    }
    this.emit();
    return entry;
  }

  private requestConsent(entry: BrainEntry, reason?: string) {
    if (entry.permanent) return;
    if (this.state.consent.some((request) => request.entryId === entry.id)) return;
    this.state.consent = [
      {
        id: nextId("consent"),
        entryId: entry.id,
        title: entry.title,
        body: entry.body,
        reason: reason ?? "FRIDAY wants to remember this permanently.",
        at: Date.now(),
      },
      ...this.state.consent,
    ];
  }

  /** The owner answering a permanent-memory request. */
  decideConsent(requestId: string, approve: boolean): boolean {
    this.load();
    const request = this.state.consent.find((item) => item.id === requestId);
    if (!request) return false;
    this.state.consent = this.state.consent.filter((item) => item.id !== requestId);
    const entry = this.state.entries.find((item) => item.id === request.entryId);
    if (entry) {
      if (approve) {
        entry.permanent = true;
        entry.approvedAt = Date.now();
        entry.provenance = "user";
        entry.confidence = 1;
      } else {
        // Refused: FRIDAY forgets it rather than keeping it quietly.
        this.state.entries = this.state.entries.filter((item) => item.id !== entry.id);
      }
    }
    this.emit();
    return true;
  }

  /** Withdraw a previously approved permanent memory. */
  forget(entryId: string): boolean {
    this.load();
    const before = this.state.entries.length;
    this.state.entries = this.state.entries.filter((entry) => entry.id !== entryId);
    this.state.consent = this.state.consent.filter((item) => item.entryId !== entryId);
    if (this.state.entries.length === before) return false;
    this.emit();
    return true;
  }

  /** Best matching knowledge for a prompt, highest value first. */
  recall(
    query: string,
    options: { kinds?: KnowledgeKind[]; k?: number; vectorHits?: VectorSnippet[] } = {},
  ): BrainEntry[] {
    this.load();
    const kinds = options.kinds;
    const pool = this.state.entries.filter((entry) => !kinds || kinds.includes(entry.kind));
    const preferred = preferredBeliefIds(pool);
    return rankByRetrieval(
      pool,
      query,
      (entry) => knowledgeSignals(entry, preferred.has(entry.id)),
      {
        k: options.k ?? 6,
        minScore: 0.2,
        taskHint: query,
        ...(options.vectorHits?.length ? { vectorHits: options.vectorHits } : {}),
      },
    ).map((row) => row.item);
  }

  /**
   * KNOWN / UNKNOWN / STALE / CONTRADICTED / UNCERTAIN for a query against
   * this store — not a second freshness engine.
   */
  queryStatus(
    query: string,
    now = Date.now(),
  ): {
    status: KnowledgeStatus;
    entry: BrainEntry | null;
    reason: string;
  } {
    const hits = this.recall(query, { k: 1 });
    const entry = hits[0] ?? null;
    if (!entry) {
      return { status: "unknown", entry: null, reason: "no matching knowledge" };
    }
    const status = knowledgeStatus(entry, now);
    return { status, entry, reason: `${entry.title}: ${status}` };
  }

  /** Readable relation walk, e.g. FRIDAY → owned-by → Owner. */
  relationPath(start: string, predicates: string[]): string {
    const hops = this.walk(start, predicates);
    if (!hops.length) return `${start} (no path)`;
    const bits = [start];
    for (const hop of hops) {
      bits.push(String(hop.predicate ?? ""), String(hop.object ?? ""));
    }
    return bits.join(" → ");
  }

  /** Lower unused non-permanent confidence; drop the weakest. */
  decayUnused(now = Date.now()): number {
    this.load();
    const twoWeeks = 14 * 86_400_000;
    let dropped = 0;
    const kept: BrainEntry[] = [];
    for (const entry of this.state.entries) {
      if (entry.permanent || entry.provenance === "user") {
        kept.push(entry);
        continue;
      }
      const age = now - (entry.freshnessAt ?? entry.updatedAt);
      if (age > twoWeeks && entry.uses === 0 && entry.hits === 0) {
        entry.confidence = Math.max(0.05, entry.confidence * 0.85);
      }
      if (!entry.permanent && entry.confidence <= 0.08 && entry.misses >= 2) {
        dropped += 1;
        continue;
      }
      kept.push(entry);
    }
    if (dropped) {
      this.state.entries = kept;
      this.emit();
    }
    return dropped;
  }

  /** Feedback after knowledge was actually used, so the Brain stays honest. */
  reinforce(entryId: string, helped: boolean): void {
    this.load();
    const entry = this.state.entries.find((item) => item.id === entryId);
    if (!entry) return;
    if (helped) {
      entry.hits += 1;
      entry.confidence = Math.min(0.99, entry.confidence + 0.05);
    } else {
      entry.misses += 1;
      entry.confidence = Math.max(0.05, entry.confidence - 0.1);
    }
    entry.updatedAt = Date.now();
    // Repeatedly unhelpful, unapproved knowledge is dropped instead of reused.
    if (!entry.permanent && entry.confidence <= 0.1 && entry.misses >= 3) {
      this.state.entries = this.state.entries.filter((item) => item.id !== entry.id);
    }
    this.emit();
  }

  /* ---------------------------------------------------------------- tasks */

  /** Register work that must finish even if FRIDAY restarts first. */
  openTask(input: { title: string; goal: string; stage?: string; id?: string }): BrainTask {
    this.load();
    const now = Date.now();
    const existing = input.id
      ? this.state.tasks.find((task) => task.id === input.id)
      : this.state.tasks.find(
          (task) => norm(task.goal) === norm(input.goal) && task.status !== "done",
        );
    if (existing) return existing;
    const task: BrainTask = {
      id: input.id ?? nextId("btask"),
      title: input.title,
      goal: input.goal,
      stage: input.stage ?? "understand",
      status: "pending",
      progress: 0,
      checkpoint: {},
      createdAt: now,
      updatedAt: now,
    };
    this.state.tasks = [task, ...this.state.tasks].slice(0, MAX_TASKS);
    this.emit();
    return task;
  }

  updateTask(id: string, patch: Partial<Omit<BrainTask, "id" | "createdAt">>): BrainTask | null {
    this.load();
    const task = this.state.tasks.find((item) => item.id === id);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.emit();
    return task;
  }

  /** Everything that still has work left — what to resume after a restart. */
  unfinishedTasks(): BrainTask[] {
    this.load();
    return this.state.tasks.filter(
      (task) => task.status === "pending" || task.status === "waiting-approval",
    );
  }

  tasks(): BrainTask[] {
    return this.getSnapshot().tasks;
  }

  entries(kind?: KnowledgeKind): BrainEntry[] {
    const all = this.getSnapshot().entries;
    return kind ? all.filter((entry) => entry.kind === kind) : all;
  }

  /** Outgoing relation edges from one entity. Same store — not a second graph. */
  related(entity: string, predicate?: string): BrainEntry[] {
    this.load();
    const who = norm(entity);
    const pred = predicate ? predNorm(predicate) : "";
    return this.state.entries.filter(
      (entry) =>
        Boolean(entry.subject) &&
        Boolean(entry.predicate) &&
        Boolean(entry.object) &&
        norm(entry.subject ?? "") === who &&
        (!pred || predNorm(entry.predicate ?? "") === pred),
    );
  }

  /** Incoming edges (who points at this entity). */
  pointedAt(entity: string, predicate?: string): BrainEntry[] {
    this.load();
    const who = norm(entity);
    const pred = predicate ? predNorm(predicate) : "";
    return this.state.entries.filter(
      (entry) =>
        Boolean(entry.subject) &&
        Boolean(entry.predicate) &&
        Boolean(entry.object) &&
        norm(entry.object ?? "") === who &&
        (!pred || predNorm(entry.predicate ?? "") === pred),
    );
  }

  /**
   * Follow a predicate chain. Stops honestly when a hop is missing or only
   * contradicted beliefs remain — never guesses the next node.
   */
  walk(start: string, predicates: string[]): BrainEntry[] {
    this.load();
    const hops: BrainEntry[] = [];
    let cursor = start;
    for (const predicate of predicates) {
      const candidates = this.related(cursor, predicate).filter((entry) => !entry.contradiction);
      const next = [...candidates].sort((a, b) => b.confidence - a.confidence)[0];
      if (!next?.object) return hops;
      hops.push(next);
      cursor = next.object;
    }
    return hops;
  }

  /** Components/projects that declare a depends-on edge to this entity. */
  dependents(entity: string): BrainEntry[] {
    return this.pointedAt(entity, "depends-on");
  }

  pendingConsent(): ConsentRequest[] {
    return this.getSnapshot().consent;
  }

  /** Counts for diagnostics and the existing Brain panel. */
  stats() {
    const snapshot = this.getSnapshot();
    const byKind = snapshot.entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
      return acc;
    }, {});
    return {
      entries: snapshot.entries.length,
      permanent: snapshot.entries.filter((entry) => entry.permanent).length,
      awaitingConsent: snapshot.consent.length,
      unfinishedTasks: this.unfinishedTasks().length,
      byKind,
      updatedAt: snapshot.updatedAt,
    };
  }

  /**
   * Same subject+predicate, different object: keep both, flag contradiction,
   * never silently overwrite the stored belief.
   */
  private flagContradiction(rival: BrainEntry, input: RememberInput, now: number): BrainEntry {
    const incoming: BrainEntry = {
      id: nextId("kn"),
      kind: input.kind,
      title: input.title.slice(0, 120),
      body: input.body,
      tags: input.tags ?? [],
      source: input.source,
      provenance: input.provenance ?? "observed",
      confidence: input.confidence ?? 0.5,
      permanent: false,
      approvedAt: null,
      createdAt: now,
      updatedAt: now,
      uses: 0,
      hits: 0,
      misses: 0,
      freshnessAt: now,
      contradiction: true,
      contradictedBy: [rival.id],
    };
    if (input.shape) incoming.shape = input.shape;
    if (input.subject) incoming.subject = input.subject;
    if (input.predicate) incoming.predicate = input.predicate;
    if (input.object) incoming.object = input.object;
    if (input.validFrom !== undefined) incoming.validFrom = input.validFrom;
    if (input.validUntil !== undefined) incoming.validUntil = input.validUntil;
    rival.contradiction = true;
    rival.contradictedBy = [...(rival.contradictedBy ?? []), incoming.id];
    this.state.entries = [incoming, ...this.state.entries].slice(0, MAX_ENTRIES);
    const judgment = compareBeliefs(
      {
        source: rival.source,
        provenance: rival.provenance,
        confidence: rival.confidence,
        updatedAt: rival.updatedAt,
        verified: rival.provenance === "verified" || rival.provenance === "user",
        ...(rival.freshnessAt !== undefined ? { freshnessAt: rival.freshnessAt } : {}),
      },
      {
        source: incoming.source,
        provenance: incoming.provenance,
        confidence: incoming.confidence,
        updatedAt: incoming.updatedAt,
        verified: incoming.provenance === "verified" || incoming.provenance === "user",
        ...(incoming.freshnessAt !== undefined ? { freshnessAt: incoming.freshnessAt } : {}),
      },
    );
    if (!judgment.sufficient) {
      this.requestConsent(
        incoming,
        `Conflicting belief about “${incoming.title}”. Stored: ${rival.object ?? rival.body}. New: ${incoming.object ?? incoming.body}. ${judgment.reason}`,
      );
      try {
        notifications.push({
          id: `knowledge-conflict:${[rival.id, incoming.id].sort().join(":")}`,
          level: "action",
          title: "Conflicting knowledge — waiting for you",
          detail: `${incoming.title}: “${rival.object ?? rival.body}” vs “${incoming.object ?? incoming.body}”. ${judgment.reason}`,
          source: "Knowledge",
        });
      } catch {
        /* notification centre is optional */
      }
    }
    this.emit();
    return incoming;
  }

  /** Provenance line: source, when, reliability, newer evidence, contradiction. */
  evidenceLine(entry: BrainEntry): string {
    this.load();
    const peers = this.state.entries.filter(
      (other) =>
        other.id !== entry.id &&
        ((entry.contradictedBy ?? []).includes(other.id) ||
          (other.contradictedBy ?? []).includes(entry.id) ||
          (Boolean(entry.subject) &&
            other.subject === entry.subject &&
            other.predicate === entry.predicate)),
    );
    const preferred = preferredBeliefIds([entry, ...peers]);
    return formatEvidenceLine(
      describeEvidence(
        knowledgeSignals(entry, preferred.has(entry.id)),
        peers.map((peer) => knowledgeSignals(peer, preferred.has(peer.id))),
      ),
    );
  }

  /** Structured fact / entity / relation on this store — not a second graph. */
  assertBelief(input: {
    subject: string;
    predicate: string;
    object: string;
    source: string;
    provenance?: Provenance;
    confidence?: number;
    shape?: KnowledgeShape;
    derivedFromMemoryId?: string;
    validFrom?: number;
    validUntil?: number;
  }): BrainEntry {
    return this.remember({
      kind: "knowledge",
      title: `${input.subject} ${input.predicate}`.slice(0, 120),
      body: `${input.subject} ${input.predicate} ${input.object}`,
      source: input.source,
      provenance: input.provenance ?? "observed",
      confidence: input.confidence ?? 0.7,
      shape: input.shape ?? "fact",
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      ...(input.derivedFromMemoryId ? { derivedFromMemoryId: input.derivedFromMemoryId } : {}),
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
    });
  }

  /** Test/reset hook. Never called from the UI. */
  resetForTests(): void {
    this.loaded = true;
    this.state = empty();
    this.emit(false);
  }
}

export const brainKnowledge = new BrainKnowledgeBase();

/** A claim with no window is current. A future start or a passed end is not. */
export function claimActive(
  entry: { validFrom?: number; validUntil?: number },
  now: number,
): boolean {
  if (entry.validFrom !== undefined && now < entry.validFrom) return false;
  if (entry.validUntil !== undefined && now >= entry.validUntil) return false;
  return true;
}

export function knowledgeStatus(entry: BrainEntry, now = Date.now()): KnowledgeStatus {
  if (entry.contradiction) return "contradicted";
  const age = now - (entry.freshnessAt ?? entry.updatedAt);
  if (age > KNOWLEDGE_STALE_MS) return "stale";
  if (entry.confidence < 0.45) return "uncertain";
  if (entry.provenance === "user" || entry.provenance === "verified" || entry.confidence >= 0.7) {
    return "known";
  }
  return "uncertain";
}

/**
 * Knowledge ("what FRIDAY currently believes") may be derived from
 * consolidated Memory ("what happened") but is a different record in this store.
 */
export function deriveKnowledgeFromMemory(item: {
  id: string;
  title: string;
  text: string;
  kind?: string;
  confidence: number;
  verified?: boolean;
  freshnessAt?: number;
  updatedAt: number;
  tier: string;
}): BrainEntry | null {
  if (item.tier === "archived") return null;
  if (!item.verified && item.confidence < 0.7) return null;
  const kind: KnowledgeKind = item.kind === "preference" ? "preference" : "knowledge";
  return brainKnowledge.remember({
    kind,
    title: item.title,
    body: item.text,
    tags: ["derived-from-memory", item.kind ?? "episodic"],
    source: `memory/${item.id}`,
    provenance: item.verified ? "verified" : "observed",
    confidence: item.confidence,
    shape: item.kind === "preference" ? "fact" : "note",
    derivedFromMemoryId: item.id,
    freshnessAt: item.freshnessAt ?? item.updatedAt,
  });
}

function knowledgeSignals(entry: BrainEntry, preferred: boolean): RankSignals {
  const signals: RankSignals = {
    id: entry.id,
    title: entry.title,
    text: `${entry.body} ${entry.subject ?? ""} ${entry.object ?? ""}`,
    tags: entry.tags,
    source: entry.source,
    provenance: entry.provenance,
    confidence: entry.confidence,
    updatedAt: entry.updatedAt,
    permanent: entry.permanent,
    verified: entry.provenance === "verified" || entry.provenance === "user",
    uses: entry.uses,
    hits: entry.hits,
    preferred,
  };
  if (entry.subject && entry.object) signals.relatedBoost = 0.08;
  if (entry.freshnessAt !== undefined) signals.freshnessAt = entry.freshnessAt;
  if (entry.contradiction !== undefined) signals.contradiction = entry.contradiction;
  return signals;
}

function toRef(entry: BrainEntry) {
  return {
    source: entry.source,
    provenance: entry.provenance,
    confidence: entry.confidence,
    updatedAt: entry.updatedAt,
    verified: entry.provenance === "verified" || entry.provenance === "user",
    ...(entry.freshnessAt !== undefined ? { freshnessAt: entry.freshnessAt } : {}),
  };
}

/** Current belief among rivals, or null when the conflict is still ambiguous. */
export function currentBeliefAmong(entries: BrainEntry[]): BrainEntry | null {
  if (entries.length === 1) return entries[0] ?? null;
  if (entries.length < 2) return null;
  const ranked = [...entries].sort((left, right) => {
    const leftAt = left.freshnessAt ?? left.updatedAt;
    const rightAt = right.freshnessAt ?? right.updatedAt;
    return right.confidence - left.confidence || rightAt - leftAt;
  });
  const top = ranked[0]!;
  const runner = ranked[1]!;
  const judgment = compareBeliefs(toRef(runner), toRef(top));
  if (!judgment.sufficient) return null;
  return judgment.winner === "incoming" ? top : runner;
}

function preferredBeliefIds(pool: BrainEntry[]): Set<string> {
  const groups = new Map<string, BrainEntry[]>();
  for (const entry of pool) {
    if (!entry.subject || !entry.predicate) continue;
    const key = `${norm(entry.subject)}::${predNorm(entry.predicate)}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  const ids = new Set<string>();
  for (const group of groups.values()) {
    if (!group.some((entry) => entry.contradiction) && group.length < 2) continue;
    const current = currentBeliefAmong(group);
    if (current) ids.add(current.id);
  }
  return ids;
}
