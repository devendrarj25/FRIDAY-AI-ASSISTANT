/**
 * FRIDAY · updater/rollback
 *
 * Lists the real backups written before an update and restores one on request. A rollback is only offered when the backup folder actually exists.
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

export interface BackupEntry {
  id: string;
  path: string;
  createdAt: number;
  size: number;
}

export function backups(root = capabilities.getRoot()): BackupEntry[] {
  const dir = path.join(root, "backup", "releases");
  return listDir(dir)
    .filter((entry) => entry.directory)
    .map((entry) => ({
      id: entry.name,
      path: entry.path,
      createdAt: entry.modified,
      size: entry.size,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export interface RollbackResult {
  ok: boolean;
  restored: string[];
  error?: string;
}

/** Copies a backup folder back over the target. Never deletes the backup. */
export function restore(id: string, target: string, root = capabilities.getRoot()): RollbackResult {
  const entry = backups(root).find((b) => b.id === id);
  if (!entry) return { ok: false, restored: [], error: `unknown backup: ${id}` };
  try {
    fs.cpSync(entry.path, target, { recursive: true, force: true });
    return { ok: true, restored: listDir(entry.path).map((e) => e.name) };
  } catch (error) {
    return {
      ok: false,
      restored: [],
      error: error instanceof Error ? error.message : "restore failed",
    };
  }
}

export type RollbackModule = FridayModule;

export const rollbackModule: RollbackModule = {
  id: "updater/rollback",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "updater/rollback ready");
  },
};

export default rollbackModule;
