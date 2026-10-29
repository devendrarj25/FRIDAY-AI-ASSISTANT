/**
 * FRIDAY · environment registry (shared renderer access).
 *
 * ONE accessor for both runtimes:
 *  - Windows EXE: reads the live registry from the main process, which probes
 *    the real machine and can repair components from official sources.
 *  - Browser preview: reads the last registry FRIDAY persisted, so the same
 *    screens keep working without pretending anything is installed.
 *
 * Nothing here invents state: when no registry exists the result is an honest
 * "unknown" with an empty component list.
 */
import { readLocalState, writeState, readDiskState } from "./persist";

export type ComponentHealth = "ready" | "outdated" | "missing" | "broken";

export type EnvComponent = {
  id: string;
  label: string;
  kind: string;
  version: string | null;
  path: string | null;
  health: ComponentHealth;
  source: string | null;
  capability: string[];
  detail: string | null;
  minimum: string | null;
  repairable: boolean;
  optional?: boolean;
  checkedAt: number;
  readySince: number | null;
};

export type EnvRegistry = {
  version: number;
  updatedAt: number | null;
  platform: string;
  ready: boolean;
  blocking: string[];
  components: EnvComponent[];
  registryFile?: string;
};

export type RepairResult = {
  ok: boolean;
  id?: string;
  error?: string;
  component?: EnvComponent | null;
  attempts?: { command: string; code: number | null; output: string }[];
};

export type ReadinessStage = { name: string; ok: boolean; detail: string };
export type ReadinessReport = {
  ok: boolean;
  stages: ReadinessStage[];
  at?: number;
  error?: string;
};

type Bridge = {
  envRegistry?: () => Promise<EnvRegistry>;
  envRefresh?: () => Promise<EnvRegistry>;
  envRepair?: (id?: string | null) => Promise<RepairResult>;
  envReadiness?: () => Promise<ReadinessReport>;
  onEnvRepaired?: (fn: (result: RepairResult) => void) => () => void;
};

const NAMESPACE = "friday.environment";

const bridge = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as Bridge | undefined);

export const environmentBridgeAvailable = () => Boolean(bridge()?.envRefresh);

const EMPTY: EnvRegistry = {
  version: 1,
  updatedAt: null,
  platform: "browser",
  ready: false,
  blocking: [],
  components: [],
};

/** Last known registry — instant, never blocks a render. */
export function cachedEnvironment(): EnvRegistry {
  return readLocalState<EnvRegistry>(NAMESPACE) ?? EMPTY;
}

/** Live registry in the desktop app; the persisted copy in the browser. */
export async function readEnvironment(): Promise<EnvRegistry> {
  const desktop = bridge()?.envRegistry;
  if (desktop) {
    const registry = await desktop();
    if (registry?.components?.length) writeState(NAMESPACE, registry);
    return registry ?? EMPTY;
  }
  return (await readDiskState<EnvRegistry>(NAMESPACE)) ?? cachedEnvironment();
}

/** Re-probe the machine (desktop only) and persist the result for both modes. */
export async function refreshEnvironment(): Promise<EnvRegistry> {
  const desktop = bridge()?.envRefresh;
  if (!desktop) return readEnvironment();
  const registry = await desktop();
  writeState(NAMESPACE, registry);
  return registry;
}

/** Repair one component, or everything that is blocking when no id is given. */
export async function repairEnvironment(id?: string): Promise<RepairResult> {
  const desktop = bridge()?.envRepair;
  if (!desktop) {
    return { ok: false, error: "Dependency repair runs in the installed FRIDAY desktop app." };
  }
  const result = await desktop(id ?? null);
  await refreshEnvironment();
  return result;
}

/** Full in-app readiness run: kernel, database, chat, voice, model, task. */
export async function runReadinessCheck(): Promise<ReadinessReport> {
  const desktop = bridge()?.envReadiness;
  if (!desktop) {
    return { ok: false, stages: [], error: "Readiness testing runs in the FRIDAY desktop app." };
  }
  return desktop();
}

export const onEnvironmentRepaired = (fn: (result: RepairResult) => void) =>
  bridge()?.onEnvRepaired?.(fn);
