import { useSyncExternalStore } from "react";
import { subscribeVoiceTasks, voiceTaskSnapshot } from "./voice-engine/voice-tasks";
import type { VoiceTask } from "./voice-engine/task-orchestrator";

const server: VoiceTask[] = [];

/** The voice tasks, live. Re-renders only when a task changes. */
export function useVoiceTasks(): VoiceTask[] {
  return useSyncExternalStore(subscribeVoiceTasks, voiceTaskSnapshot, () => server);
}
