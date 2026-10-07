/**
 * FRIDAY · builder/source-manager
 *
 * Knows which folders make up the FRIDAY source and what state they are in (file counts and a content hash of the entry files).
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

export const SOURCE_TREES = ["src", "electron", "core", "kernel", "scripts"];

export interface SourceTree {
  name: string;
  present: boolean;
  files: number;
  folders: number;
  entryHash: string | null;
}

export function sourceTrees(root = capabilities.getRoot()): SourceTree[] {
  return SOURCE_TREES.map((name) => {
    const dir = path.join(root, name);
    if (!exists(dir)) return { name, present: false, files: 0, folders: 0, entryHash: null };
    const counts = countFiles(dir, 8000);
    const first = listDir(dir).find((entry) => !entry.directory);
    return { name, present: true, ...counts, entryHash: first ? hashFile(first.path) : null };
  });
}

export type SourceManagerModule = FridayModule;

export const sourceManagerModule: SourceManagerModule = {
  id: "builder/source-manager",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "builder/source-manager ready");
  },
};

export default sourceManagerModule;
