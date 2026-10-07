/**
 * FRIDAY · builder/build-manager
 *
 * Reports what the last build actually produced: renderer bundle, desktop bundle and packaged artifacts on disk.
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

export interface BuildArtifact {
  name: string;
  path: string;
  sizeBytes: number;
  builtAt: number;
}

export interface BuildState {
  rendererBuilt: boolean;
  desktopBuilt: boolean;
  artifacts: BuildArtifact[];
  lastBuiltAt: number | null;
}

export function buildState(root = capabilities.getRoot()): BuildState {
  const renderer = path.join(root, "dist");
  const desktop = path.join(root, "dist-electron");
  const releaseDir = path.join(root, "release");
  const artifacts = [releaseDir, path.join(root, "releases", "installers")]
    .flatMap((dir) => listDir(dir))
    .filter((entry) => !entry.directory && /\.(exe|zip|msi|nupkg|tar\.gz)$/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      sizeBytes: entry.size,
      builtAt: entry.modified,
    }))
    .sort((a, b) => b.builtAt - a.builtAt);
  return {
    rendererBuilt: exists(path.join(renderer, "index.html")) || exists(renderer),
    desktopBuilt: exists(desktop),
    artifacts,
    lastBuiltAt: artifacts[0]?.builtAt ?? null,
  };
}

export type BuildManagerModule = FridayModule;

export const buildManagerModule: BuildManagerModule = {
  id: "builder/build-manager",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "builder/build-manager ready");
  },
};

export default buildManagerModule;
