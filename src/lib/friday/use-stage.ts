import { useSyncExternalStore } from "react";
import { stage, type StageState } from "./stage";

const server: StageState = stage.getSnapshot();

export function useStage(): StageState {
  return useSyncExternalStore(stage.subscribe, stage.getSnapshot, () => server);
}
