import { useSyncExternalStore } from "react";
import { upgrades, type UpgradeState } from "./upgrade-engine";

const server: UpgradeState = upgrades.getSnapshot();

export function useUpgrades(): UpgradeState {
  return useSyncExternalStore(upgrades.subscribe, upgrades.getSnapshot, () => server);
}
