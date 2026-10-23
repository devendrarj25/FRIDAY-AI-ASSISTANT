import { lazy, Suspense, useSyncExternalStore } from "react";
import { flowStudio } from "@/lib/friday/flow-studio-store";

/**
 * The Flow Studio dialog pulls in the graph layout engine, the PDF exporter
 * and the code editor (several MB). It is only needed once the owner opens a
 * flow, so it loads then, not with the app shell. Once opened it stays
 * mounted, so reopening and closing behave exactly as before.
 */
const FlowStudioHost = lazy(() =>
  import("@/components/friday/FlowStudio").then((m) => ({ default: m.FlowStudioHost })),
);

let opened = false;

export function FlowStudioLazyHost() {
  const open = useSyncExternalStore(
    flowStudio.subscribe,
    () => flowStudio.getSnapshot().open,
    () => false,
  );
  if (open) opened = true;
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <FlowStudioHost />
    </Suspense>
  );
}
