/**
 * FRIDAY · builder/upgrade-manager
 *
 * Decides whether the installed app is behind the source checkout, using the version manager and the build state — the input for an in-place upgrade.
 */
import path from "node:path";
import fs from "node:fs";
import { capabilities } from "../../core/discovery";
import {
  countFiles,
  ensureDirs,
  exists,
  findFiles,
  hashFile,
  isWritable,
  listDir,
  readJson,
  writeJson,
} from "../../core/paths";
import type { FridayModule, ModuleContext } from "../../core/types";

import { buildState } from "../build-manager";
import { missingDependencies } from "../dependency-manager";
import { currentVersion, versionHistory } from "../../updater/version-manager";

export interface UpgradeReadiness {
  version: string | null;
  previousVersion: string | null;
  dependenciesMissing: number;
  builtArtifacts: number;
  canBuild: boolean;
  blockers: string[];
}

export function upgradeReadiness(root = capabilities.getRoot()): UpgradeReadiness {
  const history = versionHistory(root);
  const missing = missingDependencies(root);
  const build = buildState(root);
  const blockers: string[] = [];
  if (missing.length)
    blockers.push(`${missing.length} npm dependencies not installed (run npm install)`);
  if (!exists(path.join(root, "package.json"))) blockers.push("package.json not found in root");
  return {
    version: currentVersion(root),
    previousVersion: history[history.length - 2]?.version ?? null,
    dependenciesMissing: missing.length,
    builtArtifacts: build.artifacts.length,
    canBuild: blockers.length === 0,
    blockers,
  };
}

export type UpgradeManagerModule = FridayModule;

export const upgradeManagerModule: UpgradeManagerModule = {
  id: "builder/upgrade-manager",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "builder/upgrade-manager ready");
  },
};

export default upgradeManagerModule;
