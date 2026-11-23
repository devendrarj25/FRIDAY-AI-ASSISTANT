/**
 * The shared hardware facts reach the voice budget and the Doctor "This PC" rows: the `hardware:facts` channel runs
 * from the renderer API through the preload allowlist and the budget table to the main handler, `voice:budget` and
 * `voice:verify` hand the resolved facts to `probeHardware`, and `thisPcRows` reports them (or loading, offline,
 * error) without inventing a number. Fake facts only: no GPU, no network, no real PC.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HardwareFacts } from "../../src/lib/friday/desktop";
import { cudaReasonLine, thisPcRows } from "../../src/lib/friday/voice-diagnostics-rows";

const require = createRequire(import.meta.url);
const root = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
const table = require("../../electron/ipc-budget-table.cjs") as {
  CHANNEL_CLASS: Record<string, string>;
};
const weights = require("../../electron/voice-weights.cjs") as {
  probeHardware: (deps?: Record<string, unknown>) => {
    gpu: { vramGb: number; cudaRuntimeReady: boolean };
  };
  voiceInstallPlan: (
    root: string,
    probe: unknown,
    deps?: Record<string, unknown>,
  ) => { budget: { sttSize: string; speechBudgetGb: number } };
};

const facts = (extra: Partial<HardwareFacts> = {}): HardwareFacts => ({
  vramGb: null,
  vramFreeGb: null,
  ramGb: 16,
  ramFreeGb: 9.5,
  diskFreeGb: 120,
  gpuVendor: null,
  gpuName: null,
  gpus: [],
  cudaReady: false,
  driverVersion: null,
  npu: false,
  cpuClass: "mid",
  sources: ["os-memory-live", "model-drive"],
  ...extra,
});
const nvidia16 = facts({
  vramGb: 16,
  vramFreeGb: 12.4,
  ramGb: 32,
  ramFreeGb: 20,
  gpuVendor: "nvidia",
  gpuName: "NVIDIA Test Card",
  gpus: [
    { vendor: "nvidia", name: "NVIDIA Test Card", vramGb: 16, vramCapped: false, driver: "552.22" },
  ],
  cudaReady: true,
  driverVersion: "552.22",
  cpuClass: "high",
  sources: ["nvidia-smi", "electron-gpuInfo", "os-memory-live", "model-drive"],
});
const rowOf = (rows: ReturnType<typeof thisPcRows>, part: string) =>
  rows.find((row) => row.label.includes(part));

describe("hardware:facts IPC chain", () => {
  it("is typed in desktop.ts, allowlisted in preload, quick in the budget table and handled in main", () => {
    expect(read("src/lib/friday/desktop.ts")).toMatch(
      /hardwareFacts\?: \(\s*force\?: boolean,?\s*\) => Promise<\{[^}]*facts\?: HardwareFacts/,
    );
    expect(read("electron/preload.cjs")).toMatch(
      /hardwareFacts: \(force\) => ipcRenderer\.invoke\("hardware:facts", force === true\)/,
    );
    expect(table.CHANNEL_CLASS["hardware:facts"]).toBe("quick");
    const main = read("electron/main.cjs");
    expect(main).toMatch(
      /ipcMain\.handle\("hardware:facts", async \(_e, force\) => \{\s*try \{\s*return \{ ok: true, facts: await currentHardwareFacts\(force === true\) \}/,
    );
    expect(main.match(/ipcMain\.handle\("hardware:facts"/g)?.length).toBe(1);
  });

  it("never throws and returns no secret: the handler catches and the facts carry only measured fields", () => {
    const main = read("electron/main.cjs");
    const handler = /ipcMain\.handle\("hardware:facts"[\s\S]*?\n\}\);/.exec(main)?.[0] ?? "";
    expect(handler).toContain("catch (error)");
    expect(handler).toContain("ok: false");
    expect(handler).not.toMatch(/api_key|token|secret|password/i);
    const fn = /async function currentHardwareFacts[\s\S]*?\n\}\n/.exec(main)?.[0] ?? "";
    expect(fn.match(/catch \{/g)?.length).toBe(2);
    expect(fn).toContain("return routingHardwareFacts()");
  });

  it("keeps hardware:detect on the same cached job", () => {
    const main = read("electron/main.cjs");
    expect(main).toMatch(
      /ipcMain\.handle\("hardware:detect", \(_e, force = false\) => detectHardwareCached\(force\)\)/,
    );
  });
});

describe("voice:budget and voice:verify receive the shared facts", () => {
  it("voice:budget resolves the facts first, passes them to probeHardware and the resident model memory to the budget", () => {
    const main = read("electron/main.cjs");
    const handler = /ipcMain\.handle\("voice:budget"[\s\S]*?\n\}\);/.exec(main)?.[0] ?? "";
    expect(handler).toContain("const facts = await currentHardwareFacts();");
    expect(handler).toContain("const llmResidentVramGb = await residentLlmVramGb();");
    expect(handler).toContain(
      "weights.probeHardware({ gpuInfo, hardwareFacts: () => facts, cudaRuntimeReady })",
    );
    expect(handler).toMatch(
      /budgetForProbe\(probe, llmResidentVramGb > 0 \? \{ llmResidentVramGb \} : \{\}\)/,
    );
  });

  it("voice:verify passes the resolved facts and lets them override anything the renderer sent", () => {
    const main = read("electron/main.cjs");
    const handler = /ipcMain\.handle\("voice:verify"[\s\S]*?\n\}\);/.exec(main)?.[0] ?? "";
    expect(handler).toMatch(
      /\.\.\.\(payload \|\| \{\}\),\s*hardwareFacts: \(\) => facts,\s*llmResidentVramGb,\s*cudaRuntimeReady,/,
    );
    const verify = read("electron/voice-verify.cjs");
    expect(verify).toMatch(
      /\.\.\.\(typeof hardwareFacts === "function" \? \{ hardwareFacts \} : \{\}\)/,
    );
    expect(verify).toMatch(/cudaRuntimeReady === true \? \{ cudaRuntimeReady: true \} : \{\}/);
  });

  it("the resident model memory comes from the local engine's running list and is 0 when unknown", () => {
    const main = read("electron/main.cjs");
    const fn = /async function residentLlmVramGb[\s\S]*?\n\}\n/.exec(main)?.[0] ?? "";
    expect(fn).toContain("modelsApi.ollamaRunning()");
    expect(fn).toContain("return 0;");
  });

  it("the facts change the budget: a 16 GB NVIDIA card with CUDA ready listens on the GPU, no GPU stays on the CPU", () => {
    const os = {
      totalmem: () => 32 * 1024 ** 3,
      freemem: () => 20 * 1024 ** 3,
      cpus: () => new Array(16).fill({}),
      platform: () => "win32",
    };
    const noSmi = (): string => {
      throw new Error("no nvidia-smi");
    };
    // The facts' cudaReady is the NVIDIA driver only: the GPU size needs the kernel's own runtime verdict too.
    const driverProbe = weights.probeHardware({
      os,
      nvidiaSmi: noSmi,
      hardwareFacts: () => nvidia16,
    });
    expect(driverProbe.gpu.cudaRuntimeReady).toBe(false);
    expect(
      weights.voiceInstallPlan("", driverProbe, { exists: () => false }).budget.sttSize,
    ).not.toBe("large-v3-turbo");
    const gpuProbe = weights.probeHardware({
      os,
      nvidiaSmi: noSmi,
      hardwareFacts: () => nvidia16,
      cudaRuntimeReady: true,
    });
    expect(gpuProbe.gpu.vramGb).toBe(16);
    expect(gpuProbe.gpu.cudaRuntimeReady).toBe(true);
    const gpuPlan = weights.voiceInstallPlan("", gpuProbe, { exists: () => false });
    const cpuProbe = weights.probeHardware({ os, nvidiaSmi: noSmi, hardwareFacts: () => facts() });
    const cpuPlan = weights.voiceInstallPlan("", cpuProbe, { exists: () => false });
    expect(gpuPlan.budget.sttSize).toBe("large-v3-turbo");
    expect(cpuPlan.budget.sttSize).not.toBe("large-v3-turbo");
    const unmeasuredFree = weights.probeHardware({
      os,
      nvidiaSmi: noSmi,
      hardwareFacts: () => ({ ...nvidia16, vramFreeGb: null }),
      cudaRuntimeReady: true,
    });
    const crowded = weights.voiceInstallPlan("", unmeasuredFree, {
      exists: () => false,
      llmResidentVramGb: 14,
    });
    expect(crowded.budget.sttSize).not.toBe("large-v3-turbo");
  });
});

describe("This PC rows", () => {
  it("shows an NVIDIA 16 GB card with CUDA ready, memory, disk, CPU class and the probes that agreed", () => {
    const rows = thisPcRows({ phase: "ready", facts: nvidia16 });
    expect(rows).toHaveLength(7);
    expect(rowOf(rows, "graphics card")?.value).toBe("NVIDIA Test Card");
    expect(rowOf(rows, "video memory")?.value).toBe("16 GB · 12.4 GB");
    expect(rowOf(rows, "CUDA ready")?.value).toMatch(/^yes: .*552\.22.*CUDA 12/);
    expect(rowOf(rows, "this PC: memory")?.value).toBe("32 GB · 20 GB");
    expect(rowOf(rows, "model drive")?.value).toBe("120 GB");
    expect(rowOf(rows, "processor class")?.value).toBe("high");
    expect(rowOf(rows, "probes")?.value).toBe(
      "nvidia-smi · electron-gpuInfo · os-memory-live · model-drive",
    );
    expect(rows.some((row) => row.bad)).toBe(false);
  });

  it("says no GPU was found and measures nothing it was not given", () => {
    const rows = thisPcRows({ phase: "ready", facts: facts() });
    expect(rowOf(rows, "graphics card")).toMatchObject({ value: "no GPU found", bad: true });
    expect(rowOf(rows, "video memory")?.value).toBe("not measured · not measured");
    expect(rowOf(rows, "CUDA ready")?.value).toBe("no: no GPU was found");
  });

  it("names the reason CUDA is not ready", () => {
    const amd = facts({
      gpuVendor: "amd",
      gpus: [{ vendor: "amd", name: "AMD Card", vramGb: 8, vramCapped: false, driver: "31.0" }],
    });
    expect(cudaReasonLine(amd)).toBe("no: the GPU is not NVIDIA, so CUDA does not apply");
    const noDriver = facts({
      gpuVendor: "nvidia",
      gpus: [{ vendor: "nvidia", name: "N", vramGb: 8, vramCapped: false, driver: null }],
    });
    expect(cudaReasonLine(noDriver)).toBe("no: no NVIDIA driver version could be read");
    const old = facts({
      gpuVendor: "nvidia",
      driverVersion: "472.12",
      gpus: [{ vendor: "nvidia", name: "N", vramGb: 8, vramCapped: false, driver: "472.12" }],
    });
    expect(cudaReasonLine(old)).toMatch(/472\.12 does not report CUDA 12 \(driver 527 or newer/);
  });

  it("flags a nearly full model drive and an empty probe list", () => {
    const rows = thisPcRows({ phase: "ready", facts: facts({ diskFreeGb: 2, sources: [] }) });
    expect(rowOf(rows, "model drive")).toMatchObject({ value: "2 GB", bad: true });
    expect(rowOf(rows, "probes")?.bad).toBe(true);
  });

  it("says loading, offline and error on every row, and the error points at refresh", () => {
    for (const view of [
      { phase: "loading" as const },
      { phase: "offline" as const },
      { phase: "error" as const, message: "no answer" },
    ]) {
      const rows = thisPcRows(view);
      expect(rows).toHaveLength(7);
      expect(new Set(rows.map((row) => row.value)).size).toBe(1);
    }
    expect(thisPcRows({ phase: "offline" })[0]?.value).toBe("shown in the installed FRIDAY app");
    const err = thisPcRows({ phase: "error", message: "timed out" });
    expect(err[0]).toMatchObject({ bad: true });
    expect(err[0]?.value).toContain("timed out");
    expect(err[0]?.value).toContain("refresh this PC");
  });

  it("the Voice diagnostics page reads the facts once, refreshes on its button and runs no timer", () => {
    const page = read("src/components/friday/VoiceDiagnostics.tsx");
    expect(page).toContain("api.hardwareFacts(force)");
    expect(page).toContain("...thisPcRows(pc)");
    expect(page).toContain("refresh this PC");
    expect(page).not.toMatch(/setInterval|setTimeout/);
  });
});
