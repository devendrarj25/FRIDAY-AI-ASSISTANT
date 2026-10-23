/**
 * FRIDAY · real kernel status for the desktop app.
 *
 * Production pages must never render sample data. This hook reports what the
 * machine actually has: the live bridge host, the running kernel version, the
 * detected GPU and the real FRIDAY data directory. In the browser preview
 * (no desktop bridge) it falls back to the documented sample shape so the
 * layout still renders — exactly the split the rest of the app uses.
 */
import { useSyncExternalStore } from "react";
import {
  isDesktopApp,
  kernelCall,
  desktopApi,
  onKernelExit,
  type DetectedHardware,
} from "./desktop";
import { livePoller } from "./live-poll";
import { kernelStatus as previewStatus } from "./mock";
import type { KernelStatus } from "./types";

export interface KernelInfo {
  connected?: boolean;
  version?: string;
  host?: string;
  dataDir?: string;
  gpu?: string;
}

const hhmmss = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

/** Desktop presentation of kernel status — never sample GPU/host as live. */
export function presentDesktopKernelStatus(
  info: KernelInfo | null,
  hardware: DetectedHardware | null,
  dataDir: string | null,
  startedAt: number | null,
  now = Date.now(),
): KernelStatus {
  const connected = info?.connected === true;
  const gpu = hardware?.gpus?.[0];
  const vramTotalGb = gpu?.vramTotalMb ? Math.round((gpu.vramTotalMb / 1024) * 10) / 10 : 0;
  const vramUsedGb = gpu?.vramUsedMb ? Math.round((gpu.vramUsedMb / 1024) * 10) / 10 : 0;
  return {
    connected,
    host: connected ? info?.host || "127.0.0.1:8765" : "not connected",
    version: connected ? info?.version || "unknown" : "not connected",
    uptime: connected && startedAt ? hhmmss((now - startedAt) / 1000) : "—",
    gpu:
      (gpu
        ? `${gpu.name}${hardware?.cuda?.version ? ` · CUDA ${hardware.cuda.version}` : ""}`
        : connected
          ? info?.gpu
          : undefined) ||
      (hardware ? "no discrete GPU detected" : connected ? "detecting…" : "not connected"),
    vramUsedGb,
    vramTotalGb,
    dataDir: connected
      ? info?.dataDir || dataDir || "workspace not selected"
      : dataDir || "workspace not selected",
  };
}

/**
 * One shared status store for the whole window. The first subscriber starts
 * a poll on the shared poller (paused while the window is hidden, backed off
 * while the kernel is down, refreshed the moment the kernel exits or the
 * window regains focus); the last one stops it. Ten screens cost one probe.
 */
const POLL_MS = 15_000;
type KernelState = {
  info: KernelInfo | null;
  hardware: DetectedHardware | null;
  dataDir: string | null;
  startedAt: number | null;
  /** Last successful answer (any reply, connected or not) and last failure. */
  at: number | null;
  error: string | null;
  snapshot: KernelStatus | null;
};
let state: KernelState = {
  info: null,
  hardware: null,
  dataDir: null,
  startedAt: null,
  at: null,
  error: null,
  snapshot: null,
};
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;
let hardwareAsked = false;

function publish(patch: Partial<KernelState>): void {
  state = { ...state, ...patch, snapshot: null };
  for (const l of listeners) l();
}

async function loadKernel(): Promise<void> {
  // The kernel answers `kernel.status` when it is up; a failure simply
  // means "not connected", reported honestly rather than faked.
  const [reported, paths] = await Promise.all([
    kernelCall<KernelInfo>("kernel.status").catch(() => null),
    desktopApi()?.paths?.() ?? Promise.resolve(null),
  ]);
  const connected = reported?.connected === true;
  publish({
    info: reported ?? null,
    startedAt: connected ? (state.startedAt ?? Date.now()) : null,
    dataDir: paths ? paths.workspace || paths.userData || null : state.dataDir,
    at: Date.now(),
    error: connected ? null : "kernel not connected",
  });
  // A down kernel is a failed poll: the poller backs off until it returns.
  if (!connected) throw new Error("kernel not connected");
}

function begin(): void {
  if (!isDesktopApp()) return;
  const offExit = onKernelExit(() => void livePoller().refresh("kernel.status"));
  const offPoll = livePoller().subscribe("kernel.status", loadKernel, POLL_MS);
  if (!hardwareAsked) {
    hardwareAsked = true;
    void desktopApi()
      ?.detectHardware?.()
      .then((hw) => {
        if (hw) publish({ hardware: hw });
      })
      .catch(() => undefined);
  }
  stop = () => {
    offExit();
    offPoll();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) begin();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

function snapshot(): KernelStatus {
  if (!isDesktopApp()) return previewStatus;
  state.snapshot ??= presentDesktopKernelStatus(
    state.info,
    state.hardware,
    state.dataDir,
    state.startedAt,
  );
  return state.snapshot;
}

export function useKernelStatus(): KernelStatus {
  return useSyncExternalStore(subscribe, snapshot, () => previewStatus);
}

/** When the kernel last answered and the last failure, for Live badges. */
export function useKernelLive(): { at: number | null; error: string | null; everyMs: number } {
  useKernelStatus();
  return { at: state.at, error: state.error, everyMs: POLL_MS };
}
