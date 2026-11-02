/**
 * What the PC is doing right now, as the main process reads it (electron/system-health.cjs): free memory,
 * FRIDAY's own memory and CPU, and whether the PC is on battery. When it is short of memory or on battery the
 * interface drops its decoration: looping animations stop, the circuit lines hide and glass blur goes, so the work
 * FRIDAY is doing gets the machine. Nothing here changes what a click does. The "Lighten effects" setting turns the
 * whole thing off.
 */
import { flushPendingState } from "./persist";
import { desktopApi } from "./desktop";
import { preferences } from "./preferences";

export type SystemPressure = {
  level: "ok" | "high" | "critical";
  lite: boolean;
  freeGb: number;
  freePercent: number;
  appMemMb: number;
  appCpuPercent: number;
  onBattery: boolean;
  speedLimit: number;
  at: number;
};

let current: SystemPressure | null = null;
const listeners = new Set<() => void>();

export const getSystemPressureSnapshot = () => current;
export const subscribeSystemPressure = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** True when the interface should drop its decoration right now. */
export function liteActive(snapshot: SystemPressure | null, autoLite: boolean): boolean {
  return Boolean(autoLite && snapshot && snapshot.lite);
}

function apply() {
  if (typeof document === "undefined") return;
  const autoLite = preferences.getSnapshot().toggles["autoLite"] !== false;
  document.documentElement.classList.toggle("friday-lite", liteActive(current, autoLite));
}

function set(next: SystemPressure | null) {
  current = next;
  apply();
  listeners.forEach((listener) => listener());
}

/** Starts listening. Safe in the browser preview, where there is no desktop bridge and nothing happens. */
export function startSystemPressure(): () => void {
  const desktop = desktopApi();
  const stops: Array<() => void> = [];
  stops.push(preferences.subscribe(apply));
  if (desktop?.getSystemPressure) {
    void desktop
      .getSystemPressure()
      .then((snapshot) => set(snapshot))
      .catch(() => undefined);
  }
  if (desktop?.onSystemPressure) stops.push(desktop.onSystemPressure((snapshot) => set(snapshot)));
  // The PC is going to sleep: nothing tells the page it is hiding, so what still waits on a save delay goes now.
  if (desktop?.onSystemSuspend) stops.push(desktop.onSystemSuspend(() => flushPendingState()));
  return () => {
    for (const stop of stops) stop();
    document.documentElement.classList.remove("friday-lite");
  };
}
