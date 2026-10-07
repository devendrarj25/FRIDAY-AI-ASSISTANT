/**
 * FRIDAY · updater/migration
 *
 * Version-to-version data migrations run after an update is applied; delegates to the installer migration ledger so migrations exist in exactly one place.
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

import { appliedMigrations, runMigrations, type MigrationRecord } from "../../installer/migration";

export interface UpgradeMigrationReport {
  from: string | null;
  to: string | null;
  applied: MigrationRecord[];
}

export function migrateAfterUpdate(
  from: string | null,
  to: string | null,
  root = capabilities.getRoot(),
): UpgradeMigrationReport {
  return { from, to, applied: runMigrations(root) };
}

export function migrationLedger(root = capabilities.getRoot()): MigrationRecord[] {
  return appliedMigrations(root);
}

export type MigrationModule = FridayModule;

export const migrationModule: MigrationModule = {
  id: "updater/migration",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "updater/migration ready");
  },
};

export default migrationModule;
