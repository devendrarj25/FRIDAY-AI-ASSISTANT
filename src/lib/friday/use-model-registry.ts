import { useSyncExternalStore } from "react";
import { modelRegistry, type RegistryState } from "./model-registry";

const server: RegistryState = modelRegistry.getSnapshot();

export function useModelRegistry(): RegistryState {
  return useSyncExternalStore(modelRegistry.subscribe, modelRegistry.getSnapshot, () => server);
}
