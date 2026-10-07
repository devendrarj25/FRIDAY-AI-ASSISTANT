/**
 * FRIDAY · installer/setup
 *
 * Creates and verifies the FRIDAY workspace skeleton inside the selected root folder. Real fs work only; existing folders are never re-created or emptied.
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

/** Folders every FRIDAY workspace must have. */
export const WORKSPACE_FOLDERS = [
  "config",
  "database",
  "memory",
  "conversations",
  "models",
  "plugins",
  "modules",
  "agents",
  "skills",
  "tools",
  "workflows",
  "backup",
  "releases",
  "temporary",
  "debug",
];

export interface SetupResult {
  root: string;
  created: string[];
  existing: string[];
  writable: boolean;
}

export function runSetup(root = capabilities.getRoot()): SetupResult {
  const writable = isWritable(root);
  if (!writable) return { root, created: [], existing: [], writable };
  const { created, existing } = ensureDirs(root, WORKSPACE_FOLDERS);
  return { root, created, existing, writable };
}

export type SetupModule = FridayModule;

export const setupModule: SetupModule = {
  id: "installer/setup",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "installer/setup ready");
  },
};

export default setupModule;
