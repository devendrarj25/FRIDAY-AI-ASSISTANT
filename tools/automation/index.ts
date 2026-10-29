/**
 * FRIDAY · tools/automation
 *
 * Real capability source: discovers every folder under `tools/automation/`
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

export type AutomationModule = TreeSourceModule;

export const automationModule: AutomationModule = createTreeSource("tools", "automation");

/** Current on-disk entries for this folder. */
export const listToolsAutomation = (): CapabilityEntry[] => automationModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshToolsAutomation = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("tools/automation");
  return listToolsAutomation();
};

export default automationModule;
