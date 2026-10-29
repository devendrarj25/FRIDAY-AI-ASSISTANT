import { useEffect, useSyncExternalStore } from "react";
import { ops, type OpsState } from "./ops-engine";
import { useWorkspaceScan } from "./desktop";

const server: OpsState = ops.getSnapshot();

/**
 * Registry state for the console pages. Whenever the desktop workspace scan
 * reports what is really on disk, the registries are hydrated from it so the
 * lists match the filesystem after every import, install or app restart.
 */
export function useOps(): OpsState {
  const scan = useWorkspaceScan();

  useEffect(() => {
    if (!scan) return;
    ops.hydrateFromDisk({
      agents: scan.agents,
      skills: scan.skills,
      plugins: scan.plugins,
      modules: scan.modules,
      workflows: scan.workflows,
      tools: scan.tools,
    });
  }, [scan]);

  return useSyncExternalStore(ops.subscribe, ops.getSnapshot, () => server);
}
