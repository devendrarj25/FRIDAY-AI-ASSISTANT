/**
 * FRIDAY · module registry.
 *
 * Single place where every architecture folder is linked together. The boot
 * order below is the working pipeline:
 *
 *   User → Chat/Voice → Intent → Context/Memory → Brain/Planner → Model Router
 *        → Agent → Skill → Tool/Plugin → Permission → Background Worker
 *        → Windows/System Action → Verification → Memory Update → Response
 */
import type { FridayModule, ModuleContext } from "./types";

import { intentModule } from "./brain/intent";
import { reasoningModule } from "./brain/reasoning";
import { plannerModule } from "./brain/planner";
import { decisionModule } from "./brain/decision";
import { routerModule as brainRouterModule } from "./brain/router";
import { modelRouterModule } from "./ai/model-router";
import { modelManagerModule } from "./ai/model-manager";
import { providersModule } from "./ai/providers";
import { contextModule } from "./context";
import { orchestrationModule } from "./orchestration";
import { permissionsModule } from "./permissions";
import { synchronizationModule } from "./synchronization";
import { eventBusModule } from "./event-bus";
import { lifecycleModule } from "./lifecycle";

// Capability + platform trees. Each barrel re-exports the FridayModule that
// owns one folder; they are collected automatically so dropping a new folder
// module into a tree never requires editing this file by hand.
import * as agentsTree from "../agents";
import * as skillsTree from "../skills";
import * as toolsTree from "../tools";
import * as modulesTree from "../modules";
import * as pluginsTree from "../plugins";
import * as workflowsTree from "../workflows";
import * as modelsTree from "../models";
import * as systemTree from "../system";
import * as installerTree from "../installer";
import * as updaterTree from "../updater";
import * as builderTree from "../builder";
import * as testingTree from "../testing";

const isModule = (value: unknown): value is FridayModule =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as FridayModule).id === "string" &&
  typeof (value as FridayModule).init === "function";

export type ComponentCandidate<T> = {
  id: string;
  owner: "official" | "user" | "imported" | "managed";
  version: string;
  compatible: boolean;
  healthy: boolean;
  required: boolean;
  item: T;
};

/**
 * One identity. Official and user copies do not share it.
 * Order: requirement, compatibility, trust, version, then a stable id.
 */
export function resolveComponentChoice<T>(
  items: ComponentCandidate<T>[],
): ComponentCandidate<T> | null {
  const compatible = items.filter((item) => item.compatible);
  if (!compatible.length) return null;
  const required = compatible.filter((item) => item.required);
  const pool = required.length ? required : compatible;
  const trust: Record<ComponentCandidate<T>["owner"], number> = {
    official: 3,
    managed: 2,
    user: 1,
    imported: 0,
  };
  return (
    [...pool].sort((left, right) => {
      const health = Number(right.healthy) - Number(left.healthy);
      if (health) return health;
      const owner = trust[right.owner] - trust[left.owner];
      if (owner) return owner;
      const version = right.version.localeCompare(left.version);
      if (version) return version;
      return left.id.localeCompare(right.id);
    })[0] ?? null
  );
}

/** Every FridayModule exported by a barrel, de-duplicated by module id. */
export function collectModules(...barrels: Record<string, unknown>[]): FridayModule[] {
  const found = new Map<string, FridayModule>();
  for (const barrel of barrels) {
    for (const value of Object.values(barrel)) {
      if (!isModule(value)) continue;
      const current = found.get(value.id);
      if (!current) {
        found.set(value.id, value);
        continue;
      }
      const chosen = resolveComponentChoice([
        {
          id: current.id,
          owner: "official",
          version: "1",
          compatible: true,
          healthy: true,
          required: true,
          item: current,
        },
        {
          id: value.id,
          owner: "imported",
          version: "1",
          compatible: true,
          healthy: true,
          required: false,
          item: value,
        },
      ]);
      if (chosen) found.set(value.id, chosen.item);
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Auto-registered folder modules — discovery, probes, installer/updater/build. */
export const TREE_MODULES: FridayModule[] = collectModules(
  agentsTree,
  skillsTree,
  toolsTree,
  modulesTree,
  pluginsTree,
  workflowsTree,
  modelsTree,
  systemTree,
  installerTree,
  updaterTree,
  builderTree,
  testingTree,
);

/** Ordered pipeline stages. Each entry is one architecture folder. */
export const PIPELINE: FridayModule[] = [
  eventBusModule,
  lifecycleModule,
  permissionsModule,
  contextModule,
  intentModule,
  reasoningModule,
  plannerModule,
  decisionModule,
  brainRouterModule,
  providersModule,
  modelRouterModule,
  modelManagerModule,
  // Capability discovery and platform probes boot after the brain stages and
  // before orchestration, so the orchestrator sees a populated registry.
  ...TREE_MODULES,
  orchestrationModule,
  synchronizationModule,
];

/** Boots every module in pipeline order and returns a disposer. */
export async function bootPipeline(ctx: ModuleContext): Promise<() => Promise<void>> {
  const started: FridayModule[] = [];
  for (const mod of PIPELINE) {
    await mod.init(ctx);
    started.push(mod);
    ctx.log("info", `module ready: ${mod.id}`);
  }
  return async () => {
    for (const mod of started.reverse()) await mod.dispose?.();
  };
}
