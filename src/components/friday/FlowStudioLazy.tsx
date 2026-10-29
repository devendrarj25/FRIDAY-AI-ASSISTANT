import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { flowStudio } from "@/lib/friday/flow-studio-store";

/**
 * The Flow Studio dialog pulls in the graph layout engine, the PDF exporter
 * and the code editor (several MB). It is only needed once the owner opens a
 * flow, so it loads then, not with the app shell. Once opened it stays
 * mounted, so reopening and closing behave exactly as before.
 */
const load = () => import("@/components/friday/FlowStudio");
const FlowStudioHost = lazy(() => load().then((m) => ({ default: m.FlowStudioHost })));

export function FlowStudioLazyHost() {
  const open = useSyncExternalStore(
    flowStudio.subscribe,
    () => flowStudio.getSnapshot().open,
    () => false,
  );
  const [wanted, setWanted] = useState(false);
  if (open && !wanted) setWanted(true);
  if (!open && !wanted) return null;
  return (
    <Suspense fallback={null}>
      <FlowStudioHost />
    </Suspense>
  );
}
