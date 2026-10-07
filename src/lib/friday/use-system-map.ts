import { useSyncExternalStore } from "react";
import { systemMap, type SystemMapSnapshot } from "./system-map";
import { devPipeline, type DevPipelineState } from "./self/dev-pipeline";

export function useSystemMap(): SystemMapSnapshot {
  return useSyncExternalStore(systemMap.subscribe, systemMap.getSnapshot, systemMap.getSnapshot);
}

export function useDevPipeline(): DevPipelineState {
  return useSyncExternalStore(
    devPipeline.subscribe,
    devPipeline.getSnapshot,
    devPipeline.getSnapshot,
  );
}
