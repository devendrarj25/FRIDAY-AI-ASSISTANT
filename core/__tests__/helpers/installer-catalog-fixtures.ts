/**
 * Real `installer:catalog` payloads for tests: the main process's own catalogue (electron/installer-catalog.cjs) run
 * against fake PCs and a fixed clock, so the pages are tested against what the backend actually returns.
 */
import { createRequire } from "node:module";
import path from "node:path";
import type { InstallerCatalog, InstallerCatalogRow } from "../../../src/lib/friday/desktop";
import { makeTemp, removeTemp } from "./temp-dir";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../../..");
const cat = require_(path.join(root, "electron/installer-catalog.cjs"));
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const runnersFile = require_(path.join(root, "config/local-runners.json")) as {
  runners: unknown[];
};

export const FIXED_NOW = 1_800_000_000_000;

type Facts = Record<string, unknown>;

/** A 16 GB laptop with no usable graphics card. */
export const NO_GPU_PC: Facts = {
  ramGb: 16,
  ramFreeGb: 10,
  diskFreeGb: 200,
  gpus: [],
  sources: ["os-memory"],
  os: { is64Bit: true },
  cpu: { avx2: true },
  modelDrive: { freeGb: 200 },
  cuda: {},
  network: { online: true },
  power: { onAc: true },
  vulkan: false,
  memory: { pressure: "ok" },
};

/** A desktop with a 16 GB NVIDIA card; the CUDA runtime libraries are not installed yet. */
export const NVIDIA_16GB_PC: Facts = {
  ...NO_GPU_PC,
  vramGb: 16,
  vramFreeGb: 15,
  gpuVendor: "nvidia",
  gpuName: "NVIDIA GeForce RTX",
  gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX", vramGb: 16, driver: "576.80" }],
  cudaReady: true,
  driverVersion: "576.80",
  sources: ["nvidia-smi", "os-memory"],
  vulkan: true,
  cuda: { driverCuda: "12.9", cublas12: false, cudnn9: false, runtimeFilesFound: false },
};

export function realCatalog(
  facts: Facts,
  over: {
    detected?: { id: string; installed: boolean; version?: string }[];
    privacy?: boolean;
    online?: boolean | null;
  } = {},
): InstallerCatalog {
  const dir = makeTemp("friday-fit-");
  try {
    const catalog = cat.createInstallerCatalog({
      root: () => dir,
      facts: () => facts,
      tools: () => toolchain.TOOLS,
      detected: () => ({ tools: over.detected ?? [] }),
      packs: () => [],
      runners: () => runnersFile.runners,
      online: () => (over.online === undefined ? true : over.online),
      privacy: () => Boolean(over.privacy),
      now: () => FIXED_NOW,
    });
    return catalog.snapshot() as InstallerCatalog;
  } finally {
    removeTemp(dir);
  }
}

/** Replace some rows of a catalogue and keep `split` and `counts` in step, the way the backend builds them. */
export function withRows(
  catalog: InstallerCatalog,
  patch: Record<string, Partial<InstallerCatalogRow>>,
  extra: Partial<InstallerCatalog> = {},
): InstallerCatalog {
  const rows = catalog.rows.map((row) => (patch[row.id] ? { ...row, ...patch[row.id] } : row));
  const split = { supported: [] as string[], limited: [] as string[], unsupported: [] as string[] };
  for (const row of rows) split[row.fit.state].push(row.id);
  return {
    ...catalog,
    rows,
    split,
    counts: {
      rows: rows.length,
      updates: rows.filter((r) => r.updateStatus === "update").length,
      errors: rows.filter((r) => r.updateStatus === "error").length,
      stale: rows.filter((r) => r.stale).length,
    },
    ...extra,
  };
}

/** A small hand-made row for a table test. */
export function fakeRow(over: Partial<InstallerCatalogRow> = {}): InstallerCatalogRow {
  return {
    id: "ripgrep",
    kind: "tool",
    name: "ripgrep",
    category: "Dev",
    optional: false,
    installed: false,
    installedVersion: null,
    latestVersion: "14.2.0",
    updateStatus: "unknown",
    source: "github-api",
    checkedAt: FIXED_NOW - 180_000,
    stale: false,
    pinnedAnswer: false,
    fit: {
      state: "supported",
      reasons: [],
      needs: {
        ramGb: null,
        vramGb: null,
        diskGb: null,
        cuda: false,
        driverMin: null,
        vulkan: false,
        avx2: false,
        network: true,
        downloadGb: null,
      },
      recommended: false,
    },
    ...over,
  };
}
