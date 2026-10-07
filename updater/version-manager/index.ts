/**
 * FRIDAY · updater/version-manager
 *
 * Single source of truth for the running public version: config/friday-version.json
 * via the release engine. package.json is only the npm/electron-builder SemVer
 * encoding and must not be used as the product identity.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { capabilities } from "../../core/discovery";
import { readJson, writeJson } from "../../core/paths";
import type { FridayModule, ModuleContext } from "../../core/types";

const require_ = createRequire(import.meta.url);
const engine = require_("../../scripts/release-engine.cjs") as {
  readCanonicalIdentity: (opts?: { root?: string }) => { releaseVersion?: string } | null;
};

export interface VersionEntry {
  version: string;
  at: number;
}

const historyFile = (root: string) => path.join(root, "config", "version.json");

export function currentVersion(root = capabilities.getRoot()): string | null {
  const identity = engine.readCanonicalIdentity({ root });
  if (identity?.releaseVersion) return identity.releaseVersion;
  const pkg = readJson<{ version?: string }>(path.join(root, "package.json"));
  return pkg?.version ?? null;
}

export function versionHistory(root = capabilities.getRoot()): VersionEntry[] {
  return readJson<VersionEntry[]>(historyFile(root)) ?? [];
}

export function recordVersion(version: string, root = capabilities.getRoot()): VersionEntry[] {
  const history = versionHistory(root);
  if (history[history.length - 1]?.version === version) return history;
  history.push({ version, at: Date.now() });
  writeJson(historyFile(root), history);
  return history;
}

export type VersionManagerModule = FridayModule;

export const versionManagerModule: VersionManagerModule = {
  id: "updater/version-manager",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "updater/version-manager ready");
  },
};

export default versionManagerModule;
