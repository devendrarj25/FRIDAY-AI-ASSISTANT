/**
 * FRIDAY · speech arbiter: who gets to speak next.
 *
 * Replaces a plain first-in first-out list of lines to say. With every line at the same priority it behaves
 * exactly like that list (a property test pins it), so it can sit where the list sits. On top of that:
 *   - priorities: approval > direct > progress > chatter. A higher one is served first, equals keep their order;
 *   - a clause that is playing is never cut: nothing is handed out until `finish` is called for it, so an approval
 *     that arrives mid-clause is the very next thing said, at the clause boundary;
 *   - progress lines coalesce per key (newest text wins, the old slot is kept) and expire after 30 s;
 *   - chatter is dropped whenever anything else is queued;
 *   - a done line lives 10 minutes; after that it becomes a digest (`takeDigest`) instead of a late announcement;
 *   - the queue is bounded; every drop is counted by reason;
 *   - nothing is released while the owner is speaking, and for 600 ms after he stops;
 *   - `flush` drops chosen priorities on a barge-in and never touches the clause in play.
 * Pure state and an injected clock: no timer, no audio, no store. The conductor polls `next()`; `waitMs()` says how
 * long to wait before asking again.
 */

export type SpeechPriority = "approval" | "direct" | "progress" | "chatter";

export type SpeechRequest = {
  text: string;
  priority: SpeechPriority;
  taskId?: string | undefined;
  /** Milliseconds a queued line stays worth saying. A default per priority applies when absent. */
  ttlMs?: number | undefined;
  /** A queued line with the same key is replaced by this one. */
  coalesceKey?: string | undefined;
  /** The line is about private content; the digest counts it without ever carrying its words. */
  sensitive?: boolean | undefined;
  /** A task's finish line: it lives ten minutes and then becomes part of a digest. */
  done?: boolean | undefined;
  /** Say it quietly (whisper mode). Carried through for the voice. */
  whisper?: boolean | undefined;
};

export type SpeechItem = {
  id: string;
  text: string;
  priority: SpeechPriority;
  taskId?: string;
  ttlMs: number;
  coalesceKey?: string;
  sensitive: boolean;
  done: boolean;
  whisper: boolean;
  enqueuedAt: number;
};

export type DropReason = "overflow" | "expired" | "coalesced" | "chatter" | "flushed";

export type SpeechStats = {
  dropped: Record<DropReason, number>;
  spoken: number;
  digested: number;
  queued: number;
};

export type SpeechDigest = { count: number; sensitive: number; taskIds: string[] };

export type ArbiterOptions = {
  now: () => number;
  maxQueue?: number;
  quietGraceMs?: number;
  progressTtlMs?: number;
  doneTtlMs?: number;
};

export const QUIET_GRACE_MS = 600;
export const PROGRESS_TTL_MS = 30_000;
export const DONE_TTL_MS = 600_000;
export const MAX_QUEUE = 16;

const RANK: Record<SpeechPriority, number> = { approval: 0, direct: 1, progress: 2, chatter: 3 };

type Entry = { item: SpeechItem; seq: number };

export class SpeechArbiter {
  private queue: Entry[] = [];
  private current: SpeechItem | null = null;
  private seq = 0;
  private ids = 0;
  private ownerSpeaking = false;
  private quietSince = Number.NEGATIVE_INFINITY;
  private spoken = 0;
  private digested = 0;
  private digest: SpeechDigest = { count: 0, sensitive: 0, taskIds: [] };
  private dropped: Record<DropReason, number> = {
    overflow: 0,
    expired: 0,
    coalesced: 0,
    chatter: 0,
    flushed: 0,
  };
  private readonly maxQueue: number;
  private readonly graceMs: number;
  private readonly progressTtl: number;
  private readonly doneTtl: number;

