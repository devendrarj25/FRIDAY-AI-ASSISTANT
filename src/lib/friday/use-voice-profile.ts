import { useEffect, useSyncExternalStore } from "react";
import type { VoiceEnrollStatus } from "./desktop";
import { refreshVoiceProfile, subscribeVoiceProfile, voiceProfileSnapshot } from "./voice-profile";

/** The saved voice profile (what is recorded and built), kept fresh while a screen shows it. */
export function useVoiceProfile(): VoiceEnrollStatus | null {
  const snapshot = useSyncExternalStore(subscribeVoiceProfile, voiceProfileSnapshot, () => null);
  useEffect(() => {
    void refreshVoiceProfile();
  }, []);
  return snapshot;
}
