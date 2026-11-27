/**
 * The 16 GB voice budget: which speech size, compute type and packs a machine gets, with fake hardware.
 * `electron/voice-weights.cjs` is what setup and Doctor call; `hardware-profile.ts` is the same table for the
 * Models page, and the parity test at the end keeps the two equal. No GPU, no network, no weights.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { budgetFor as tsBudgetFor } from "../../src/lib/friday/voice-engine/hardware-profile";
import { voiceModelFacts } from "../../src/lib/friday/model-catalog";

const require_ = createRequire(import.meta.url);

type Budget = {
  profile: "lite" | "balanced" | "quality";
  sttSize: string;
  sttDevice: "cpu" | "cuda";
  sttCompute: "int8" | "float16";
  ttsEngine: string;
  packs: {
    id: string;
    install: string[];
    optional: string[];
    skipped: { id: string; reason: string }[];
  }[];
  install: string[];
  allowedSizes: string[];
  maxResidentModels: number;
  idleUnloadMs: number;
  threads: number;
  speechBudgetGb: number;
  notes: string[];
};
type Gpu = {
  name?: string;
  vramGb?: number;
  cudaRuntimeReady?: boolean;
  cudaDriverReady?: boolean;
};
const weights = require_("../../electron/voice-weights.cjs") as {
  budgetFor: (
    total: number,
    free: number,
    vram: number,
    gpu?: Gpu,
    options?: { cpuThreads?: number },
  ) => Budget;
  probeHardware: (deps?: Record<string, unknown>) => {
    totalRamGb: number;
    freeRamGb: number;
    cpuThreads: number;
    gpu: { name: string; vramGb: number; source: string; cudaRuntimeReady: boolean };
  };
};

const budget = (total: number, free: number, vram = 0, gpu: Gpu = {}, cpuThreads = 8) =>
  weights.budgetFor(total, free, vram, gpu, { cpuThreads });
const BIG = ["medium", "large-v3-turbo", "large-v3"];

describe("the 16 GB CPU-only budget", () => {
  const b = budget(16, 10);

  it("makes small int8 the primary and never allows a big size on a CPU-only 16 GB machine", () => {
    expect(b.profile).toBe("balanced");
    expect(b.sttSize).toBe("small");
    expect(b.sttDevice).toBe("cpu");
    expect(b.sttCompute).toBe("int8");
    expect(b.allowedSizes).toEqual(["tiny", "base", "small"]);
    for (const size of BIG) expect(b.allowedSizes).not.toContain(size);
    expect(b.ttsEngine).toBe("supertonic");
  });

  it("holds the owner's memory policy: two resident models, speech at most 4 GB, idle unload", () => {
    expect(b.maxResidentModels).toBe(2);
    expect(b.speechBudgetGb).toBeLessThanOrEqual(4);
    expect(b.speechBudgetGb).toBeGreaterThanOrEqual(2);
    expect(b.idleUnloadMs).toBe(600_000); // the same ten minutes as kernel/stt.py
    expect(b.threads).toBe(4); // half of 8 logical processors
  });

  it("installs the primary ear, Smart Turn, Silero VAD, Supertonic and the Hindi ear, in that order of need", () => {
    expect(b.install).toEqual([
      "silero-vad",
      "smart-turn",
      "faster-whisper-small",
      "supertonic-3",
      "hindi-ear",
      "hindi-punct",
    ]);
    const hindi = b.packs.find((p) => p.id === "voice-pack-hindi")!;
    expect(hindi.install).toEqual(["hindi-ear", "hindi-punct", "supertonic-3"]);
    expect(hindi.optional).toEqual(["hindi-light-tts", "hindi-fallback-ear"]);
    const hinglish = b.packs.find((p) => p.id === "voice-pack-hinglish")!;
    expect(hinglish.optional).toContain("hinglish-ear");
  });

  it("says in words why a big size is not loaded", () => {
    expect(b.notes.join(" ")).toMatch(/large-v3/);
    expect(b.notes.join(" ")).toMatch(/CPU/);
  });
});

describe("RAM sizes", () => {
  it("8 GB gets small, 6 GB gets base, under 4 GB gets tiny (the same steps as the boot rule)", () => {
    expect(budget(8, 5).sttSize).toBe("small");
    expect(budget(6, 4).sttSize).toBe("base");
    expect(budget(4, 2.5).sttSize).toBe("base");
    expect(budget(3, 2).sttSize).toBe("tiny");
    expect(budget(6, 4).profile).toBe("lite");
  });

  it("32 GB CPU-only is still small: a bigger ear is not auto-loaded without a verified GPU", () => {
    const b32 = budget(32, 24);
    expect(b32.sttSize).toBe("small");
    for (const size of BIG) expect(b32.allowedSizes).not.toContain(size);
    expect(b32.speechBudgetGb).toBeLessThanOrEqual(4);
  });

  it("low free memory steps down: 16 GB with 3 GB free listens with base, with 1 GB free with tiny", () => {
    expect(budget(16, 3).sttSize).toBe("base");
    const tight = budget(16, 1);
    expect(tight.sttSize).toBe("tiny");
    expect(tight.notes.join(" ")).toMatch(/free memory/i);
  });

  it("a PC that reports 15.8 GB is a 16 GB PC", () => {
    expect(budget(15.8, 9).sttSize).toBe("small");
  });

  it("unknown values never crash and never pick a big size", () => {
    for (const args of [
      [0, 0],
      [NaN, NaN],
      [-1, 5],
      [16, NaN],
    ] as [number, number][]) {
      const b0 = budget(args[0], args[1]);
      expect(["tiny", "base", "small"]).toContain(b0.sttSize);
      expect(b0.maxResidentModels).toBe(2);
    }
  });
});

describe("the GPU is used only after the runtime check", () => {
  it("an NVIDIA card whose CUDA 12 libraries are not verified stays on the CPU, and says why", () => {
    const b = budget(16, 10, 8, { name: "NVIDIA GeForce RTX 3070", cudaRuntimeReady: false });
    expect(b.sttDevice).toBe("cpu");
    expect(b.sttCompute).toBe("int8");
    expect(b.sttSize).toBe("small");
    for (const size of BIG) expect(b.allowedSizes).not.toContain(size);
    expect(b.notes.join(" ")).toMatch(/cuBLAS|CUDA/);
    expect(b.notes.join(" ")).toMatch(/never downloads CUDA/i);
  });

  it("a driver that can run CUDA 12 picks no GPU size; it only adds the upgrade the installer shows", () => {
    const b = budget(16, 10, 8, { name: "NVIDIA GeForce RTX 3070", cudaDriverReady: true });
    expect(b).toMatchObject({ sttDevice: "cpu", sttCompute: "int8", sttSize: "small" });
    expect(b).toMatchObject({ gpuUpgrade: { needs: "cuda-runtime", vramGb: 8 } });
    expect(budget(16, 10, 8, { cudaRuntimeReady: true, cudaDriverReady: true })).not.toHaveProperty(
      "gpuUpgrade",
    );
  });

  it("a verified 8 GB card on 16 GB RAM may use float16 and a bigger ear", () => {
    const b = budget(16, 10, 8, { name: "NVIDIA GeForce RTX 3070", cudaRuntimeReady: true });
    expect(b.profile).toBe("quality");
    expect(b.sttDevice).toBe("cuda");
    expect(b.sttCompute).toBe("float16");
    expect(b.sttSize).toBe("large-v3-turbo");
    expect(b.allowedSizes).toContain("large-v3-turbo");
    expect(b.allowedSizes).not.toContain("large-v3"); // the biggest size stays the owner's own lock
  });

  it("a verified small card (2 GB) is not used", () => {
    const b = budget(16, 10, 2, { cudaRuntimeReady: true });
    expect(b.sttDevice).toBe("cpu");
    expect(b.sttSize).toBe("small");
  });

  it("a verified card with little RAM left does not get a big size", () => {
    const b = budget(8, 5, 8, { cudaRuntimeReady: true });
    expect(b.sttSize).toBe("small");
  });
});

describe("the Node-side probe", () => {
  it("reads memory and processors from the OS and the GPU from Electron when it is there", () => {
    const probe = weights.probeHardware({
      os: {
        totalmem: () => 16 * 1024 ** 3,
        freemem: () => 9.5 * 1024 ** 3,
        cpus: () => new Array(8).fill({}),
        platform: () => "win32",
      },
      gpuInfo: {
        gpuDevice: [{ active: true, vendorId: 0x10de, deviceString: "NVIDIA GeForce RTX 3070" }],
      },
      nvidiaSmi: () => "",
    });
    expect(probe.totalRamGb).toBe(16);
    expect(probe.freeRamGb).toBe(9.5);
    expect(probe.cpuThreads).toBe(8);
    expect(probe.gpu.name).toMatch(/RTX 3070/);
    expect(probe.gpu.cudaRuntimeReady).toBe(false); // only the kernel's own check can say true
  });

  it("takes video memory from nvidia-smi when Electron does not give it, with no new dependency", () => {
    const probe = weights.probeHardware({
      os: {
        totalmem: () => 16 * 1024 ** 3,
        freemem: () => 8 * 1024 ** 3,
        cpus: () => new Array(4).fill({}),
        platform: () => "win32",
      },
      nvidiaSmi: () => "NVIDIA GeForce GTX 1660, 6144\n",
    });
    expect(probe.gpu).toMatchObject({
      name: "NVIDIA GeForce GTX 1660",
      vramGb: 6,
      source: "nvidia-smi",
    });
  });

  it("is quiet and CPU-only when nothing answers", () => {
    const probe = weights.probeHardware({
      os: {
        totalmem: () => 8 * 1024 ** 3,
        freemem: () => 4 * 1024 ** 3,
        cpus: () => [{}, {}],
        platform: () => "linux",
      },
      nvidiaSmi: () => {
        throw new Error("not found");
      },
    });
    expect(probe.gpu).toMatchObject({ name: "", vramGb: 0, source: "none" });
  });
});

describe("the Models page table is the same as setup's", () => {
  const cases: [number, number, number, Gpu][] = [
    [16, 10, 0, {}],
    [16, 3, 0, {}],
    [16, 1, 0, {}],
    [8, 5, 0, {}],
    [6, 4, 0, {}],
    [3, 2, 0, {}],
    [32, 24, 0, {}],
    [16, 10, 8, { cudaRuntimeReady: true }],
    [16, 10, 8, { cudaRuntimeReady: false }],
    [16, 10, 5, { cudaRuntimeReady: true }],
    [8, 5, 8, { cudaRuntimeReady: true }],
    [16, 10, 8, { name: "NVIDIA GeForce RTX 3070", cudaDriverReady: true }],
    [16, 10, 8, { cudaRuntimeReady: true, cudaDriverReady: true }],
  ];
  for (const [total, free, vram, gpu] of cases) {
    it(`budgetFor(${total}, ${free}, ${vram}, ${JSON.stringify(gpu)})`, () => {
      expect(tsBudgetFor(total, free, vram, gpu, { cpuThreads: 8 })).toEqual(
        budget(total, free, vram, gpu),
      );
    });
  }
});

describe("the catalog's manifest fields are the pinned ones", () => {
  const registry = require_("../../electron/voice-weights.cjs") as {
    modelRegistry: () => { catalogId: string }[];
    manifestOf: (id: string) => Record<string, unknown> | null;
  };

  it("every pinned voice model has the same fields and numbers on both sides, and the disk bytes are the pins' sum", () => {
    const ids = registry.modelRegistry().map((row) => row.catalogId);
    expect(ids.length).toBe(25); // 14 before the two denoisers, the speaker model, the Vaani ear, the streaming ear, the Trelis Hinglish ear, the wake embedding and the four acquired-ear rows (English, Swift, Quick and its vocabulary)
    expect(ids).toEqual(
      expect.arrayContaining([
        "denoise-dpdfnet",
        "denoise-gtcrn",
        "speaker-wespeaker",
        "hindi-vaani-ear",
        "stream-ear-nemotron",
        "hinglish-ear-trelis",
        "wake-embed",
      ]),
    );
    expect(Object.keys(voiceModelFacts).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const node = registry.manifestOf(id)!;
      const web = voiceModelFacts[id]!;
      for (const key of Object.keys(web) as (keyof typeof web)[]) {
        expect(web[key], `${id}.${key}`).toEqual(node[key]);
      }
    }
  });
});
