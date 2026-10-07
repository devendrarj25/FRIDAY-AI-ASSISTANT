/**
 * FRIDAY · plugins/marketplace
 *
 * Real capability source: discovers every folder under `plugins/marketplace/`
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

export type MarketplaceModule = TreeSourceModule;

export const marketplaceModule: MarketplaceModule = createTreeSource("plugins", "marketplace");

/** Current on-disk entries for this folder. */
export const listPluginsMarketplace = (): CapabilityEntry[] => marketplaceModule.scan();

/** Re-scan after a file was added or removed. */
export const refreshPluginsMarketplace = (ctx?: ModuleContext): CapabilityEntry[] => {
  if (ctx?.root) capabilities.setRoot(ctx.root);
  capabilities.refresh("plugins/marketplace");
  return listPluginsMarketplace();
};

export default marketplaceModule;
