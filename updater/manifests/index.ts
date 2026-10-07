/**
 * FRIDAY · updater/manifests
 *
 * Reads the release manifests shipped in releases/manifests/*.json — the catalogue the update checker compares against.
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

export interface ReleaseManifest {
  version: string;
  notes: string;
  url: string | null;
  sha256: string | null;
  publishedAt: number | null;
  file: string;
}

export function releaseManifests(root = capabilities.getRoot()): ReleaseManifest[] {
  const dir = path.join(root, "releases", "manifests");
  const out: ReleaseManifest[] = [];
  for (const entry of listDir(dir)) {
    if (entry.directory || !entry.name.endsWith(".json")) continue;
    const parsed = readJson<Record<string, unknown>>(entry.path);
    if (!parsed?.["version"]) continue;
    out.push({
      version: String(parsed["version"]),
      notes: String(parsed["notes"] ?? ""),
      url: parsed["url"] ? String(parsed["url"]) : null,
      sha256: parsed["sha256"] ? String(parsed["sha256"]) : null,
      publishedAt: parsed["publishedAt"] ? Number(parsed["publishedAt"]) : null,
      file: entry.path,
    });
  }
  return out;
}

export type ManifestsModule = FridayModule;

export const manifestsModule: ManifestsModule = {
  id: "updater/manifests",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "updater/manifests ready");
  },
};

export default manifestsModule;
