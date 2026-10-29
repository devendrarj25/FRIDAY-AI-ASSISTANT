/**
 * FRIDAY · workflows/saved
 *
 * Real capability source: discovers every folder under `workflows/saved/`
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

export type SavedModule = TreeSourceModule;

export const savedModule: SavedModule = createTreeSource("workflows", "saved");

/** Current on-disk entries for this folder. */
export const listWorkflowsSaved = (): CapabilityEntry[] => savedModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshWorkflowsSaved = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("workflows/saved");
  return listWorkflowsSaved();
};

export default savedModule;
