/**
 * FRIDAY · vector index client
 *
 * A real client for the Python kernel's vector memory (`memory.*` methods over
 * the local bridge). Nothing here invents results: outside the desktop app, or
 * while the kernel is starting, the store reports `unavailable` and the UI says
 * so instead of showing placeholder documents.
 *
 * It also keeps FRIDAY's local six-tier memory in sync with the durable vector
 * index, so what she learns during a session survives and stays searchable —
 * only records that have not been pushed yet are sent (no duplicates).
 */

import { KernelBridge, isDesktop } from "../bridge";
import { readLocalState, writeState } from "../persist";
import { memory, type MemoryItem } from "../self/memory-engine";
import { expandQuery } from "./retrieval";

export type VectorHit = {
  kind: string;
  title: string;
  snippet: string;
  score: number;
  /** Canonical memory/knowledge id when the kernel stored one. */
  id?: string;
};

export type VectorIndexState = {
  /** "chroma" | "numpy" | "none" | null while unknown. */
  backend: string | null;
  available: boolean;
  connected: boolean;
  /** Honest reason when the index cannot be reached. */
  reason: string | null;
  checkedAt: number | null;
  busy: boolean;
  query: string;
  results: VectorHit[];
  searchedAt: number | null;
  /** Local memory records already pushed into the durable index. */
  synced: number;
  lastSyncAt: number | null;
  autoSync: boolean;
  log: { id: string; at: number; line: string; level: "info" | "ok" | "warn" | "error" }[];
};

const SYNC_KEY = "friday.vector.sync.v1";
const STATUS_MS = 30_000;
const SYNC_MS = 5 * 60_000;
const MAX_LOG = 40;

type SyncState = { ids: string[]; lastSyncAt: number | null; autoSync: boolean };

