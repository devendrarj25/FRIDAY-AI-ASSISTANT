/**
 * FRIDAY · models/configs
 *
 * Real capability source: discovers every folder under `models/configs/`
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

export type ConfigsModule = TreeSourceModule;

export const configsModule: ConfigsModule = createTreeSource("models", "configs");

/** Current on-disk entries for this folder. */
export const listModelsConfigs = (): CapabilityEntry[] => configsModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshModelsConfigs = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("models/configs");
  return listModelsConfigs();
};

export default configsModule;
