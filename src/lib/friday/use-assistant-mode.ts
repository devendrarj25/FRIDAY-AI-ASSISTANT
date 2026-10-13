import { useSyncExternalStore } from "react";
import { assistantMode, type AssistantModeState } from "./assistant-mode";

const server: AssistantModeState = assistantMode.getSnapshot();

export function useAssistantMode(): AssistantModeState {
  return useSyncExternalStore(assistantMode.subscribe, assistantMode.getSnapshot, () => server);
}

/**
 * Re-render only when the selected value changes. React 19 compares the
 * snapshot with Object.is, so the selector must return a string or another
 * value that keeps the same identity when the slice did not change.
 */
export function useAssistantSlice<T>(select: (state: AssistantModeState) => T): T {
  return useSyncExternalStore(
    assistantMode.subscribe,
    () => select(assistantMode.getSnapshot()),
    () => select(server),
  );
}
