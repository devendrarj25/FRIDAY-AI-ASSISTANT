import { useSyncExternalStore } from "react";
import { brain, type BrainState } from "./brain-engine";

const server: BrainState = brain.getSnapshot();

export function useBrain(): BrainState {
  return useSyncExternalStore(brain.subscribe, brain.getSnapshot, () => server);
}
