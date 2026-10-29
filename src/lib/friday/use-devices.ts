import { useEffect, useSyncExternalStore } from "react";
import { devices, type DevicesState } from "./devices";

const server: DevicesState = devices.getSnapshot();

/** Live device state. Refreshes once on mount; discovery stays explicit. */
export function useDevices(): DevicesState {
  const state = useSyncExternalStore(devices.subscribe, devices.getSnapshot, () => server);

  useEffect(() => {
    void devices.refresh();
  }, []);

  return state;
}
