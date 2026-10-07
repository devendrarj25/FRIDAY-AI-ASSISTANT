import { useEffect, useState } from "react";

/**
 * Live health of FRIDAY's own services (kernel, workspace, database, local
 * model engines).
 *
 * Everything is probed by the main process (`electron/service-health.cjs`) on
 * one shared interval — subscribing from ten screens still costs one prober.
 * Outside Electron there is nothing to probe, so the hook reports
 * `supported: false` and the UI says so instead of inventing a green light.
 */

export type ServiceState = "online" | "offline" | "degraded" | "unknown";

export type ServiceRecord = {
  id: string;
  name: string;
  state: ServiceState;
  detail: string;
  latencyMs: number | null;
  at: number;
};

export type ServiceHealth = {
  at: number;
  services: ServiceRecord[];
  online: number;
  total: number;
  state: "healthy" | "degraded" | "blocked";
};

type Bridge = {
  systemHealth?: () => Promise<ServiceHealth | null>;
  subscribeSystemHealth?: () => Promise<ServiceHealth | null>;
  unsubscribeSystemHealth?: () => Promise<boolean>;
  onSystemHealth?: (cb: (value: ServiceHealth) => void) => () => void;
};

const bridge = (): Bridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: Bridge }).friday ?? null);

export function useServiceHealth(): { supported: boolean; health: ServiceHealth | null } {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const api = bridge();
    if (!api?.onSystemHealth) return;
    setSupported(true);

    let active = true;
    const apply = (value: ServiceHealth | null) => {
      if (active && value) setHealth(value);
    };
    const off = api.onSystemHealth(apply);
    void api.subscribeSystemHealth?.().then(apply);

    return () => {
      active = false;
      off?.();
      void api.unsubscribeSystemHealth?.();
    };
  }, []);

  return { supported, health };
}

export const serviceTone = (state: ServiceState) =>
  state === "online"
    ? "Online"
    : state === "degraded"
      ? "Degraded"
      : state === "offline"
        ? "Offline"
        : "Unknown";
