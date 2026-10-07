/**
 * FRIDAY · updater/update-manager
 *
 * Tracks the state of an in-progress update (staged, applied, failed) in <root>/database/update-state.json so a crash never leaves an unknown state.
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

export type UpdatePhase = "idle" | "staged" | "applying" | "applied" | "failed";

export interface UpdateState {
  phase: UpdatePhase;
  version: string | null;
  backup: string | null;
  error: string | null;
  at: number;
}

const stateFile = (root: string) => path.join(root, "database", "update-state.json");

export function updateState(root = capabilities.getRoot()): UpdateState {
  return (
    readJson<UpdateState>(stateFile(root)) ?? {
      phase: "idle",
      version: null,
      backup: null,
      error: null,
      at: 0,
    }
  );
}

export function setUpdateState(
  next: Partial<UpdateState>,
  root = capabilities.getRoot(),
): UpdateState {
  const merged: UpdateState = { ...updateState(root), ...next, at: Date.now() };
  writeJson(stateFile(root), merged);
  return merged;
}

export type UpdateManagerModule = FridayModule;

export const updateManagerModule: UpdateManagerModule = {
  id: "updater/update-manager",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "updater/update-manager ready");
  },
};

export default updateManagerModule;
