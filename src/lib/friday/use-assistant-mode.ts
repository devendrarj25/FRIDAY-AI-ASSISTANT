import { useSyncExternalStore } from "react";
import { assistantMode, type AssistantModeState } from "./assistant-mode";

const server: AssistantModeState = assistantMode.getSnapshot();

export function useAssistantMode(): AssistantModeState {
  return useSyncExternalStore(assistantMode.subscribe, assistantMode.getSnapshot, () => server);
}
