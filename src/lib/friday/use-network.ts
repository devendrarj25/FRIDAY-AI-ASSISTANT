import { useSyncExternalStore } from "react";
import { networkMeter, type NetworkSample } from "./network";

/** Live, measured network state. One shared meter for the whole app. */
export function useNetwork(): NetworkSample {
  return useSyncExternalStore(
    networkMeter.subscribe,
    networkMeter.getSnapshot,
    networkMeter.getSnapshot,
  );
}
