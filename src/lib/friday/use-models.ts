import { useSyncExternalStore } from "react";
import { models, type ModelsState } from "./models-engine";

const server: ModelsState = models.getSnapshot();

export function useModels(): ModelsState {
  return useSyncExternalStore(models.subscribe, models.getSnapshot, () => server);
}
