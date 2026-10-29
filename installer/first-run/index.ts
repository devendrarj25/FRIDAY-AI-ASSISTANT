/**
 * FRIDAY · installer/first-run
 *
 * Tracks whether this installation has completed its first run, and what that
 * run actually did. Backed by <root>/config/first-run.json so the state
 * survives restarts and upgrades.
 *
 * The real bootstrap work — free-tier provider keys, the offline chat model
 * and the voice engines — is performed by src/lib/friday/first-run.ts through
 * the existing Install Manager and model downloader, and the outcome of every
 * step is recorded here so it never runs twice.
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

/** One real setup step and how it ended. */
export interface FirstRunStep {
  id: string;
  state: string;
  detail: string;
}

export interface FirstRunState {
  completed: boolean;
  completedAt: number | null;
  version: string | null;
  steps?: FirstRunStep[];
}

const stateFile = (root: string) => path.join(root, "config", "first-run.json");

export function firstRunState(root = capabilities.getRoot()): FirstRunState {
  const saved = readJson<FirstRunState>(stateFile(root));
  return saved ?? { completed: false, completedAt: null, version: null, steps: [] };
}

export function completeFirstRun(
  version: string | null,
  root = capabilities.getRoot(),
  steps: FirstRunStep[] = [],
): FirstRunState {
  const next: FirstRunState = { completed: true, completedAt: Date.now(), version, steps };
  writeJson(stateFile(root), next);
  return next;
}

export type FirstRunModule = FridayModule;

export const firstRunModule: FirstRunModule = {
  id: "installer/first-run",
  init(ctx: ModuleContext) {
    capabilities.setRoot(ctx.root || capabilities.getRoot());
    ctx.log("info", "installer/first-run ready");
  },
};

export default firstRunModule;