  constructor(private readonly options: ArbiterOptions) {
    this.maxQueue = Math.max(1, options.maxQueue ?? MAX_QUEUE);
    this.graceMs = options.quietGraceMs ?? QUIET_GRACE_MS;
    this.progressTtl = options.progressTtlMs ?? PROGRESS_TTL_MS;
    this.doneTtl = options.doneTtlMs ?? DONE_TTL_MS;
  }

  private defaultTtl(request: SpeechRequest): number {
    if (request.done) return this.doneTtl;
    if (request.priority === "progress") return this.progressTtl;
    if (request.priority === "chatter") return 10_000;
    return 120_000;
  }

  /** Queue a line. `accepted` is false when it was refused (empty, chatter beside real speech, or no room). */
  enqueue(request: SpeechRequest): { id: string; accepted: boolean } {
    const text = request.text;
    if (!text || !text.trim()) return { id: "", accepted: false };
    this.purge();
    const priority = request.priority;
    if (priority === "chatter") {
      if (this.queue.some((e) => e.item.priority !== "chatter")) {
        this.dropped.chatter += 1;
        return { id: "", accepted: false };
      }
    } else if (this.queue.some((e) => e.item.priority === "chatter")) {
      const kept = this.queue.filter((e) => e.item.priority !== "chatter");
      this.dropped.chatter += this.queue.length - kept.length;
      this.queue = kept;
    }
    this.ids += 1;
    const item: SpeechItem = {
      id: `speech-${this.ids}`,
      text,
      priority,
      ttlMs: request.ttlMs ?? this.defaultTtl(request),
      sensitive: Boolean(request.sensitive),
      done: Boolean(request.done),
      whisper: Boolean(request.whisper),
      enqueuedAt: this.options.now(),
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.coalesceKey ? { coalesceKey: request.coalesceKey } : {}),
    };
    if (item.coalesceKey) {
      const at = this.queue.findIndex((e) => e.item.coalesceKey === item.coalesceKey);
      const old = at >= 0 ? this.queue[at] : undefined;
      if (old) {
        this.queue[at] = { item, seq: old.seq };
        this.dropped.coalesced += 1;
        return { id: item.id, accepted: true };
      }
    }
    if (this.queue.length >= this.maxQueue && !this.makeRoom(item))
      return { id: "", accepted: false };
    this.seq += 1;
    this.queue.push({ item, seq: this.seq });
    return { id: item.id, accepted: true };
  }

  /** Drop the lowest-priority, oldest line to fit `incoming`; false when `incoming` itself is the one to drop. */
  private makeRoom(incoming: SpeechItem): boolean {
    let worst = -1;
    for (let i = 0; i < this.queue.length; i += 1) {
      const entry = this.queue[i];
      const best = worst >= 0 ? this.queue[worst] : undefined;
      if (!entry) continue;
      if (
        !best ||
        RANK[entry.item.priority] > RANK[best.item.priority] ||
        (RANK[entry.item.priority] === RANK[best.item.priority] && entry.seq < best.seq)
      )
        worst = i;
    }
    const victim = worst >= 0 ? this.queue[worst] : undefined;
    if (!victim || RANK[incoming.priority] > RANK[victim.item.priority]) {
      this.retire(incoming, "overflow");
      return false;
    }
    this.queue.splice(worst, 1);
    this.retire(victim.item, "overflow");
    return true;
  }

  /** A line leaves the queue unsaid. A finish line is kept for the digest instead of being lost. */
  private retire(item: SpeechItem, reason: DropReason): void {
    if (item.done && (reason === "expired" || reason === "overflow" || reason === "flushed")) {
      this.digest.count += 1;
      if (item.sensitive) this.digest.sensitive += 1;
      if (item.taskId) this.digest.taskIds.push(item.taskId);
      this.digested += 1;
      return;
    }
    this.dropped[reason] += 1;
  }

  private purge(): void {
    const now = this.options.now();
    if (!this.queue.some((e) => now - e.item.enqueuedAt > e.item.ttlMs)) return;
    const kept: Entry[] = [];
    for (const entry of this.queue) {
      if (now - entry.item.enqueuedAt > entry.item.ttlMs) this.retire(entry.item, "expired");
      else kept.push(entry);
    }
    this.queue = kept;
  }

  /** The conductor tells the arbiter when the owner starts and stops speaking (the LISTENING state). */
  setOwnerSpeaking(speaking: boolean): void {
    if (this.ownerSpeaking && !speaking) this.quietSince = this.options.now();
    this.ownerSpeaking = speaking;
  }

  /** Milliseconds until a line may be released: 0 now, `Infinity` while the owner is speaking. */
  waitMs(): number {
    if (this.ownerSpeaking) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.quietSince + this.graceMs - this.options.now());
  }

  /** The next line to say, or null: nothing queued, a clause still playing, or the owner is talking. */
  next(options: { ownerSpeaking?: boolean } = {}): SpeechItem | null {
    if (options.ownerSpeaking !== undefined) this.setOwnerSpeaking(options.ownerSpeaking);
    this.purge();
    if (
      this.queue.some((e) => e.item.priority !== "chatter") &&
      this.queue.some((e) => e.item.priority === "chatter")
    ) {
      const kept = this.queue.filter((e) => e.item.priority !== "chatter");
      this.dropped.chatter += this.queue.length - kept.length;
      this.queue = kept;
    }
    if (this.current || !this.queue.length || this.waitMs() > 0) return null;
    let best = 0;
    for (let i = 1; i < this.queue.length; i += 1) {
      const entry = this.queue[i];
      const top = this.queue[best];
      if (!entry || !top) continue;
      const a = RANK[entry.item.priority];
      const b = RANK[top.item.priority];
      if (a < b || (a === b && entry.seq < top.seq)) best = i;
    }
    const [picked] = this.queue.splice(best, 1);
    if (!picked) return null;
    this.current = picked.item;
    return picked.item;
  }

  /** The line being said now, if any. */
  playing(): SpeechItem | null {
    return this.current;
  }

  /** The clause `id` finished (or was stopped). A call for another id changes nothing. */
  finish(id: string): void {
    if (!this.current || this.current.id !== id) return;
    this.current = null;
    this.spoken += 1;
  }

  /** Drop every queued line of these priorities. The clause in play is untouched. Returns how many went. */
  flush(priorities: readonly SpeechPriority[]): number {
    if (!priorities.length) return 0;
    const kept: Entry[] = [];
    let gone = 0;
    for (const entry of this.queue) {
      if (priorities.includes(entry.item.priority)) {
        this.retire(entry.item, "flushed");
        gone += 1;
      } else kept.push(entry);
    }
    this.queue = kept;
    return gone;
  }

  /** The owner spoke over her: progress and chatter go, approvals and direct answers stay. */
  bargeIn(): number {
    return this.flush(["progress", "chatter"]);
  }

  /** Empty the queue (not the clause in play). */
  clear(): void {
    this.queue = [];
  }

  size(): number {
    this.purge();
    return this.queue.length;
  }

  /** The waiting lines in the order they will be served (a copy; nothing is taken). */
  peek(): SpeechItem[] {
    this.purge();
    return [...this.queue]
      .sort((a, b) => RANK[a.item.priority] - RANK[b.item.priority] || a.seq - b.seq)
      .map((e) => e.item);
  }

  /** The finish lines that aged out unsaid, once. */
  takeDigest(): SpeechDigest | null {
    this.purge();
    if (!this.digest.count) return null;
    const out = this.digest;
    this.digest = { count: 0, sensitive: 0, taskIds: [] };
    return out;
  }

  stats(): SpeechStats {
    return {
      dropped: { ...this.dropped },
      spoken: this.spoken,
      digested: this.digested,
      queued: this.queue.length,
    };
  }
}
