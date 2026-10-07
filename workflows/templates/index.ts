/**
 * FRIDAY · workflows/templates
 *
 * Real capability source: discovers every folder under `workflows/templates/`
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

export type TemplatesModule = TreeSourceModule;

export const templatesModule: TemplatesModule = createTreeSource("workflows", "templates");

/** Current on-disk entries for this folder. */
export const listWorkflowsTemplates = (): CapabilityEntry[] => templatesModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshWorkflowsTemplates = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("workflows/templates");
  return listWorkflowsTemplates();
};

export default templatesModule;
