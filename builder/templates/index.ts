/**
 * FRIDAY · builder/templates
 *
 * Lists the real project/build templates available under builder/templates so the builder can scaffold from them.
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

export interface TemplateEntry {
  id: string;
  name: string;
  path: string;
  description: string;
}

export function templates(root = capabilities.getRoot()): TemplateEntry[] {
  const dir = path.join(root, "builder", "templates");
  return listDir(dir)
    .filter((entry) => entry.directory)
    .map((entry) => {
      const manifest = readJson<{ name?: string; description?: string }>(
        path.join(entry.path, "template.json"),
      );
      return {
        id: entry.name,
        name: manifest?.name ?? entry.name,
        path: entry.path,
        description: manifest?.description ?? "",
      };
    });
}

export type TemplatesModule = FridayModule;

export const templatesModule: TemplatesModule = {
  id: "builder/templates",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "builder/templates ready");
  },
};

export default templatesModule;
