/**
 * FRIDAY · modules/ui
 *
 * Real capability source: discovers every folder under `modules/ui/`
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

export type UiModule = TreeSourceModule;

export const uiModule: UiModule = createTreeSource("modules", "ui");

/** Current on-disk entries for this folder. */
export const listModulesUi = (): CapabilityEntry[] => uiModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshModulesUi = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("modules/ui");
  return listModulesUi();
};

export default uiModule;
