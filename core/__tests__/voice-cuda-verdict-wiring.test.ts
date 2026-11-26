/**
 * The speech kernel's own CUDA verdict (kernel/stt.py `cuda_runtime_ready`: cuBLAS 12 and cuDNN 9 found) travels from
 * the kernel status to electron/stt.cjs, into `voice:budget` and `voice:verify`, and out to the Voice Diagnostics rows.
 * The NVIDIA driver alone never picks a GPU size. Fake facts and fake status only: no GPU, no worker, no network.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HardwareFacts, VoiceBudget } from "../../src/lib/friday/desktop";
import { speechWorkerRows, thisPcRows } from "../../src/lib/friday/voice-diagnostics-rows";

const require = createRequire(import.meta.url);
const root = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
const stt = require("../../electron/stt.cjs") as {
  cudaRuntimeVerdict: (deps?: {
    statusFn?: (force?: boolean) => Promise<unknown>;
    timeoutMs?: number;
  }) => Promise<boolean>;
};
const weights = require("../../electron/voice-weights.cjs") as {
  probeHardware: (deps?: Record<string, unknown>) => unknown;
  budgetForProbe: (probe: unknown, options?: Record<string, unknown>) => VoiceBudget;
};

const os = {
  totalmem: () => 32 * 1024 ** 3,
  freemem: () => 20 * 1024 ** 3,
  cpus: () => new Array(16).fill({}),
  platform: () => "win32",
};
const noSmi = (): string => {
  throw new Error("no nvidia-smi");
};
const nvidia16: HardwareFacts = {
  vramGb: 16,
  vramFreeGb: 12.4,
  ramGb: 32,
  ramFreeGb: 20,
  diskFreeGb: 120,
  gpuVendor: "nvidia",
  gpuName: "NVIDIA Test Card",
  gpus: [
    { vendor: "nvidia", name: "NVIDIA Test Card", vramGb: 16, vramCapped: false, driver: "552.22" },
  ],
  cudaReady: true,
  driverVersion: "552.22",
  npu: false,
  cpuClass: "high",
  sources: ["nvidia-smi", "electron-gpuInfo"],
};
const budgetWith = (cudaRuntimeReady?: boolean) =>
  weights.budgetForProbe(
    weights.probeHardware({
      os,
      nvidiaSmi: noSmi,
      hardwareFacts: () => nvidia16,
      ...(cudaRuntimeReady === undefined ? {} : { cudaRuntimeReady }),
    }),
  );

describe("stt.cjs cudaRuntimeVerdict", () => {
  it("is true only when the cached or probed status says the kernel verdict is true", async () => {
    expect(
      await stt.cudaRuntimeVerdict({ statusFn: async () => ({ cudaRuntimeReady: true }) }),
    ).toBe(true);
    expect(
      await stt.cudaRuntimeVerdict({ statusFn: async () => ({ cudaRuntimeReady: false }) }),
    ).toBe(false);
    // An older worker, a missing field, a truthy non-boolean and a null status all stay on the CPU.
    expect(await stt.cudaRuntimeVerdict({ statusFn: async () => ({}) })).toBe(false);
    expect(
      await stt.cudaRuntimeVerdict({ statusFn: async () => ({ cudaRuntimeReady: "yes" }) }),
    ).toBe(false);
    expect(await stt.cudaRuntimeVerdict({ statusFn: async () => null })).toBe(false);
  });

  it("reads status without forcing a new probe, and never throws or hangs", async () => {
    const seen: unknown[] = [];
    await stt.cudaRuntimeVerdict({
      statusFn: async (force) => {
        seen.push(force);
        return { cudaRuntimeReady: true };
      },
    });
    expect(seen).toEqual([false]);
    expect(
      await stt.cudaRuntimeVerdict({
        statusFn: async () => {
          throw new Error("python missing");
        },
      }),
    ).toBe(false);
    expect(
      await stt.cudaRuntimeVerdict({
        statusFn: () => new Promise(() => {}),
        timeoutMs: 20,
      }),
    ).toBe(false);
  });

  it("copies the verdict from the kernel answer and keeps it across worker reloads (source shape)", () => {
    const source = read("electron/stt.cjs");
    expect(source).toMatch(
      /typeof parsed\.cudaRuntimeReady === "boolean"\)\s*lastLocalLayers\.cudaRuntimeReady = parsed\.cudaRuntimeReady/,
    );
    expect(source).toMatch(/value\.cudaRuntimeReady = Boolean\(layers\.cudaRuntimeReady\)/);
    expect(
      source.match(/cudaRuntimeReady: Boolean\(lastLocalLayers\.cudaRuntimeReady\)/g),
    ).toHaveLength(2);
    expect(source).toMatch(/module\.exports = \{\s*status,\s*cudaRuntimeVerdict,/);
  });

  it("the kernel status payload carries the field (kernel/tests/test_stt_cuda_status.py runs it)", () => {
    expect(read("kernel/stt.py")).toMatch(/"cudaRuntimeReady": cuda_ready,/);
  });
});

describe("voice:budget and voice:verify forward the kernel verdict", () => {
  it("both handlers ask stt.cudaRuntimeVerdict and pass it on, never a driver reading", () => {
    const main = read("electron/main.cjs");
    const budget = /ipcMain\.handle\("voice:budget"[\s\S]*?\n\}\);/.exec(main)?.[0] ?? "";
    expect(budget).toMatch(/const cudaRuntimeReady = await stt\.cudaRuntimeVerdict\(\)/);
    expect(budget).toMatch(
      /probeHardware\(\{ gpuInfo, hardwareFacts: \(\) => facts, cudaRuntimeReady \}\)/,
    );
    const verify = /ipcMain\.handle\("voice:verify"[\s\S]*?\n\}\);/.exec(main)?.[0] ?? "";
    expect(verify).toMatch(/const cudaRuntimeReady = await stt\.cudaRuntimeVerdict\(\)/);
    expect(verify).toMatch(
      /hardwareFacts: \(\) => facts,\s*llmResidentVramGb,\s*cudaRuntimeReady,/,
    );
    const file = read("electron/voice-verify.cjs");
    expect(file).toMatch(/hardwareFacts,\s*cudaRuntimeReady,\s*llmResidentVramGb,/);
    expect(file).toMatch(/cudaRuntimeReady === true \? \{ cudaRuntimeReady: true \} : \{\}/);
  });

  it("scripts/prefetch-models.cjs asks the speech kernel for the verdict at setup (owner approved 2026-11-23)", () => {
    const file = read("scripts/prefetch-models.cjs");
    expect(file).toMatch(/function setupCudaVerdict\(/);
    expect(file).toMatch(/cudaRuntimeReady: true/);
    // The setup plan reads the very probe that carries the kernel verdict, built from the same measured facts.
    expect(file).toMatch(
      /voiceProbe: options\.probe \|\| setupProbe\(env, \{ hardwareFacts: \(\) => facts \}\)/,
    );
    expect(file).toMatch(/\.\.\.\(probe \? \{ probe \} : \{\}\)/);
    expect(file).toMatch(/voiceInstallPlan\(root, setupProbe\(process\.env\)/);
  });

  it("verdict true picks the GPU size; false (or absent) is the CPU default plus the upgrade offer", () => {
    const gpu = budgetWith(true);
    expect(gpu.sttDevice).toBe("cuda");
    expect(gpu.sttSize).toBe("large-v3-turbo");
    expect(gpu).not.toHaveProperty("gpuUpgrade");
    for (const verdict of [false, undefined]) {
      const cpu = budgetWith(verdict);
      expect(cpu.sttDevice).not.toBe("cuda");
      expect(cpu.sttSize).not.toBe("large-v3-turbo");
      expect(cpu.gpuUpgrade).toMatchObject({ needs: "cuda-runtime" });
      expect(cpu.gpuUpgrade?.detail).toContain("cuBLAS 12, cuDNN 9");
    }
  });
});

describe("Voice Diagnostics rows for the GPU verdict", () => {
  const rows = (budget: VoiceBudget | null) =>
    speechWorkerRows({ phase: "ready", cache: null, budget });
  const gpuRow = (list: ReturnType<typeof rows>) => list.find((row) => row.label === "GPU speech");

  it("shows the upgrade detail, and that a driver alone is never called working, when gpuUpgrade is set", () => {
    const row = gpuRow(rows(budgetWith(false)));
    expect(row?.value).toContain(
      "found; install the CUDA runtime libraries (cuBLAS 12, cuDNN 9) to use it for speech",
    );
    expect(row?.value).toMatch(/never calls CUDA working from the driver alone/);
  });

  it("shows the GPU size as on when the kernel confirmed the libraries, and no row for a plain CPU budget", () => {
    expect(gpuRow(rows(budgetWith(true)))?.value).toMatch(
      /on .*cuBLAS 12 and cuDNN 9.*large-v3-turbo/,
    );
    const cpuOnly = weights.budgetForProbe(
      weights.probeHardware({ os, nvidiaSmi: noSmi, hardwareFacts: () => null }),
    );
    expect(cpuOnly.gpuUpgrade).toBeUndefined();
    expect(gpuRow(rows(cpuOnly))).toBeUndefined();
    expect(gpuRow(rows(null))).toBeUndefined();
  });

  it("keeps the row with the worker cache present, and out of the loading, offline and error states", () => {
    const withCache = speechWorkerRows({
      phase: "ready",
      cache: {
        loadedModels: [],
        idleSec: null,
        unloadCount: 0,
        memory: { level: "ok", known: true, availableMb: 8000, totalMb: 16000 },
        fallbacks: { total: 0, byKind: {} },
      },
      budget: budgetWith(false),
    });
    expect(gpuRow(withCache)).toBeDefined();
    for (const view of [
      { phase: "loading" as const },
      { phase: "offline" as const },
      { phase: "error" as const, message: "x" },
    ]) {
      expect(gpuRow(speechWorkerRows(view))).toBeUndefined();
    }
  });

  it("renders a null processor class as a dash and a known one as is", () => {
    const row = (cpuClass: HardwareFacts["cpuClass"]) =>
      thisPcRows({ phase: "ready", facts: { ...nvidia16, cpuClass } }).find((r) =>
        r.label.includes("processor class"),
      )?.value;
    expect(row(null)).toBe("–");
    expect(row("mid")).toBe("mid");
  });

  it("types vramCapped, a nullable cpuClass and gpuUpgrade in desktop.ts", () => {
    const desktop = read("src/lib/friday/desktop.ts");
    expect(desktop).toMatch(/vramCapped: boolean;/);
    expect(desktop).toMatch(/cpuClass: "low" \| "mid" \| "high" \| null;/);
    expect(desktop).toMatch(
      /gpuUpgrade\?: \{ needs: "cuda-runtime"; vramGb: number; detail: string \}/,
    );
  });
});
