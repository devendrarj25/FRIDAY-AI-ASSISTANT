/**
 * FRIDAY · agents/core
 *
 * Real capability source: discovers every folder under `agents/core/`
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

export type CoreModule = TreeSourceModule;

export const coreModule: CoreModule = createTreeSource("agents", "core");

/** Current on-disk entries for this folder. */
export const listAgentsCore = (): CapabilityEntry[] => coreModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshAgentsCore = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("agents/core");
  return listAgentsCore();
};

export default coreModule;
