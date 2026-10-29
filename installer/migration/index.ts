/**
 * FRIDAY · installer/migration
 *
 * Applies data migrations when an older workspace is opened by a newer build. Every applied migration is recorded so it never runs twice.
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

export interface MigrationRecord {
  id: string;
  appliedAt: number;
}

export interface Migration {
  id: string;
  describe: string;
  run(root: string): void;
}

const ledgerFile = (root: string) => path.join(root, "database", "migrations.json");

/** Built-in workspace migrations, oldest first. */
export const MIGRATIONS: Migration[] = [
  {
    id: "0001-config-capabilities",
    describe: "create config/capabilities.json for persisted capability toggles",
    run(root) {
      const file = path.join(root, "config", "capabilities.json");
      if (!exists(file)) writeJson(file, {});
    },
  },
];

export function appliedMigrations(root = capabilities.getRoot()): MigrationRecord[] {
  return readJson<MigrationRecord[]>(ledgerFile(root)) ?? [];
}

export function runMigrations(root = capabilities.getRoot()): MigrationRecord[] {
  const applied = appliedMigrations(root);
  const seen = new Set(applied.map((m) => m.id));
  for (const migration of MIGRATIONS) {
    if (seen.has(migration.id)) continue;
    migration.run(root);
    applied.push({ id: migration.id, appliedAt: Date.now() });
  }
  writeJson(ledgerFile(root), applied);
  return applied;
}

export type MigrationModule = FridayModule;

export const migrationModule: MigrationModule = {
  id: "installer/migration",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "installer/migration ready");
  },
};

export default migrationModule;
