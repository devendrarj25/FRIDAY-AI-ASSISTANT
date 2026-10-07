/**
 * FRIDAY · real kernel status for the desktop app.
 *
 * Production pages must never render sample data. This hook reports what the
 * machine actually has: the live bridge host, the running kernel version, the
 * detected GPU and the real FRIDAY data directory. In the browser preview
 * (no desktop bridge) it falls back to the documented sample shape so the
 * layout still renders — exactly the split the rest of the app uses.
 */
import { useEffect, useState } from "react";
import {
  isDesktopApp,
  kernelCall,
  useHardware,
  desktopApi,
  onKernelExit,
  type DetectedHardware,
} from "./desktop";
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

export function useKernelStatus(): KernelStatus {
  const hardware = useHardware();
  const [info, setInfo] = useState<KernelInfo | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  // First moment the kernel answered in this app session — a real uptime for
  // the connection, never an invented one.
  const [startedAt, setStartedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!isDesktopApp()) return;
    let active = true;

    const load = async () => {
      // The kernel answers `kernel.status` when it is up; a failure simply
      // means "not connected", reported honestly rather than faked.
      const [reported, paths] = await Promise.all([
        kernelCall<KernelInfo>("kernel.status").catch(() => null),
        desktopApi()?.paths?.() ?? Promise.resolve(null),
      ]);
      if (!active) return;
      setInfo(reported ?? null);
      setStartedAt((prev) => (reported?.connected === true ? (prev ?? Date.now()) : null));
      if (paths) setDataDir(paths.workspace || paths.userData || null);
    };

    void load();
    const offExit = onKernelExit(() => void load());
    const id = setInterval(() => void load(), 15_000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      active = false;
      offExit();
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  if (!isDesktopApp()) return previewStatus;

  return presentDesktopKernelStatus(info, hardware, dataDir, startedAt);
}
