/**
 * FRIDAY · renderer view of the startup flow.
 *
 * The desktop main process owns the real sequence (scan → persistent state →
 * auto-start services → verify → retry/repair → readiness) in
 * `electron/startup.cjs`. This module is the single renderer-side reader of
 * that state plus the renderer half of the flow: once the main process reports
 * READY, FRIDAY's own registries (hub resources, capability registry, model
 * registry) are re-synchronized so every screen and both modes see the same
 * world.
 *
 * In the browser preview there is no bridge, so `supported` is false and every
 * page keeps rendering exactly as it does today.
 */
import { useEffect, useState } from "react";
import { desktopApi, isDesktopApp, safeCall } from "./desktop";

export interface StartupService {
  id: string;
  name: string;
  state: "running" | "started" | "repaired" | "unavailable" | "unknown";
  detail: string;
  attempts: number;
}

export interface StartupState {
  at: number;
  ms?: number;
  ready: boolean;
  state: "ready" | "degraded" | "blocked";
  blockers: string[];
  warnings: string[];
  services: StartupService[];
  workspaceRoot?: string | null;
  workspaceExists?: boolean;
  capabilityCount?: number;
  capabilityEnabled?: number;
  counts?: Record<string, { total: number; enabled: number }>;
  kernelAlive?: boolean;
  modelsAvailable?: number;
  serviceSource?: string;
  persisted?: { settings: boolean; memory: boolean; database: boolean };
}

type Api = {
  getStartupState?: () => Promise<StartupState | null>;
  runStartup?: () => Promise<StartupState | null>;
  onStartupState?: (cb: (state: StartupState) => void) => () => void;
};

const api = () => desktopApi() as unknown as Api | null;

let current: StartupState | null = null;
const listeners = new Set<(state: StartupState | null) => void>();

function publish(next: StartupState | null) {
  current = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      /* a bad listener must never break startup reporting */
    }
  }
}

export function startupSnapshot(): StartupState | null {
  return current;
}

/** Ask the main process for the last verified startup report. */
export async function readStartupState(): Promise<StartupState | null> {
  const state = await safeCall<StartupState | null>(
    "startup:state",
    () => api()?.getStartupState?.() ?? null,
    { fallback: null },
  );
  if (state) publish(state);
  return state;
}

/** Re-run the whole verified flow (repair pass from the UI). */
export async function rerunStartup(): Promise<StartupState | null> {
  const state = await safeCall<StartupState | null>(
    "startup:run",
    () => api()?.runStartup?.() ?? null,
    { fallback: null },
  );
  if (state) publish(state);
  return state;
}

let watching = false;

/**
 * Subscribe once to main-process startup reports and run the renderer-side
 * synchronization when the flow reports READY. Idempotent — safe to call from
 * every boot path.
 */
export function watchStartup(onReady?: (state: StartupState) => void): void {
  if (watching || !isDesktopApp()) return;
  watching = true;
  void readStartupState().then((state) => {
    if (state?.ready) onReady?.(state);
  });
  api()?.onStartupState?.((state) => {
    publish(state);
    if (state?.ready) onReady?.(state);
  });
}

/** React binding for the startup report. */
export function useStartup() {
  const [state, setState] = useState<StartupState | null>(current);

  useEffect(() => {
    listeners.add(setState);
    if (isDesktopApp() && !current) void readStartupState();
    const off = api()?.onStartupState?.((next) => publish(next));
    return () => {
      listeners.delete(setState);
      off?.();
    };
  }, []);

  return {
    supported: isDesktopApp(),
    state,
    ready: Boolean(state?.ready),
    rerun: rerunStartup,
  };
}
