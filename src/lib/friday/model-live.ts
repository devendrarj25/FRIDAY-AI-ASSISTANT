/**
 * Live status of every model the router has touched: how much it has been used,
 * and whether it is ready, active, cooling down, quarantined or blocked.
 *
 * The main process owns the facts (usage ledger and provider health). This store
 * only mirrors them: it refreshes on the usage and health events, on the shared
 * poller while the page is open, and ticks once a second only while some model
 * is cooling down, so a countdown is right without an always-on timer.
 */
import { useSyncExternalStore } from "react";
import type { ModelLiveRow, ModelLiveStatus } from "./desktop";
import { livePoller } from "./live-poll";

export type LiveState =
  "Active" | "Ready" | "Cooling down" | "Rate limited" | "Quarantined" | "Recovering" | "Blocked";

export type LiveStateView = {
  state: LiveState;
  tone: "accent" | "primary" | "warning" | "destructive" | "muted";
  /** Plain words for the row: what happened and what happens next. */
  detail: string;
  retryInMs: number;
};

/** A model that answered this recently counts as active. */
export const ACTIVE_WINDOW_MS = 60_000;

const RATE_CATEGORIES = new Set(["rate_limited", "quota_exceeded", "daily_limit"]);

export function formatRetry(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
}

/** The one place that turns the router's raw health into the word on the page. */
export function modelLiveState(row: ModelLiveRow | undefined, now: number): LiveStateView {
  if (!row) return { state: "Ready", tone: "muted", detail: "not used yet", retryInMs: 0 };
  const retryInMs = Math.max(0, row.cooldownUntil - now);
  const why = row.lastError ? ` — ${row.lastError}` : "";
  const next = row.nextStep ? ` ${row.nextStep}` : "";
  if (row.quarantined && retryInMs > 0) {
    return {
      state: "Quarantined",
      tone: "destructive",
      detail: `${row.failures} failures in a row; paused, next try in ${formatRetry(retryInMs)}${why}${next}`,
      retryInMs,
    };
  }
  if (retryInMs > 0) {
    const rate = RATE_CATEGORIES.has(String(row.category || ""));
    return {
      state: rate ? "Rate limited" : "Cooling down",
      tone: "warning",
      detail: `${rate ? "limit reached" : "last request failed"}; retry in ${formatRetry(retryInMs)}${why}${next}`,
      retryInMs,
    };
  }
  if (row.lastOutcome === "blocked") {
    return {
      state: "Blocked",
      tone: "muted",
      detail: "a billing or privacy rule stopped the last request",
      retryInMs: 0,
    };
  }
  if (row.lastOutcome === "failed" && row.failures > 0) {
    return {
      state: "Recovering",
      tone: "warning",
      detail: `the cooldown is over; the next request is the test${why}`,
      retryInMs: 0,
    };
  }
  if (row.lastOutcome === "answered" && now - row.lastAt < ACTIVE_WINDOW_MS) {
    return { state: "Active", tone: "primary", detail: "answered a moment ago", retryInMs: 0 };
  }
  return {
    state: "Ready",
    tone: "accent",
    detail: row.requests ? `${row.answered} of ${row.requests} requests answered` : "not used yet",
    retryInMs: 0,
  };
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export type ModelLiveState = {
  loaded: boolean;
  at: number;
  /** Re-evaluated every second while something is cooling down. */
  now: number;
  byId: Record<string, ModelLiveRow>;
  totals: ModelLiveStatus["totals"];
  decisions: ModelLiveStatus["decisions"];
};

const empty: ModelLiveState = {
  loaded: false,
  at: 0,
  now: 0,
  byId: {},
  totals: { requests: 0, tokens: 0, todayTokens: 0 },
  decisions: [],
};

type Bridge = {
  modelLiveStatus?: () => Promise<ModelLiveStatus>;
  resetModelUsage?: (modelId?: string | null) => Promise<{ ok: boolean }>;
  onModelUsageChanged?: (cb: () => void) => () => void;
  onModelHealthChanged?: (cb: () => void) => () => void;
};

const bridge = (): Bridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: Bridge }).friday ?? null);

const BACKGROUND_MS = 30_000;

class ModelLiveStore {
  private state: ModelLiveState = empty;
  private listeners = new Set<() => void>();
  private wired = false;
  private offPoll: (() => void) | null = null;
  private offClock: (() => void) | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;

  getSnapshot = (): ModelLiveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.wire();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.unwire();
    };
  };

  private emit(next: Partial<ModelLiveState>) {
    this.state = { ...this.state, ...next };
    this.syncClock();
    this.listeners.forEach((l) => l());
  }

  private wire() {
    if (this.wired || typeof window === "undefined") return;
    this.wired = true;
    const api = bridge();
    const offUsage = api?.onModelUsageChanged?.(() => void this.refresh());
    const offHealth = api?.onModelHealthChanged?.(() => void this.refresh());
    this.offEvents = () => {
      offUsage?.();
      offHealth?.();
    };
    this.offPoll = livePoller().subscribe("models.live", () => this.refresh(), BACKGROUND_MS);
  }

  private offEvents: (() => void) | null = null;

  private unwire() {
    this.wired = false;
    this.offEvents?.();
    this.offEvents = null;
    this.offPoll?.();
    this.offPoll = null;
    this.offClock?.();
    this.offClock = null;
  }

  /** One-second clock, alive only while a cooldown is counting down. */
  private syncClock() {
    const cooling = Object.values(this.state.byId).some(
      (row) => row.cooldownUntil > this.state.now,
    );
    if (cooling && !this.offClock && this.wired) {
      this.offClock = livePoller().subscribe(
        "models.live.clock",
        () => this.emit({ now: Date.now() }),
        1000,
        undefined,
        false,
      );
    } else if (!cooling && this.offClock) {
      this.offClock();
      this.offClock = null;
    }
  }

  refresh = async (): Promise<void> => {
    const api = bridge();
    if (!api?.modelLiveStatus) return;
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        const live = await api.modelLiveStatus!();
        this.emit({
          loaded: true,
          at: live.at,
          now: Date.now(),
          byId: Object.fromEntries(live.models.map((row) => [row.modelId, row])),
          totals: live.totals,
          decisions: live.decisions,
        });
      } catch {
        /* the next event or poll tries again */
      } finally {
        this.inFlight = null;
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      }
    })();
    return this.inFlight;
  };

  async reset(modelId?: string) {
    await bridge()?.resetModelUsage?.(modelId ?? null);
    await this.refresh();
  }
}

export const modelLive = new ModelLiveStore();

export function useModelLive(): ModelLiveState {
  return useSyncExternalStore(modelLive.subscribe, modelLive.getSnapshot, () => empty);
}
