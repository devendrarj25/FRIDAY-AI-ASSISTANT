/**
 * FRIDAY · workflows/history
 *
 * Real capability source: discovers every folder under `workflows/history/`
 * on disk and registers it with the shared capability registry, so the UI and
 * the Core Brain see exactly what is installed — no hardcoded entries.
 */
import {
  capabilities,
  createTreeSource,
  type CapabilityEntry,
  type TreeSourceModule,
} from "../../core/discovery";
import type { ModuleContext } from "../../core/types";

export type HistoryModule = TreeSourceModule;

export const historyModule: HistoryModule = createTreeSource("workflows", "history");

/** Current on-disk entries for this folder. */
export const listWorkflowsHistory = (): CapabilityEntry[] => historyModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshWorkflowsHistory = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("workflows/history");
  return listWorkflowsHistory();
};

export default historyModule;
