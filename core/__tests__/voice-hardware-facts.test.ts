/**
 * Voice profile selection from the shared detected hardware facts: a table of fake fact sets gives the profile, the
 * speech size, the device and the resident cap. `electron/voice-weights.cjs` `probeHardware` merges
 * `deps.hardwareFacts`; `budgetFor` decides from video memory, memory, CUDA readiness and the CPU class (never a GPU
 * name); `hardware-profile.ts` must give the same answer. Fake devices only: no GPU, no network, no weights.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  budgetFor as tsBudgetFor,
  type BudgetGpu,
} from "../../src/lib/friday/voice-engine/hardware-profile";

const require_ = createRequire(import.meta.url);

type Facts = Record<string, unknown>;
type Probe = {
  totalRamGb: number;
  freeRamGb: number;
  cpuThreads: number;
  cpuClass?: string;
  gpu: BudgetGpu & { name: string; vramGb: number; source: string; cudaRuntimeReady: boolean };
};
type Budget = {
  profile: string;
  sttSize: string;
  sttDevice: string;
  sttCompute: string;
  allowedSizes: string[];
  speechBudgetGb: number;
  maxResidentModels: number;
  notes: string[];
};
const weights = require_("../../electron/voice-weights.cjs") as {
  probeHardware: (deps?: Record<string, unknown>) => Probe;
  budgetForProbe: (probe: Probe, options?: Record<string, unknown>) => Budget;
  voiceInstallPlan: (root: string, probe: Probe, deps?: Record<string, unknown>) => unknown;
  budgetFor: (
    total: number,
    free: number,
    vram: number,
    gpu?: BudgetGpu,
    options?: Record<string, unknown>,
  ) => Budget;
};

const fakeOs = (totalGb: number, freeGb: number, threads = 8) => ({
  totalmem: () => totalGb * 1024 ** 3,
  freemem: () => freeGb * 1024 ** 3,
  cpus: () => new Array(threads).fill({}),
  platform: () => "win32",
});
const noSmi = (): string => {
  throw new Error("nvidia-smi not found");
};
// `kernelCuda` is the kernel's own verdict (kernel/stt.py cuda_runtime_ready: cuBLAS 12 and cuDNN 9 found). The shared
// facts' `cudaReady` only says the NVIDIA driver can run CUDA 12 programs, so it never counts as that verdict.
const probeWith = (
  facts: Facts | (() => unknown),
  totalGb = 16,
  freeGb = 10,
  smi = noSmi,
  kernelCuda = false,
) =>
  weights.probeHardware({
    os: fakeOs(totalGb, freeGb),
    hardwareFacts: typeof facts === "function" ? facts : () => facts,
    nvidiaSmi: smi,
    ...(kernelCuda ? { cudaRuntimeReady: true } : {}),
  });
// A PC whose driver AND runtime libraries are present: the driver's facts plus the kernel's yes.
const verifiedProbe = (facts: Facts, totalGb = 16, freeGb = 10) =>
  probeWith(facts, totalGb, freeGb, noSmi, true);
const gpuFacts = (vramGb: number, extra: Facts = {}): Facts => ({
  vramGb,
  gpuVendor: "any",
  gpuName: "Some Graphics Card",
  cudaReady: true,
  sources: ["nvidia-smi"],
  ...extra,
});

describe("profile from detected facts (a table of fake PCs)", () => {
  // [label, facts, total RAM, free RAM, profile, size, device, compute]
  const table: [string, Facts, number, number, string, string, string, string][] = [
    ["6 GB GPU, CUDA ready", gpuFacts(6), 16, 10, "quality", "medium", "cuda", "float16"],
    ["8 GB GPU, CUDA ready", gpuFacts(8), 16, 10, "quality", "large-v3-turbo", "cuda", "float16"],
    ["12 GB GPU, CUDA ready", gpuFacts(12), 16, 10, "quality", "large-v3-turbo", "cuda", "float16"],
    ["16 GB GPU, CUDA ready", gpuFacts(16), 32, 20, "quality", "large-v3-turbo", "cuda", "float16"],
    ["24 GB GPU, CUDA ready", gpuFacts(24), 32, 20, "quality", "large-v3-turbo", "cuda", "float16"],
    [
      "8 GB GPU, CUDA not ready",
      gpuFacts(8, { cudaReady: false }),
      16,
      10,
      "balanced",
      "small",
      "cpu",
      "int8",
    ],
    [
      "CPU only, 16 GB",
      { cudaReady: false, sources: [] },
      16,
      10,
      "balanced",
      "small",
      "cpu",
      "int8",
    ],
    [
      "CPU only, low-end processor",
      { cudaReady: false, cpuClass: "low" },
      16,
      10,
      "lite",
      "base",
      "cpu",
      "int8",
    ],
    ["CPU only, 8 GB", { cudaReady: false }, 8, 5, "balanced", "small", "cpu", "int8"],
    ["CPU only, 4 GB", { cudaReady: false }, 4, 2.5, "lite", "base", "cpu", "int8"],
    ["8 GB GPU but 8 GB RAM", gpuFacts(8), 8, 5, "balanced", "small", "cuda", "float16"],
    ["2 GB GPU, CUDA ready", gpuFacts(2), 16, 10, "balanced", "small", "cpu", "int8"],
    [
      "8 GB GPU with 1.5 GB free (a model is resident)",
      gpuFacts(8, { vramFreeGb: 1.5 }),
      16,
      10,
      "balanced",
      "small",
      "cpu",
      "int8",
    ],
    [
      "12 GB GPU with 6 GB free",
      gpuFacts(12, { vramFreeGb: 6 }),
      16,
      10,
      "quality",
      "medium",
      "cuda",
      "float16",
    ],
    [
      "24 GB GPU with 8 GB free",
      gpuFacts(24, { vramFreeGb: 8 }),
      32,
      20,
      "quality",
      "large-v3-turbo",
      "cuda",
      "float16",
    ],
  ];
  for (const [label, facts, total, free, profile, size, device, compute] of table) {
    it(`${label} -> ${profile} / ${size} / ${device}`, () => {
      // "CUDA ready" in this table means the driver and the kernel's runtime check both say yes
      const probe = probeWith(facts, total, free, noSmi, facts["cudaReady"] === true);
      const b = weights.budgetForProbe(probe);
      expect(b).toMatchObject({ profile, sttSize: size, sttDevice: device, sttCompute: compute });
      expect(b.maxResidentModels).toBe(2);
      expect(b.speechBudgetGb).toBeLessThanOrEqual(4);
      // the Models page table gives the same answer from the same probe
      expect(
        tsBudgetFor(probe.totalRamGb, probe.freeRamGb, probe.gpu.vramGb, probe.gpu, {
          cpuThreads: probe.cpuThreads,
          ...(probe.cpuClass ? { cpuClass: probe.cpuClass } : {}),
        }),
      ).toEqual(b);
      // the GPU only ever carries a size the ladder allows, and never the biggest one on its own
      expect(b.allowedSizes[b.allowedSizes.length - 1]).toBe(size);
      expect(b.allowedSizes).not.toContain("large-v3");
    });
  }

  it("a CPU-only PC never gets a GPU size, whatever its processor class", () => {
    for (const cpuClass of ["low", "mid", "high", "unknown", undefined]) {
      const b = weights.budgetForProbe(probeWith({ cudaReady: false, cpuClass }, 32, 24));
      expect(b.sttDevice).toBe("cpu");
      expect(["tiny", "base", "small"]).toContain(b.sttSize);
    }
  });

  it("never matches a GPU by name: the same numbers give the same profile", () => {
    const a = weights.budgetForProbe(verifiedProbe(gpuFacts(8, { gpuName: "NVIDIA RTX 4060" })));
    const b = weights.budgetForProbe(
      verifiedProbe(gpuFacts(8, { gpuName: "Unheard Of Card 9000" })),
    );
    expect(a).toEqual(b);
  });

  it("a resident language model's expected footprint narrows the GPU size when no free reading exists", () => {
    const probe = verifiedProbe(gpuFacts(8));
    expect(weights.budgetForProbe(probe).sttSize).toBe("large-v3-turbo");
    const crowded = weights.budgetForProbe(probe, { llmResidentVramGb: 6 });
    expect(crowded.sttDevice).toBe("cpu");
    expect(crowded.notes.join(" ")).toMatch(/usable beside what is already resident/);
    const roomy = weights.budgetForProbe(verifiedProbe(gpuFacts(24), 32, 20), {
      llmResidentVramGb: 10,
    });
    expect(roomy.sttSize).toBe("large-v3-turbo");
    const mid = weights.budgetForProbe(verifiedProbe(gpuFacts(12), 16, 10), {
      llmResidentVramGb: 6,
    });
    expect(mid.sttSize).toBe("medium");
    // a measured free reading already counts the resident model: it is not subtracted twice
    const measured = weights.budgetForProbe(
      verifiedProbe(gpuFacts(24, { vramFreeGb: 14 }), 32, 20),
      {
        llmResidentVramGb: 10,
      },
    );
    expect(measured.sttSize).toBe("large-v3-turbo");
  });
});

describe("probeHardware merges the shared facts", () => {
  it("is exactly today's read when deps.hardwareFacts is absent", () => {
    const probe = weights.probeHardware({
      os: fakeOs(16, 9.5),
      nvidiaSmi: () => "NVIDIA GeForce GTX 1660, 6144\n",
    });
    expect(probe.gpu).toMatchObject({ vramGb: 6, source: "nvidia-smi", cudaRuntimeReady: false });
    expect(probe.gpu).not.toHaveProperty("vramFreeGb");
    expect(probe).not.toHaveProperty("cpuClass");
  });

  it("ignores facts that throw, answer late (a promise) or are not an object", () => {
    for (const facts of [
      () => {
        throw new Error("boom");
      },
      () => Promise.resolve({ vramGb: 24, cudaReady: true }),
      () => null,
      () => 7,
    ]) {
      const probe = probeWith(facts);
      expect(probe.gpu).toMatchObject({ vramGb: 0, source: "none", cudaRuntimeReady: false });
    }
  });

  // The shape electron/hardware.cjs hardwareFacts returns: real source names, and one row per GPU.
  const realFacts = (
    gpu: { name: string; vramGb: number; vramCapped?: boolean },
    sources = ["Win32_VideoController", "os-memory", "model-drive"],
    extra: Facts = {},
  ): Facts => ({
    vramGb: gpu.vramGb,
    vramFreeGb: null,
    gpuVendor: "nvidia",
    gpuName: gpu.name,
    gpus: [{ vendor: "nvidia", driver: "551.23", ...gpu }],
    cudaReady: true,
    sources,
    ...extra,
  });

  it("caps a video memory reading at 4 GB only when the chosen GPU says it came from a clipped 32-bit reading", () => {
    const capped = probeWith(
      realFacts({ name: "NVIDIA GeForce RTX 4080", vramGb: 16, vramCapped: true }),
    );
    expect(capped.gpu.vramGb).toBe(4);
    expect(capped.gpu.source).toBe("Win32_VideoController+os-memory+model-drive");
    // a trusted reading is kept, whatever the source names are
    expect(
      probeWith(realFacts({ name: "NVIDIA GeForce RTX 4080", vramGb: 16, vramCapped: false })).gpu
        .vramGb,
    ).toBe(16);
    // the field is absent (an older facts shape): today's behaviour, not capped
    expect(probeWith(realFacts({ name: "NVIDIA GeForce RTX 4080", vramGb: 16 })).gpu.vramGb).toBe(
      16,
    );
    // a reading already under the cap is untouched
    expect(
      probeWith(realFacts({ name: "NVIDIA GeForce GTX 1050", vramGb: 2, vramCapped: true })).gpu
        .vramGb,
    ).toBe(2);
  });

  it("a name that merely looks like an adapter source never caps a trusted reading", () => {
    const probe = probeWith(
      realFacts({ name: "NVIDIA GeForce RTX 4080", vramGb: 16, vramCapped: false }, [
        "Win32_VideoController",
      ]),
    );
    expect(probe.gpu.vramGb).toBe(16);
  });

  it("caps by the chosen GPU: another card's flag does not touch it", () => {
    const facts = realFacts({ name: "NVIDIA GeForce RTX 4080", vramGb: 16, vramCapped: false });
    (facts["gpus"] as Facts[]).push({
      vendor: "intel",
      name: "Intel UHD",
      vramGb: 4,
      vramCapped: true,
    });
    expect(probeWith(facts).gpu.vramGb).toBe(16);
  });

  it("takes the largest trusted reading: nvidia-smi beats a capped one, a larger trusted one beats nvidia-smi", () => {
    const smiWins = probeWith(
      realFacts({ name: "NVIDIA GeForce RTX 3070", vramGb: 4, vramCapped: true }),
      16,
      10,
      () => "NVIDIA GeForce RTX 3070, 8192\n",
    );
    expect(smiWins.gpu).toMatchObject({ vramGb: 8, source: "nvidia-smi" });
    const factsWin = probeWith(
      realFacts({ name: "NVIDIA GeForce RTX 3060", vramGb: 12, vramCapped: false }, [
        "Win32_VideoController",
        "nvidia-smi",
        "os-memory",
      ]),
      16,
      10,
      () => "NVIDIA GeForce RTX 3060, 6144\n",
    );
    expect(factsWin.gpu.vramGb).toBe(12);
    expect(factsWin.gpu.source).toBe("Win32_VideoController+nvidia-smi+os-memory");
  });

  it("carries free video memory and the CPU class; the kernel's verdict, not the driver's, sets CUDA readiness", () => {
    const probe = probeWith(gpuFacts(8, { vramFreeGb: 7.2, cpuClass: "mid" }), 16, 10, noSmi, true);
    expect(probe.gpu).toMatchObject({ vramGb: 8, vramFreeGb: 7.2, cudaRuntimeReady: true });
    expect(probe.cpuClass).toBe("mid");
    // the driver says yes, the kernel has not: the probe never claims the runtime works
    const driverOnly = probeWith(gpuFacts(8));
    expect(driverOnly.gpu.cudaRuntimeReady).toBe(false);
    expect(driverOnly.gpu.cudaDriverReady).toBe(true);
    // the kernel says yes even when the facts say no (an older facts shape)
    const kernelSays = weights.probeHardware({
      os: fakeOs(16, 10),
      hardwareFacts: () => ({ cudaReady: false }),
      cudaRuntimeReady: true,
      nvidiaSmi: noSmi,
    });
    expect(kernelSays.gpu.cudaRuntimeReady).toBe(true);
    const clamped = probeWith(gpuFacts(8, { vramFreeGb: 99 }));
    expect(clamped.gpu.vramFreeGb).toBe(8);
  });

  it("fills memory from the facts only when the OS gave none", () => {
    const probe = weights.probeHardware({
      os: fakeOs(0, 0),
      hardwareFacts: () => ({ ramGb: 16, ramFreeGb: 9 }),
      nvidiaSmi: noSmi,
    });
    expect(probe).toMatchObject({ totalRamGb: 16, freeRamGb: 9 });
    const osWins = probeWith({ ramGb: 64, ramFreeGb: 60 }, 16, 10);
    expect(osWins).toMatchObject({ totalRamGb: 16, freeRamGb: 10 });
  });
});

describe("an NVIDIA driver without the CUDA runtime libraries", () => {
  // The facts' cudaReady is "the driver can run CUDA 12 programs" and nothing more; cuBLAS 12 and cuDNN 9 are the
  // kernel's own check, so a GPU size is chosen only with that verdict.
  const driverOnly = (vram: number, total = 16, free = 10) =>
    probeWith(gpuFacts(vram), total, free);

  it("keeps the CPU default size and device and never says CUDA works", () => {
    for (const vram of [6, 8, 12, 24]) {
      const b = weights.budgetForProbe(driverOnly(vram, 32, 20));
      expect(b).toMatchObject({ sttSize: "small", sttDevice: "cpu", sttCompute: "int8" });
      expect(b.allowedSizes).not.toContain("medium");
      expect(b.allowedSizes).not.toContain("large-v3-turbo");
      expect(b.notes.join(" ")).not.toMatch(/GPU speech: the CUDA 12 libraries are verified/);
    }
  });

  it("offers an upgrade the installer and Doctor can show: the GPU, its memory, and what is missing", () => {
    const b = weights.budgetForProbe(driverOnly(8)) as Budget & {
      gpuUpgrade?: { needs: string; vramGb: number; detail: string };
    };
    expect(b.gpuUpgrade).toMatchObject({ needs: "cuda-runtime", vramGb: 8 });
    expect(b.gpuUpgrade?.detail).toMatch(/found; install the CUDA runtime libraries/);
    // setup and Doctor print it
    const plan = weights.voiceInstallPlan("", driverOnly(8), {
      exists: () => false,
    }) as unknown as {
      lines: string[];
    };
    expect(plan.lines.join("\n")).toMatch(/found; install the CUDA runtime libraries/);
    // the Models page table gives the same answer
    const probe = driverOnly(8);
    expect(
      tsBudgetFor(probe.totalRamGb, probe.freeRamGb, probe.gpu.vramGb, probe.gpu, {
        cpuThreads: probe.cpuThreads,
      }),
    ).toEqual(weights.budgetForProbe(probe));
  });

  it("offers nothing when the kernel already verified the runtime, when the driver cannot run CUDA 12, or with no GPU", () => {
    expect(weights.budgetForProbe(verifiedProbe(gpuFacts(8)))).not.toHaveProperty("gpuUpgrade");
    expect(weights.budgetForProbe(probeWith(gpuFacts(8, { cudaReady: false })))).not.toHaveProperty(
      "gpuUpgrade",
    );
    expect(weights.budgetForProbe(probeWith({ cudaReady: false, sources: [] }))).not.toHaveProperty(
      "gpuUpgrade",
    );
  });

  it("the kernel's yes unlocks the GPU size the driver alone could not", () => {
    const before = weights.budgetForProbe(driverOnly(8));
    const after = weights.budgetForProbe(verifiedProbe(gpuFacts(8)));
    expect(before.sttDevice).toBe("cpu");
    expect(after).toMatchObject({ sttDevice: "cuda", sttSize: "large-v3-turbo" });
  });
});
