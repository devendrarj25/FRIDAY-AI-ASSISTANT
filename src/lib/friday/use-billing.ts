import { useSyncExternalStore } from "react";
import { billing, type BillingSnapshot } from "./billing";

const server: BillingSnapshot = billing.getSnapshot();

export function useBilling(): BillingSnapshot {
  return useSyncExternalStore(billing.subscribe, billing.getSnapshot, () => server);
}