let seq = 0;
const nextId = () => `vec-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

const empty = (): VectorIndexState => ({
  backend: null,
  available: false,
  connected: false,
  reason: null,
  checkedAt: null,
  busy: false,
  query: "",
  results: [],
  searchedAt: null,
  synced: 0,
  lastSyncAt: null,
  autoSync: true,
  log: [],
});

class VectorIndex {
  private state: VectorIndexState = empty();
  private snapshot: VectorIndexState = empty();
  private listeners = new Set<() => void>();
  private bridge: KernelBridge | null = null;
  private connecting: Promise<KernelBridge | null> | null = null;
  private pushed = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private started = false;

  subscribe = (fn: () => void) => {
    this.start();
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): VectorIndexState => this.snapshot;

  /** Idempotent: safe to call from every mounted panel. */
  start(): void {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    const saved = readLocalState<SyncState>(SYNC_KEY);
    if (saved) {
      (saved.ids ?? []).forEach((id) => this.pushed.add(id));
      this.state.synced = this.pushed.size;
      this.state.lastSyncAt = saved.lastSyncAt ?? null;
      this.state.autoSync = saved.autoSync ?? true;
    }
    this.emit();
    void this.refresh();
    this.timers.push(setInterval(() => void this.refresh(), STATUS_MS));
    this.timers.push(
      setInterval(() => {
        if (this.state.autoSync) void this.syncLocalMemory();
      }, SYNC_MS),
    );
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.started = false;
  }

  private emit() {
    this.snapshot = { ...this.state, results: [...this.state.results], log: [...this.state.log] };
    this.listeners.forEach((fn) => fn());
  }

  private note(line: string, level: VectorIndexState["log"][number]["level"] = "info") {
    this.state.log = [{ id: nextId(), at: Date.now(), line, level }, ...this.state.log].slice(
      0,
      MAX_LOG,
    );
  }

  private persistSync() {
    writeState(SYNC_KEY, {
      ids: [...this.pushed].slice(-4000),
      lastSyncAt: this.state.lastSyncAt,
      autoSync: this.state.autoSync,
    } satisfies SyncState);
  }

  private async connect(): Promise<KernelBridge | null> {
    if (this.bridge) return this.bridge;
    if (!isDesktop()) {
      this.state.reason = "vector index runs in the FRIDAY desktop app";
      return null;
    }
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const bridge = new KernelBridge();
        await bridge.connect();
        this.bridge = bridge;
        this.state.connected = true;
        this.state.reason = null;
        return bridge;
      } catch (error) {
        this.bridge = null;
        this.state.connected = false;
        this.state.reason = error instanceof Error ? error.message : "kernel bridge unavailable";
        return null;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
    const bridge = await this.connect();
    if (!bridge) return null;
    try {
      return await bridge.call<T>(method, params);
    } catch (error) {
      // A dropped socket must not leave a dead client cached.
      this.bridge = null;
      this.state.connected = false;
      this.state.reason = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  /** Live backend status straight from the kernel. */
  async refresh(): Promise<void> {
    const status = await this.call<{ backend: string; available: boolean }>("memory.status");
    this.state.checkedAt = Date.now();
    if (!status) {
      this.state.available = false;
      this.state.backend = null;
    } else {
      this.state.backend = status.backend;
      this.state.available = Boolean(status.available);
      this.state.reason = status.available ? null : "kernel reports no vector backend";
    }
    this.emit();
  }

  async queryHits(query: string, k = 8): Promise<VectorHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const variants = expandQuery(trimmed);
    const first = await this.call<{ results: VectorHit[] }>("memory.search", {
      query: variants[0] ?? trimmed,
      k,
    });
    if (!first) return [];
    const hits = first.results ?? [];
    if (hits.length || variants.length < 2) return hits;
    const second = await this.call<{ results: VectorHit[] }>("memory.search", {
      query: variants[1]!,
      k,
    });
    return second?.results ?? [];
  }

  async search(query: string, k = 12): Promise<void> {
    const trimmed = query.trim();
    this.state.query = trimmed;
    if (!trimmed) {
      this.state.results = [];
      this.emit();
      return;
    }
    this.state.busy = true;
    this.emit();
    const hits = await this.queryHits(trimmed, k);
    this.state.busy = false;
    this.state.results = hits;
    this.state.searchedAt = Date.now();
    if (!this.state.available && !hits.length) {
      this.note(`search unavailable: ${this.state.reason ?? "kernel offline"}`, "warn");
    }
    this.emit();
  }

  async add(text: string, kind: string, title: string, id?: string): Promise<boolean> {
    const res = await this.call<{ ok: boolean }>("memory.add", {
      text,
      kind,
      title,
      ...(id ? { id } : {}),
    });
    if (res?.ok) {
      if (id) this.pushed.add(id);
      this.note(`indexed "${title}"`, "ok");
    } else this.note(`could not index "${title}"`, "warn");
    this.emit();
    return Boolean(res?.ok);
  }

  async indexPath(path: string): Promise<{ files: number; chunks: number } | null> {
    this.state.busy = true;
    this.note(`indexing ${path}…`);
    this.emit();
    const res = await this.call<{ ok: boolean; files: number; chunks: number; reason?: string }>(
      "memory.index",
      { path },
    );
    this.state.busy = false;
    if (res?.ok) {
      this.note(`indexed ${res.files} files · ${res.chunks} chunks`, "ok");
      this.emit();
      void this.refresh();
      return { files: res.files, chunks: res.chunks };
    }
    this.note(`index failed: ${res?.reason ?? this.state.reason ?? "kernel offline"}`, "error");
    this.emit();
    return null;
  }

  async reindex(): Promise<boolean> {
    this.state.busy = true;
    this.emit();
    const res = await this.call<{ ok: boolean; backend: string; records?: number }>(
      "memory.reindex",
    );
    this.state.busy = false;
    if (res?.ok) this.note(`reindexed ${res.records ?? "all"} records (${res.backend})`, "ok");
    else this.note("reindex unavailable", "warn");
    this.emit();
    await this.refresh();
    return Boolean(res?.ok);
  }

  setAutoSync(on: boolean): void {
    this.state.autoSync = on;
    this.persistSync();
    this.emit();
    if (on) void this.syncLocalMemory();
  }

  /** Push memories FRIDAY learned locally into the durable vector index. */
  async syncLocalMemory(): Promise<number> {
    const items = memory
      .getSnapshot()
      .items.filter((item: MemoryItem) => item.tier !== "working" && item.tier !== "archived")
      .filter((item) => !this.pushed.has(item.id));
    if (!items.length) {
      this.state.lastSyncAt = Date.now();
      this.persistSync();
      this.emit();
      return 0;
    }
    const bridge = await this.connect();
    if (!bridge) {
      this.note(`sync skipped: ${this.state.reason ?? "kernel offline"}`, "warn");
      this.emit();
      return 0;
    }
    let pushed = 0;
    for (const item of items.slice(0, 50)) {
      const ok = await this.call<{ ok: boolean }>("memory.add", {
        text: `${item.title}\n\n${item.text}`,
        kind: item.tier,
        title: item.title,
        id: item.id,
      });
      if (!ok?.ok) break;
      this.pushed.add(item.id);
      pushed += 1;
    }
    this.state.synced = this.pushed.size;
    this.state.lastSyncAt = Date.now();
    this.persistSync();
    if (pushed) this.note(`synced ${pushed} memories into the vector index`, "ok");
    this.emit();
    return pushed;
  }
}

export const vectorIndex = new VectorIndex();
