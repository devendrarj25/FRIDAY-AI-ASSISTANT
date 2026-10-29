/**
 * FRIDAY · workflows/schedules
 *
 * Real capability source: discovers every folder under `workflows/schedules/`
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

export type SchedulesModule = TreeSourceModule;

export const schedulesModule: SchedulesModule = createTreeSource("workflows", "schedules");

/** Current on-disk entries for this folder. */
export const listWorkflowsSchedules = (): CapabilityEntry[] => schedulesModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshWorkflowsSchedules = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("workflows/schedules");
  return listWorkflowsSchedules();
};

export default schedulesModule;
