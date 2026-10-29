/**
 * FRIDAY · installer/folder-selector
 *
 * Validates a candidate FRIDAY root folder before anything is written into it. The Electron picker (workspace:pick) hands its result here.
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

export interface FolderCheck {
  path: string;
  exists: boolean;
  writable: boolean;
  empty: boolean;
  looksLikeFriday: boolean;
  files: number;
  problems: string[];
}

export function checkFolder(target: string): FolderCheck {
  const present = exists(target);
  const entries = present ? listDir(target) : [];
  const writable = present && isWritable(target);
  const markers = ["friday.json", "workspace.json", "config", "database"];
  const names = new Set(entries.map((e) => e.name));
  const problems: string[] = [];
  if (!present) problems.push("folder does not exist");
  else if (!writable) problems.push("folder is not writable by this user");
  return {
    path: target,
    exists: present,
    writable,
    empty: entries.length === 0,
    looksLikeFriday: markers.some((m) => names.has(m)),
    files: entries.length,
    problems,
  };
}

export type FolderSelectorModule = FridayModule;

export const folderSelectorModule: FolderSelectorModule = {
  id: "installer/folder-selector",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "installer/folder-selector ready");
  },
};

export default folderSelectorModule;
