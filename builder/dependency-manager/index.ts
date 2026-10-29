/**
 * FRIDAY · builder/dependency-manager
 *
 * Reports the real dependency state of the checkout: declared npm packages vs. what is installed in node_modules, and the Python packages listed in kernel/requirements.txt.
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

export interface DependencyState {
  name: string;
  required: string;
  installed: string | null;
  satisfied: boolean;
  kind: "npm" | "python";
}

export function npmDependencies(root = capabilities.getRoot()): DependencyState[] {
  const pkg = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(path.join(root, "package.json"));
  const declared = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  return Object.entries(declared).map(([name, required]) => {
    const installed = readJson<{ version?: string }>(
      path.join(root, "node_modules", name, "package.json"),
    )?.version;
    return {
      name,
      required,
      installed: installed ?? null,
      satisfied: Boolean(installed),
      kind: "npm" as const,
    };
  });
}

export function pythonDependencies(root = capabilities.getRoot()): DependencyState[] {
  const file = path.join(root, "kernel", "requirements.txt");
  if (!exists(file)) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, required = "*"] = line.split(/[=<>~!]+/);
      return {
        name: (name ?? line).trim(),
        required: required.trim(),
        installed: null,
        satisfied: false,
        kind: "python" as const,
      };
    });
}

export function missingDependencies(root = capabilities.getRoot()): DependencyState[] {
  return npmDependencies(root).filter((dep) => !dep.satisfied);
}

export type DependencyManagerModule = FridayModule;

export const dependencyManagerModule: DependencyManagerModule = {
  id: "builder/dependency-manager",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "builder/dependency-manager ready");
  },
};

export default dependencyManagerModule;
