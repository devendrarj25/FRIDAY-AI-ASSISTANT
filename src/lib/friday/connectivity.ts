/**
 * FRIDAY · connectivity (renderer view of her own wiring)
 *
 * The graph itself is derived in the main process from real files
 * (`electron/connectivity.cjs`): IPC channels ↔ preload bridge, kernel bridge
 * methods ↔ call sites, route files ↔ navigation, capability trees ↔
 * discovery. This module only reads it and keeps it fresh — the main process
 * pushes `connectivity:changed` whenever the project changes, so the numbers
 * shown in the app stay correct after any future upgrade without a manual
 * list anywhere.
 *
 * In the browser preview there is no main process, so the store reports
 * "preview" instead of inventing a graph.
 */

import { useSyncExternalStore } from "react";

export type ConnectivityIssue = {
  severity: "error" | "warning";
  kind: "ipc" | "ipc-event" | "kernel" | "route" | "capability";
  id: string;
  detail: string;
};

export type ConnectivitySummary = {
  ipc: number;
  ipcExposed: number;
  ipcEvents: number;
  kernelMethods: number;
  kernelCalled: number;
  kernelRoutes: number;
  pages: number;
  navEntries: number;
  capabilityTrees: number;
  rendererFiles: number;
};

export type ConnectivityGraph = {
  at: number;
  ok: boolean;
  summary: ConnectivitySummary;
  coverage: { ipc: number; kernel: number; routes: number };
  issues: ConnectivityIssue[];
  kernel: { methods: { id: string; callers: string[] }[]; routes: unknown[] };
  capabilities: { tree: string; segments: string[]; registered: boolean }[];
};

export type ConnectivityState = {
  graph: ConnectivityGraph | null;
  bridge: "desktop" | "preview";
  loading: boolean;
  error: string | null;
};

type Bridge = {
  connectivityGraph?: () => Promise<ConnectivityGraph>;
  refreshConnectivity?: () => Promise<ConnectivityGraph>;
  onConnectivityChanged?: (cb: (payload: { at: number }) => void) => () => void;
};

const bridge = (): Bridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: Bridge }).friday ?? null);

const initial: ConnectivityState = {
  graph: null,
  bridge: "preview",
  loading: false,
  error: null,
};

class ConnectivityStore {
  private state = initial;
  private listeners = new Set<() => void>();
  private started = false;
  private unsubscribe: (() => void) | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (!this.started) {
      this.started = true;
      void this.load();
      // One subscription for the whole app: the main process recomputes the
      // graph when files change and we simply re-read it.
      this.unsubscribe = bridge()?.onConnectivityChanged?.(() => void this.load()) ?? null;
    }
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.started = false;
      }
    };
  };

  getSnapshot = (): ConnectivityState => this.state;

  private set(patch: Partial<ConnectivityState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  async load(refresh = false): Promise<ConnectivityState> {
    const api = bridge();
    const read = refresh ? api?.refreshConnectivity : api?.connectivityGraph;
    if (!read) {
      this.set({ bridge: "preview", loading: false });
      return this.state;
    }
    this.set({ bridge: "desktop", loading: true, error: null });
    try {
      const graph = await read();
      this.set({ graph: graph ?? null, loading: false });
    } catch (error) {
      this.set({ loading: false, error: (error as Error).message });
    }
    return this.state;
  }

  refresh = () => this.load(true);
}

export const connectivity = new ConnectivityStore();

export function useConnectivity(): ConnectivityState {
  return useSyncExternalStore(connectivity.subscribe, connectivity.getSnapshot, () => initial);
}

/** Percentage of the wiring that is genuinely connected right now. */
export function connectedPercent(graph: ConnectivityGraph | null): number {
  if (!graph) return 0;
  const parts = [graph.coverage.ipc, graph.coverage.kernel, graph.coverage.routes];
  return Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100);
}
