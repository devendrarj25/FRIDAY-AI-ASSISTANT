import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { LoadingState } from "@/components/friday/ui";
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
    <Suspense
      fallback={
        // The studio is several MB and loads on first open: say so instead of showing nothing.
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm">
          <div className="w-72 rounded-surface border border-primary/25 bg-card p-4">
            <LoadingState label="Opening Flow Studio…" rows={3} />
          </div>
        </div>
      }
    >
      <FlowStudioHost />
    </Suspense>
  );
}
