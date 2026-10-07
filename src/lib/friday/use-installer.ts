import { useSyncExternalStore } from "react";
import { installer, type InstallerState } from "./installer-engine";

const server: InstallerState = installer.getSnapshot();

export function useInstaller(): InstallerState {
  return useSyncExternalStore(installer.subscribe, installer.getSnapshot, () => server);
}
