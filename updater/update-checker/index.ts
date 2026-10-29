/**
 * FRIDAY · updater/update-checker
 *
 * Compares the running version with the release manifests on disk and reports whether a newer build is available. No network guessing.
 */
import { createRequire } from "node:module";
import { capabilities } from "../../core/discovery";
import type { FridayModule, ModuleContext } from "../../core/types";

import { releaseManifests, type ReleaseManifest } from "../manifests";
import { currentVersion } from "../version-manager";

const require_ = createRequire(import.meta.url);
const engine = require_("../../scripts/release-engine.cjs") as {
  compareBuilds: (a: string, b: string) => number;
};

export interface UpdateCheck {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  manifest: ReleaseManifest | null;
  checkedAt: number;
}

/** Numeric FRIDAY ordering (epoch-aware). Same as scripts/release-engine.cjs compareBuilds. */
export function compareVersions(a: string, b: string): number {
  return engine.compareBuilds(a, b);
}

export function checkForUpdate(root = capabilities.getRoot()): UpdateCheck {
  const current = currentVersion(root);
  const manifests = releaseManifests(root).sort((a, b) => compareVersions(a.version, b.version));
  const manifest = manifests[manifests.length - 1] ?? null;
  const latest = manifest?.version ?? null;
  return {
    current,
    latest,
    updateAvailable: Boolean(current && latest && compareVersions(latest, current) > 0),
    manifest,
    checkedAt: Date.now(),
  };
}

export type UpdateCheckerModule = FridayModule;

export const updateCheckerModule: UpdateCheckerModule = {
  id: "updater/update-checker",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "updater/update-checker ready");
  },
};

export default updateCheckerModule;
