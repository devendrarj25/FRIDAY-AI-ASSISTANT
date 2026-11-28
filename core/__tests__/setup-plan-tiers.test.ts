/**
 * Setup plan: hardware-aware tiers (config/chat-tiers.json through electron/setup-plan.cjs). From a 4 GB laptop to a
 * 64 GB / 24 GB workstation: the model, its context window, the fast voice twin, the CPU caps, Vulkan cards, the
 * fingerprint. Pure facts in, plan out: no hardware, no network, no real disk.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const plan = require_(path.join(root, "electron/setup-plan.cjs"));
const tiersFile = JSON.parse(readFileSync(path.join(root, "config/chat-tiers.json"), "utf8"));
const PIN = {
  kind: "pinned",
  version: "1",
  tag: "b1",
  assets: [
    {
      name: "llama-b1-bin-win-cpu-x64.zip",
      url: "https://example.invalid/x.zip",
      bytes: 1,
      sha256: "a".repeat(64),
    },
  ],
};
const deps = (extra: Record<string, unknown> = {}) => ({ llamaPin: PIN, ...extra });

type Facts = Record<string, any>;
const base = (extra: Facts = {}): Facts => ({
  vramGb: null,
  vramFreeGb: null,
  ramGb: 16,
  ramFreeGb: 12,
  diskFreeGb: 200,
  gpuVendor: null,
  gpuName: null,
  gpus: [],
  cudaReady: false,
  driverVersion: null,
  cpuClass: "mid",
  arch: "x64",
  cpu: { avx2: true, avx512: false },
  vulkan: false,
  cuda: { driverCuda: null, cublas12: null, cudnn9: null, runtimeFilesFound: null },
  network: { online: true, metered: false },
  power: { batteryPresent: false, onAc: true },
  health: { level: "ok", reasons: [] },
  ...extra,
});
const nvidia = (vramGb: number, freeGb: number, extra: Facts = {}, card: Facts = {}): Facts =>
  base({
    vramGb,
    vramFreeGb: freeGb,
    gpuVendor: "nvidia",
    gpuName: "Test NVIDIA card",
    gpus: [
      {
        vendor: "nvidia",
        name: "Test NVIDIA card",
        vramGb,
        vramCapped: false,
        driver: "560.94",
        integrated: false,
        unifiedMemory: false,
        computeCap: 7.5,
        ...card,
      },
    ],
    cudaReady: true,
    driverVersion: "560.94",
    vulkan: true,
    cuda: { driverCuda: "12.6", cublas12: false, cudnn9: false, runtimeFilesFound: false },
    ...extra,
  });
const other = (vendor: "amd" | "intel", vramGb: number, card: Facts = {}, extra: Facts = {}) =>
  base({
    vramGb,
    gpuVendor: vendor,
    gpuName: "Test card",
    gpus: [
      {
        vendor,
        name: "Test card",
        vramGb,
        vramCapped: false,
        driver: "31.0",
        integrated: false,
        unifiedMemory: false,
        computeCap: null,
        ...card,
      },
    ],
    vulkan: true,
    ...extra,
  });
const noGpu = (ramGb: number, extra: Facts = {}) => base({ ramGb, ramFreeGb: ramGb - 2, ...extra });

describe("tiny and big PCs get the best model that fits their total memory", () => {
  it("4 GB: the floor model with a small window; 3 GB: none; the reserve grows with the RAM", () => {
    const p = plan.chatModelFor(noGpu(4));
    expect(p.tag).toBe("qwen3.5:0.8b");
    expect(p.numCtx).toBe(2048);
    expect(plan.chatModelFor(noGpu(3)).tag).toBeNull();
    expect(plan.chatModelFor(noGpu(6)).numCtx).toBe(4096);
    expect(plan.chatModelFor(noGpu(8)).numCtx).toBe(4096);
    expect(plan.chatModelFor(noGpu(8)).tag).toBe("qwen3.5:2b");
  });

  it("every CPU RAM size from 4 to 128 GB gets a model whose memory fits, and the model never shrinks as RAM grows", () => {
    const quality = (tag: string) => plan.qualityOf(tag, tiersFile) as number;
    let last = 0;
    for (const ram of [4, 5, 6, 7, 8, 12, 16, 24, 32, 48, 64, 128]) {
      const p = plan.chatModelFor(noGpu(ram));
      expect(p.tag, `ram ${ram}`).toBeTruthy();
      expect(p.needs.memoryGb).toBeLessThanOrEqual(p.memory.usableGb);
      expect(quality(p.tag)).toBeGreaterThanOrEqual(last);
      last = quality(p.tag);
    }
  });

  it("a mixture-of-experts CPU tier is marked estimated, a dense one is not", () => {
    expect(plan.chatModelFor(noGpu(32)).estimated).toBe(true);
    expect(plan.chatModelFor(noGpu(16)).estimated).toBe(false);
  });

  it("gpu-4 is reachable by the real table: the 4 GB card gets the 4-bit 2b on the GPU", () => {
    const row = tiersFile.tiers.find((t: any) => t.id === "gpu-4");
    expect(row.downloadGb * tiersFile.rules.weightsMargin).toBeLessThanOrEqual(
      4 - tiersFile.rules.gpuHeadroomGb,
    );
    const p = plan.chatModelFor(nvidia(4, 3.9));
    expect(p.tier).toBe("gpu-4");
    expect(p.device).toBe("gpu");
    expect(p.voice).toBeNull();
  });

  it("a 24 GB card in a 64 GB PC takes the 27b on the GPU; a 32 GB card the 35b mixture of experts", () => {
    expect(plan.chatModelFor(nvidia(24, 23, { ramGb: 64, ramFreeGb: 50 })).tag).toBe(
      "qwen3.6:27b-q4_K_M",
    );
    const p = plan.chatModelFor(nvidia(32, 31));
    expect(p.tag).toBe("qwen3.6:35b-a3b-q4_K_M");
    expect(p.tier).toBe("gpu-32");
  });

  it("several graphics cards stay single-card and say so", () => {
    const f = nvidia(12, 11);
    f["gpus"].push({
      vendor: "nvidia",
      name: "Second card",
      vramGb: 8,
      integrated: false,
      unifiedMemory: false,
      computeCap: 7.5,
      driver: "560.94",
    });
    const p = plan.chatModelFor(f);
    expect(p.tag).toBe("qwen3.5:9b");
    expect(p.notes.join(" ")).toMatch(/only the largest one/);
  });
});

describe("the free memory warns and never changes the plan", () => {
  it("a busy PC keeps the same tag, window, twin and action", () => {
    for (const f of [noGpu(16), nvidia(12, 11), nvidia(6, 5.5)]) {
      const busy = structuredClone(f);
      busy["ramFreeGb"] = 0.6;
      if (busy["vramFreeGb"]) busy["vramFreeGb"] = 0.4;
      const a = plan.buildSetupPlan(f, deps());
      const b = plan.buildSetupPlan(busy, deps());
      for (const key of ["tag", "numCtx", "action", "tier"])
        expect(b.chat[key]).toEqual(a.chat[key]);
      expect(b.chat.voice).toEqual(a.chat.voice);
      expect(b.chat.warn).toBeTruthy();
    }
  });
});

describe("NVIDIA floors follow Ollama's rule (docs.ollama.com/gpu, read 2026-11-28)", () => {
  it("compute capability 5.0 and driver 550 qualify; 5.0 to 6.2 needs driver 570", () => {
    expect(plan.chatModelFor(nvidia(8, 7, {}, { computeCap: 8.6, driver: "550.54" })).device).toBe(
      "gpu",
    );
    expect(plan.chatModelFor(nvidia(8, 7, {}, { computeCap: 8.6, driver: "549.99" })).device).toBe(
      "cpu",
    );
    expect(plan.chatModelFor(nvidia(8, 7, {}, { computeCap: 6.1, driver: "572.16" })).device).toBe(
      "gpu",
    );
    const old = plan.chatModelFor(nvidia(8, 7, {}, { computeCap: 6.1, driver: "560.94" }));
    expect(old.device).toBe("cpu");
    expect(old.reason).toMatch(/older than 570/);
    expect(plan.chatModelFor(nvidia(8, 7, {}, { computeCap: 5.0, driver: "570.10" })).device).toBe(
      "gpu",
    );
    expect(plan.chatModelFor(nvidia(8, 7, {}, { computeCap: 3.5, driver: "570.10" })).device).toBe(
      "cpu",
    );
    expect(
      plan.chatModelFor(nvidia(8, 7, {}, { computeCap: 3.5, driver: "570.10" })).reason,
    ).toMatch(/below 5/);
  });
});

describe("dedicated AMD and Intel cards run chat through Vulkan, estimated", () => {
  it.each(["amd", "intel"] as const)(
    "a dedicated %s card with 8 GB gets a GPU tier on Vulkan",
    (vendor) => {
      const p = plan.chatModelFor(other(vendor, 8));
      expect(p.device).toBe("gpu");
      expect(p.backend).toBe("vulkan");
      expect(p.estimated).toBe(true);
      expect(p.memory.usableGb).toBe(6.5);
      expect(p.needs.memoryGb).toBeLessThanOrEqual(p.memory.usableGb);
      expect(p.notes.join(" ")).toMatch(/Vulkan/);
    },
  );

  it("below 6 GB, a unified-memory APU, an integrated part and a missing Vulkan driver all stay on the CPU", () => {
    expect(plan.chatModelFor(other("amd", 4)).device).toBe("cpu");
    expect(plan.chatModelFor(other("amd", 16, { unifiedMemory: true })).device).toBe("cpu");
    expect(
      plan.chatModelFor(other("intel", 16, { integrated: true, unifiedMemory: true })).device,
    ).toBe("cpu");
    expect(plan.chatModelFor(other("amd", 16, {}, { vulkan: false })).device).toBe("cpu");
    expect(plan.chatModelFor(other("amd", 4)).reason).toMatch(/below the 6 GB/);
  });

  it("an APU's carve-out is never read as video memory, even with a large figure", () => {
    const apu = other("amd", 16, { unifiedMemory: true }, { ramGb: 32, ramFreeGb: 24 });
    const p = plan.buildSetupPlan(apu, deps());
    expect(p.chat.device).toBe("cpu");
    expect(p.chat.backend).toBe("cpu");
  });
});

describe("num_ctx comes from the memory left, the native window and the device", () => {
  it("the window is a ladder step, grows with room, and CPU PCs stop at 16k", () => {
    const ladder: number[] = tiersFile.rules.numCtx.ladder;
    for (const f of [
      noGpu(4),
      noGpu(16),
      noGpu(64),
      nvidia(6, 5),
      nvidia(12, 11),
      nvidia(24, 23),
      nvidia(48, 47),
    ]) {
      const p = plan.chatModelFor(f);
      expect(ladder).toContain(p.numCtx);
      if (p.device === "cpu") expect(p.numCtx).toBeLessThanOrEqual(16384);
    }
    expect(plan.chatModelFor(nvidia(12, 11)).numCtx).toBe(32768);
    expect(plan.chatModelFor(noGpu(64)).numCtx).toBe(16384);
  });

  it("a row that carries no key-value figure falls back to the conservative default", () => {
    const tiers = structuredClone(tiersFile);
    for (const t of tiers.tiers) delete t.kvKbPerToken;
    const withKv = plan.chatModelFor(nvidia(12, 11)).numCtx;
    const without = plan.chatModelFor(nvidia(12, 11), { tiers }).numCtx;
    expect(without).toBeLessThan(withKv);
  });

  it("the recorded Ollama window stays the 8192 config default; the planned window is its own field", () => {
    expect(tiersFile.ollamaSettings.options.num_ctx).toBe(8192);
    for (const f of [noGpu(4), noGpu(16), nvidia(24, 23)]) {
      const p = plan.buildSetupPlan(f, deps());
      expect(p.chat.settings.options.num_ctx).toBe(8192);
      expect(p.chat.numCtx).toBe(plan.chatModelFor(f).numCtx);
    }
    expect(plan.buildSetupPlan(noGpu(4), deps()).chat.numCtx).toBe(2048);
    expect(plan.buildSetupPlan(noGpu(16), deps()).chat.numCtx).toBe(16384);
  });
});

describe("the fast voice twin", () => {
  it("is null when the main model is already 2b or smaller, set when it is bigger", () => {
    for (const f of [noGpu(4), noGpu(8), nvidia(4, 3.9)])
      expect(plan.chatModelFor(f).voice).toBeNull();
    const p = plan.chatModelFor(noGpu(16));
    expect(p.voice).toMatchObject({ tag: "qwen3.5:0.8b", sizeGb: 1.3, ctx: 4096, device: "cpu" });
    expect(plan.chatModelFor(nvidia(16, 15)).voice).toMatchObject({ tag: "qwen3.5:2b" });
    expect(plan.buildSetupPlan(noGpu(16), deps()).chat.voice.tag).toBe("qwen3.5:0.8b");
  });

  it("goes to the CPU when the card cannot hold both, and is null when no memory holds both", () => {
    const six = plan.chatModelFor(nvidia(6, 5));
    expect(six.voice.device).toBe("cpu");
    const tight = plan.chatModelFor(noGpu(32));
    expect(tight.voice).toBeNull();
    expect(tight.voiceWhy).toMatch(/smaller model answers alone/);
  });

  it("is null when the disk cannot take both downloads", () => {
    const p = plan.chatModelFor(noGpu(16, { diskFreeGb: 6.6 }));
    expect(p.tag).toBeTruthy();
    expect(p.voice).toBeNull();
    expect(p.voiceWhy).toMatch(/disk space/);
  });

  it("voiceModelTags lists the same tags config/chat-tiers.json carries, every row's twin included", () => {
    const tags: string[] = plan.voiceModelTags();
    expect(tags).toEqual(tiersFile.voice.tags);
    const rowTags = tiersFile.tiers.map((t: any) => t.voice?.tag).filter(Boolean);
    expect(rowTags.length).toBeGreaterThan(0);
    for (const tag of rowTags) expect(tags).toContain(tag);
    expect(
      plan.voiceModelTags({
        tiers: { tiers: [{ voice: { tag: "X:1b" } }], voice: { tags: ["y:2b", "Y:2B"] } },
      }),
    ).toEqual(["y:2b", "x:1b"]);
    expect(plan.voiceModelTags({ tiers: { tiers: [] } })).toEqual([]);
  });
});

describe("CPU caps: no AVX2 and ARM64 Windows", () => {
  it("no AVX2 caps a 16 GB PC at 2b (0.8b on a weak processor) and names the llama.cpp CPU build", () => {
    const f = noGpu(16, { cpu: { avx2: false } });
    const p = plan.chatModelFor(f);
    expect(p.tag).toBe("qwen3.5:2b");
    expect(p.notes.join(" ")).toMatch(/no AVX2/);
    expect(p.notes.join(" ")).toMatch(/plain CPU build/);
    expect(plan.chatModelFor(noGpu(16, { cpu: { avx2: false }, cpuClass: "low" })).tag).toBe(
      "qwen3.5:0.8b",
    );
    expect(plan.chatModelFor(noGpu(64, { cpu: { avx2: false } })).tag).toBe("qwen3.5:2b");
    expect(plan.chatModelFor(noGpu(16, { cpu: { avx2: true } })).tag).toBe("qwen3.5:4b");
  });

  it("ARM64 Windows is capped and the plan says x64 emulation, slow", () => {
    const f = noGpu(16, { arch: "arm64", cpu: { avx2: null } });
    const p = plan.buildSetupPlan(f, deps());
    expect(p.chat.tag).toBe("qwen3.5:2b");
    expect(p.chat.notes.join(" ")).toMatch(/x64 emulation, slow/);
    expect(p.pc.arch).toBe("arm64");
    const viaOs = plan.chatModelFor(noGpu(16, { arch: undefined, os: { arch: "arm64" } }));
    expect(viaOs.tag).toBe("qwen3.5:2b");
  });

  it("a card is not capped by the processor: the GPU model stands on a no-AVX2 PC", () => {
    expect(plan.chatModelFor(nvidia(12, 11, { cpu: { avx2: false } })).tag).toBe("qwen3.5:9b");
  });
});

describe("the first NVIDIA setup picks the GPU ear and the GPU ONNX Runtime", () => {
  const VOICE_ROOT = path.join(root, "testing", "setup-plan-tiers-fake-root");
  const capture = () => {
    const seen: any[] = [];
    const voiceWeights = {
      voiceInstallPlan: (_root: string, probe: unknown) => {
        seen.push(probe);
        return {
          items: [],
          blocked: [],
          optional: [],
          lines: [],
          downloadBytes: 0,
          budget: {
            profile: "p",
            sttSize: "small",
            sttCompute: "float16",
            sttDevice: "cuda",
            speechBudgetGb: 2,
            notes: [],
          },
        };
      },
    };
    return { seen, voiceWeights };
  };

  it("CUDA libraries planned in this same setup count as a ready runtime for the voice plan", () => {
    const c = capture();
    const p = plan.buildSetupPlan(
      nvidia(8, 7),
      deps({ root: VOICE_ROOT, voiceWeights: c.voiceWeights }),
    );
    expect(p.packages.cudaLibs.action).toBe("install");
    expect(c.seen[0].gpu.cudaRuntimeReady).toBe(true);
    expect(p.packages.ort.installNow).toBe("gpu");
    expect(p.packages.ort.bytes).toBeGreaterThan(100_000_000);
  });

  it("a deferred (metered) install is not ready: CPU ear, CPU ONNX Runtime, the GPU build offered", () => {
    const c = capture();
    const f = nvidia(8, 7, { network: { online: true, metered: true } });
    const p = plan.buildSetupPlan(f, deps({ root: VOICE_ROOT, voiceWeights: c.voiceWeights }));
    expect(p.packages.cudaLibs.action).toBe("defer");
    expect(c.seen[0].gpu.cudaRuntimeReady).toBe(false);
    expect(p.packages.ort.installNow).toBe("cpu");
    expect(p.offered.map((o: { id: string }) => o.id)).toContain("onnxruntime-gpu");
  });

  it("a PC without an NVIDIA card never gets the GPU ONNX Runtime now", () => {
    expect(plan.buildSetupPlan(other("amd", 8), deps()).packages.ort.installNow).toBe("cpu");
  });
});

describe("planFingerprint detects a changed PC and ignores the minute-to-minute facts", () => {
  const fp = (f: Facts) => plan.planFingerprint(plan.buildSetupPlan(f, deps()));
  it("is stable across free memory, free disk, the line and the power state", () => {
    const a = fp(nvidia(8, 7));
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(
      fp(
        nvidia(8, 2, {
          ramFreeGb: 1,
          diskFreeGb: 50,
          network: { online: false },
          power: { batteryPresent: true, onAc: false },
        }),
      ),
    ).toBe(a);
    expect(plan.buildSetupPlan(nvidia(8, 7), deps()).fingerprint).toBe(a);
  });

  it("changes with the total RAM, the card, the architecture, the processor class, AVX2 and the drive type", () => {
    const a = fp(nvidia(8, 7));
    const changed = [
      fp(nvidia(8, 7, { ramGb: 32 })),
      fp(nvidia(12, 11)),
      fp(nvidia(8, 7, { arch: "arm64" })),
      fp(nvidia(8, 7, { cpuClass: "low" })),
      fp(nvidia(8, 7, { cpu: { avx2: false } })),
      fp(nvidia(8, 7, { modelDrive: { media: "hdd" } })),
      fp(other("amd", 8)),
    ];
    for (const c of changed) expect(c).not.toBe(a);
    expect(new Set([a, ...changed]).size).toBe(changed.length + 1);
  });

  it("never throws on garbage", () => {
    for (const bad of [null, undefined, 7, "x", {}, { pc: 3 }])
      expect(() => plan.planFingerprint(bad)).not.toThrow();
  });
});

describe("the table", () => {
  it("every tier row has a key-value figure, and every voice twin exists as a model row or alternative", () => {
    for (const t of tiersFile.tiers) {
      expect(t.kvKbPerToken, t.id).toBeGreaterThan(0);
      if (t.voice) {
        expect(tiersFile.voice.tags).toContain(t.voice.tag);
        expect(t.voice.downloadGb).toBeGreaterThan(0);
        expect(plan.qualityOf(t.voice.tag, tiersFile)).not.toBeNull();
      }
    }
  });

  it("the flash attention variable is never written as a word Ollama rejects", () => {
    const env = plan.buildSetupPlan(nvidia(8, 7), deps()).chat.settings.env;
    for (const [key, value] of Object.entries(env))
      if (key === "OLLAMA_FLASH_ATTENTION") expect(["0", "1"]).toContain(value);
  });
});

describe("the installed-model picker follows the total memory too (electron/local-library.cjs)", () => {
  it("an installed 4b stays the chat model on a 16 GB PC with little RAM free right now", () => {
    const lib = require_(path.join(root, "electron/local-library.cjs"));
    const installed = [{ name: "qwen3.5:4b", size: 3.3 * 1024 ** 3 }];
    const idle = lib.installedChatModel(installed, { facts: noGpu(16) });
    const busy = lib.installedChatModel(installed, { facts: noGpu(16, { ramFreeGb: 0.8 }) });
    expect(idle.tag).toBe("qwen3.5:4b");
    expect(busy).toEqual(idle);
  });
});
