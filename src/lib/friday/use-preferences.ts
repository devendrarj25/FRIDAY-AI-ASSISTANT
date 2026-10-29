import { useSyncExternalStore } from "react";
import { preferences, type FridayPreferences } from "./preferences";

const server: FridayPreferences = preferences.getSnapshot();

export function usePreferences(): FridayPreferences {
  return useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, () => server);
}
