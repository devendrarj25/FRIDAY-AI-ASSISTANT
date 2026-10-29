/**
 * FRIDAY · builder/release-manager
 *
 * Tracks released builds: the installers on disk and the manifest that describes the current release.
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

export interface ReleaseEntry {
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: number;
}

export function installers(root = capabilities.getRoot()): ReleaseEntry[] {
  return listDir(path.join(root, "releases", "installers"))
    .filter((entry) => !entry.directory)
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      sizeBytes: entry.size,
      createdAt: entry.modified,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function currentRelease(root = capabilities.getRoot()): Record<string, unknown> | null {
  return readJson(path.join(root, "releases", "current", "release.json"));
}

export type ReleaseManagerModule = FridayModule;

export const releaseManagerModule: ReleaseManagerModule = {
  id: "builder/release-manager",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "builder/release-manager ready");
  },
};

export default releaseManagerModule;
