import { useSyncExternalStore } from "react";
import { hub, type HubState } from "./hub-engine";

const server: HubState = { resources: [], busy: false, message: "" };

export function useHub(): HubState {
  return useSyncExternalStore(hub.subscribe, hub.getSnapshot, () => server);
}
