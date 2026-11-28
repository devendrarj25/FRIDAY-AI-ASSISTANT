/**
 * The setup plan (electron/setup-plan.cjs): one plan for this PC from measured facts. Pure, with injected facts, an
 * injected pinned llama.cpp release and a fake disk for the voice plan: no hardware, no network, no real disk.
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
  version: "12230",
  tag: "b12230",
  assets: [
    {
      name: "llama-b12230-bin-win-cpu-x64.zip",
      url: "https://example.invalid/llama-b12230-bin-win-cpu-x64.zip",
      bytes: 24898046,
      sha256: "a".repeat(64),
    },
  ],
};
const VOICE = {
  root: path.join(root, "testing", "setup-plan-fake-root"),
  exists: () => false,
  statfs: () => ({ bavail: 500 * 1024 ** 2, bsize: 1024 }),
};
const deps = (extra = {}) => ({ llamaPin: PIN, ...VOICE, ...extra });

type Facts = Record<string, any>;
/** A PC with no graphics card, 16 GB of RAM, online, healthy. */
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
  cpu: { avx2: true, avx512: false, logicalCores: 8, physicalCores: 4 },
  vulkan: false,
  cuda: { driverCuda: null, cublas12: null, cudnn9: null, runtimeFilesFound: null },
  network: { online: true, metered: false },
  power: { batteryPresent: false, onAc: true },
  health: { level: "ok", reasons: [] },
  ...extra,
});
const nvidia = (vramGb: number, freeGb: number, extra: Facts = {}): Facts =>
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
        computeCap: 7.5,
      },
    ],
    cudaReady: true,
    driverVersion: "560.94",
    vulkan: true,
    cuda: { driverCuda: "12.6", cublas12: false, cudnn9: false, runtimeFilesFound: false },
    ...extra,
  });
const noGpu = (ramGb: number, ramFreeGb: number, extra: Facts = {}) =>
  base({ ramGb, ramFreeGb, ...extra });

describe("setup plan: chat model by memory", () => {
  it("no GPU, 4 GB of RAM: the floor model qwen3.5:0.8b fits; 3 GB or less still gets none, and says so", () => {
    const p = plan.buildSetupPlan(noGpu(4, 2.5), deps());
    expect(p.chat.tag).toBe("qwen3.5:0.8b");
    expect(p.chat.device).toBe("cpu");
    expect(p.chat.action).toBe("pull");
    expect(p.chat.needs.memoryGb).toBeLessThanOrEqual(p.chat.memory.usableGb);
    // 5 and 6 GB keep the floor model too, with a window that leaves the weights room.
    for (const ram of [5, 6])
      expect(plan.chatModelFor(noGpu(ram, ram - 2)).tag).toBe("qwen3.5:0.8b");
    for (const ram of [3, 2.5, 2]) {
      const none = plan.buildSetupPlan(noGpu(ram, ram - 1), deps());
      expect(none.chat.tag).toBeNull();
      expect(none.chat.action).toBe("none");
      expect(none.chat.reason).toMatch(/no local chat model fits/);
    }
  });

  it("no GPU, 8 GB of RAM: qwen3.5:2b on the CPU, the CPU llama.cpp zip, no GPU packages", () => {
    const p = plan.buildSetupPlan(noGpu(8, 5), deps());
    expect(p.chat.tag).toBe("qwen3.5:2b");
    expect(p.chat.device).toBe("cpu");
    expect(p.chat.action).toBe("pull");
    expect(p.llama.install.backend).toBe("cpu");
    expect(p.llama.install.source).toBe("pinned");
    expect(p.packages.cudaLibs.action).toBe("skip");
    expect(p.packages.ort.variant).toBe("cpu");
  });

  it("no GPU, 8 GB with little free RAM: the tier follows the total (2b), free memory only warns", () => {
    const pick = plan.chatModelFor(noGpu(8, 3.5));
    expect(pick.tag).toBe("qwen3.5:2b");
    expect(pick.tag).toBe(plan.chatModelFor(noGpu(8, 6)).tag);
    expect(pick.needs.memoryGb).toBeLessThanOrEqual(pick.memory.usableGb);
    expect(pick.warn).toMatch(/free right now/);
    expect(plan.chatModelFor(noGpu(8, 6)).warn).toBeUndefined();
  });

  it("a browser open at Doctor time never flips the planned model on any PC", () => {
    for (const total of [4, 8, 16, 32]) {
      const idle = plan.chatModelFor(noGpu(total, total - 1));
      const busy = plan.chatModelFor(noGpu(total, 0.5));
      expect(busy.tag).toBe(idle.tag);
      expect(busy.numCtx).toBe(idle.numCtx);
    }
    // An installed model that fits the total stays in use even when little is free right now.
    const p = plan.buildSetupPlan(noGpu(16, 1.5), deps({ installedModels: ["qwen3.5:4b"] }));
    expect(p.chat.action).toBe("keep");
    expect(p.chat.use).toBe("qwen3.5:4b");
  });

  it("no GPU, 16 GB: qwen3.5:4b on the CPU; bigger RAM climbs the CPU tiers, each fitting its memory", () => {
    const pick = plan.chatModelFor(noGpu(16, 12));
    expect(pick.tag).toBe("qwen3.5:4b");
    expect(pick.device).toBe("cpu");
    expect(plan.chatModelFor(noGpu(24, 20)).tag).toBe("qwen3.5:9b");
    expect(plan.chatModelFor(noGpu(32, 28)).tag).toBe("qwen3.6:35b-a3b");
    expect(plan.chatModelFor(noGpu(48, 44)).tag).toBe("qwen3.6:35b-a3b");
    const big = plan.chatModelFor(noGpu(64, 50));
    expect(big.tag).toBe("qwen3.6:35b-a3b-q8_0");
    expect(big.estimated).toBe(true);
    for (const ram of [16, 24, 32, 48, 64]) {
      const p = plan.chatModelFor(noGpu(ram, ram - 2));
      expect(p.needs.memoryGb).toBeLessThanOrEqual(p.memory.usableGb);
    }
  });

  it("a 4 GB card is served: the 4-bit qwen3.5:2b runs on the GPU, no CUDA build, Vulkan build, never a spill", () => {
    const f = nvidia(4, 3.4);
    const p = plan.buildSetupPlan(f, deps());
    expect(p.chat.tag).toBe("qwen3.5:2b-q4_K_M");
    expect(p.chat.tier).toBe("gpu-4");
    expect(p.chat.device).toBe("gpu");
    expect(p.chat.backend).toBe("cuda");
    expect(p.chat.needs.memoryGb).toBeLessThanOrEqual(p.chat.memory.usableGb);
    expect(p.llama.install.backend).toBe("vulkan");
    expect(p.llama.skipped.map((s: { backend: string }) => s.backend)).toContain("cuda");
    // The dense 4b alternative would spill: rejected with the reason, not offered.
    const pick = plan.chatModelFor(f);
    expect(pick.alternatives.map((a: { tag: string }) => a.tag)).not.toContain("qwen3.5:4b");
    // The same card with little free video memory keeps the tier and only warns.
    expect(plan.chatModelFor(nvidia(4, 1.2)).tag).toBe("qwen3.5:2b-q4_K_M");
    expect(plan.chatModelFor(nvidia(4, 1.2)).warn).toMatch(/free right now/);
  });

  it("the owner's PC (6 GB card, 15.8 GB RAM with 5.8 free, CUDA 12 driver, cuDNN files): qwen3.5:4b on the GPU", () => {
    const f = nvidia(6, 5.2, {
      ramGb: 15.8,
      ramFreeGb: 5.8,
      cuda: { driverCuda: "12.6", cublas12: true, cudnn9: true, runtimeFilesFound: true },
    });
    const p = plan.buildSetupPlan(f, deps({ installedModels: ["qwen3:4b"] }));
    expect(p.chat.tag).toBe("qwen3.5:4b");
    expect(p.chat.device).toBe("gpu");
    // qwen3:4b is installed and works: it stays in use, the newer tag is offered, nothing is pulled or deleted.
    expect(p.chat.action).toBe("offer-upgrade");
    expect(p.chat.use).toBe("qwen3:4b");
    expect(p.chat.offer).toBe("qwen3.5:4b");
    expect(p.downloadBytes).toBeGreaterThanOrEqual(0);
    expect(p.llama.install.backend).toBe("cuda");
    expect(p.llama.install.source).toBe("release-api");
    expect(p.llama.install.digest).toBe("release-api-sha256");
    expect(p.llama.fallbacks).toEqual(["vulkan", "cpu-pinned"]);
    expect(p.packages.cudaLibs.action).toBe("present");
    expect(p.packages.ort.variant).toBe("gpu");
    // The CUDA libraries are on this PC, so the GPU build of ONNX Runtime is the one installed now.
    expect(p.packages.ort.installNow).toBe("gpu");
    expect(p.offered.map((o: { id: string }) => o.id)).not.toContain("onnxruntime-gpu");
  });

  it("a 12 GB card: qwen3.5:9b; a 24 GB card: qwen3.6:27b-q4_K_M", () => {
    expect(plan.chatModelFor(nvidia(12, 11)).tag).toBe("qwen3.5:9b");
    expect(plan.chatModelFor(nvidia(24, 23.2)).tag).toBe("qwen3.6:27b-q4_K_M");
  });

  it("an 8 GB card: the 4b q8 build, whatever is free right now; 16 GB: gemma4:12b", () => {
    expect(plan.chatModelFor(nvidia(8, 7.9)).tag).toBe("qwen3.5:4b-q8_0");
    expect(plan.chatModelFor(nvidia(8, 6.5)).tag).toBe("qwen3.5:4b-q8_0");
    expect(plan.chatModelFor(nvidia(16, 15)).tag).toBe("gemma4:12b");
  });

  it("weights plus 20 percent must fit the total: the 48 GB card takes the 39 GB tag, a 40 GB card does not", () => {
    expect(plan.chatModelFor(nvidia(48, 47.9)).tag).toBe("qwen3.6:35b-a3b-q8_0");
    expect(plan.chatModelFor(nvidia(48, 46.5)).tag).toBe("qwen3.6:35b-a3b-q8_0");
    expect(plan.chatModelFor(nvidia(40, 39)).tag).toBe("qwen3.6:35b-a3b-q4_K_M");
  });

  it("a card nearly full of other work keeps its tier (the total counts) and warns about the free memory", () => {
    const pick = plan.chatModelFor(nvidia(12, 5));
    expect(pick.tag).toBe("qwen3.5:9b");
    expect(pick.warn).toMatch(/close other apps/);
    expect(pick.memory.freeUsableGb).toBe(4);
  });

  it("alternatives that fit are listed, one that only fits as a mixture-of-experts split is marked", () => {
    const pick = plan.chatModelFor(nvidia(24, 23.2));
    expect(pick.alternatives.map((a: { tag: string }) => a.tag)).toContain("gemma4:26b-a4b-it-qat");
    const small = plan.chatModelFor(nvidia(12, 11));
    expect(small.alternatives.map((a: { tag: string }) => a.tag)).toContain("gemma4:12b-it-qat");
  });

  it("a dedicated AMD card (Vulkan only) gets the Vulkan llama.cpp build and a video-memory-sized Ollama model", () => {
    const f = base({
      vramGb: 8,
      gpuVendor: "amd",
      gpuName: "Test AMD card",
      gpus: [
        {
          vendor: "amd",
          name: "Test AMD card",
          vramGb: 8,
          vramCapped: false,
          driver: "24.1",
          integrated: false,
          computeCap: null,
        },
      ],
      vulkan: true,
    });
    const p = plan.buildSetupPlan(f, deps());
    expect(p.llama.install.backend).toBe("vulkan");
    expect(p.chat.device).toBe("gpu");
    expect(p.chat.backend).toBe("vulkan");
    expect(p.chat.estimated).toBe(true);
    expect(p.chat.tag).toBe("qwen3.5:4b-q8_0");
    expect(p.chat.reason).toMatch(/Vulkan, speed is estimated/);
    expect(p.packages.cudaLibs.action).toBe("skip");
    expect(p.packages.ort.variant).toBe("directml");
    expect(p.packages.ort.installNow).toBe("cpu");
  });

  it("an integrated graphics part counts as no GPU: CPU zip, CPU model, no Vulkan build", () => {
    const f = base({
      gpuVendor: "intel",
      gpus: [
        {
          vendor: "intel",
          name: "Test integrated part",
          vramGb: 0.5,
          vramCapped: false,
          driver: "31.0",
          integrated: true,
          computeCap: null,
        },
      ],
      vulkan: true,
    });
    const p = plan.buildSetupPlan(f, deps());
    expect(p.llama.install.backend).toBe("cpu");
    expect(p.llama.chain).toEqual(["cpu"]);
    expect(p.chat.device).toBe("cpu");
    expect(p.pc.integratedOnly).toBe(true);
    expect(p.packages.ort.variant).toBe("cpu");
  });

  it("a driver below what Ollama needs keeps chat on the CPU but may still plan the CUDA llama.cpp build", () => {
    const f = nvidia(12, 11);
    f["gpus"][0].driver = "540.10";
    const p = plan.buildSetupPlan(f, deps());
    expect(p.chat.device).toBe("cpu");
    expect(p.chat.reason).toMatch(/older than 550/);
    expect(p.llama.install.backend).toBe("cuda");
  });

  it("an NVIDIA driver without CUDA 12: no CUDA build, no CUDA libraries, no GPU chat", () => {
    const f = nvidia(12, 11, { cudaReady: false, cuda: { driverCuda: "11.8" } });
    const p = plan.buildSetupPlan(f, deps());
    expect(p.llama.install.backend).toBe("vulkan");
    expect(p.packages.cudaLibs.action).toBe("skip");
    expect(p.chat.device).toBe("cpu");
  });

  it("an unknown memory reading is treated as an 8 GB PC and says so", () => {
    const pick = plan.chatModelFor(base({ ramGb: null, ramFreeGb: null }));
    expect(pick.tag).toBe("qwen3.5:2b");
    expect(pick.notes.join(" ")).toMatch(/treated as an 8 GB PC/);
  });
});

describe("setup plan: installed models, disk, line", () => {
  const owner = () =>
    nvidia(6, 5.2, {
      ramGb: 15.8,
      ramFreeGb: 5.8,
      cuda: { driverCuda: "12.6", cublas12: true, cudnn9: true, runtimeFilesFound: true },
    });

  it("an installed model at least as good as the tier choice is kept and nothing is pulled", () => {
    const p = plan.buildSetupPlan(nvidia(12, 11), deps({ installedModels: ["qwen3.5:9b"] }));
    expect(p.chat.action).toBe("keep");
    expect(p.chat.use).toBe("qwen3.5:9b");
    expect(p.downloadBytes).toBeLessThan(0.5 * 1024 ** 3 + 5 * 1024 ** 3);
    expect(p.chat.reason).toMatch(/kept/);
  });

  it("the unversioned alias resolves to its real tag", () => {
    const p = plan.buildSetupPlan(nvidia(12, 11), deps({ installedModels: ["qwen3.5:latest"] }));
    expect(p.chat.action).toBe("keep");
  });

  it("an installed model that does not fit this PC is not used", () => {
    const p = plan.buildSetupPlan(
      owner(),
      deps({ installedModels: [{ name: "qwen3:32b", size: 20 * 1024 ** 3 }] }),
    );
    expect(p.chat.action).toBe("pull");
    expect(p.chat.use).toBe("qwen3.5:4b");
  });

  it("embedding models and unknown tags are ignored", () => {
    const p = plan.buildSetupPlan(
      owner(),
      deps({ installedModels: ["nomic-embed-text:latest", "something:7b", ""] }),
    );
    expect(p.chat.action).toBe("pull");
  });

  it("a far weaker installed model does not stop the pull", () => {
    const p = plan.buildSetupPlan(nvidia(24, 23.2), deps({ installedModels: ["llama3.2:3b"] }));
    expect(p.chat.action).toBe("pull");
    expect(p.chat.installed).toBe("llama3.2:3b");
  });

  it("a low disk picks a smaller model or none, and never more than the drive can take", () => {
    const f = noGpu(16, 12, { diskFreeGb: 3 });
    const pick = plan.chatModelFor(f);
    if (pick.tag) expect(pick.needs.diskGb).toBeLessThanOrEqual(3 - 1);
    const none = plan.chatModelFor(noGpu(16, 12, { diskFreeGb: 1.5 }));
    expect(none.tag).toBeNull();
    expect(none.reason).toMatch(/disk space/);
    const p = plan.buildSetupPlan(f, deps());
    expect(p.chat.needs === null || p.chat.needs.diskGb <= 2).toBe(true);
  });

  it("a metered line defers the big pulls and keeps the small pinned zip", () => {
    const f = owner();
    f["network"] = { online: true, metered: true };
    f["cuda"] = { driverCuda: "12.6", cublas12: false, cudnn9: false, runtimeFilesFound: false };
    const p = plan.buildSetupPlan(f, deps());
    expect(p.llama.install.backend).toBe("cpu");
    expect(p.llama.install.source).toBe("pinned");
    expect(p.llama.offered.backend).toBe("cuda");
    expect(p.packages.cudaLibs.action).toBe("defer");
    expect(p.packages.cudaLibs.deferReason).toMatch(/metered/);
    expect(p.chat.action).toBe("defer");
    expect(p.deferredBytes).toBeGreaterThan(1.2 * 1024 ** 3);
  });

  it("battery or a critical load defers big downloads too", () => {
    const onBattery = owner();
    onBattery["power"] = { batteryPresent: true, onAc: false };
    expect(plan.waitReason(onBattery, 600 * 1024 ** 2)).toMatch(/battery/);
    expect(plan.waitReason(onBattery, 10 * 1024 ** 2)).toBe("");
    const critical = owner();
    critical["health"] = { level: "critical", reasons: [] };
    expect(plan.waitReason(critical, 600 * 1024 ** 2)).toMatch(/load/);
  });

  it("offline: what is installed is used, nothing is downloaded, the rest waits", () => {
    const f = owner();
    f["network"] = { online: false };
    const p = plan.buildSetupPlan(
      f,
      deps({ installedModels: ["qwen3:4b"], installed: { llama: true } }),
    );
    expect(p.chat.use).toBe("qwen3:4b");
    expect(["keep", "offer-upgrade"]).toContain(p.chat.action);
    expect(p.llama.action).toBe("present");
    expect(p.downloadBytes).toBe(0);
    const bare = plan.buildSetupPlan(f, deps());
    expect(bare.chat.action).toBe("defer");
    expect(bare.llama.action).toBe("defer");
    expect(bare.downloadBytes).toBe(0);
    expect(bare.deferredBytes).toBeGreaterThan(0);
  });

  it("a GPU build is never planned when the disk cannot hold it", () => {
    const p = plan.buildSetupPlan(owner(), deps());
    expect(p.llama.install.backend).toBe("cuda");
    const tight = nvidia(6, 5.2, { diskFreeGb: 1.5 });
    const q = plan.buildSetupPlan(tight, deps());
    expect(q.llama.install.backend).toBe("cpu");
    expect(q.llama.skipped.some((s: { reason: string }) => /disk/.test(s.reason))).toBe(true);
  });
});

describe("setup plan: llama.cpp default and the real pin", () => {
  it("the default is the pinned CPU zip with its SHA-256; a PC with no GPU never gets a GPU build", () => {
    for (const f of [noGpu(8, 5), noGpu(16, 12), base({ vulkan: true })]) {
      const p = plan.buildSetupPlan(f, deps());
      expect(p.llama.install.backend).toBe("cpu");
      expect(p.llama.install.sha256).toBe("a".repeat(64));
      expect(p.llama.install.digest).toBe("pinned-sha256");
      expect(p.llama.fallbacks).toBeUndefined();
    }
  });

  it("reads the pin config/local-runners.json ships when none is injected", () => {
    const p = plan.buildSetupPlan(noGpu(16, 12), {});
    expect(p.llama.install.asset).toMatch(/^llama-b\d+-bin-win-cpu-x64\.zip$/);
    expect(p.llama.install.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(p.llama.bytes).toBeGreaterThan(1_000_000);
  });

  it("with no pin the CPU step reads its digest from the release API instead", () => {
    const p = plan.buildSetupPlan(noGpu(16, 12), deps({ llamaPin: null }));
    expect(p.llama.install.source).toBe("release-api");
  });
});

describe("setup plan: voice, output, never throws", () => {
  it("carries the voice plan's decision in the same object", () => {
    const p = plan.buildSetupPlan(noGpu(16, 12), deps());
    expect(p.voice.planned).toBe(true);
    expect(p.voice.install).toContain("supertonic-3");
    expect(p.voice.sttDevice).toBe("cpu");
    expect(p.voice.lines.length).toBeGreaterThan(0);
    expect(p.downloadBytes).toBeGreaterThan(p.voice.downloadBytes);
  });

  it("says why when no FRIDAY folder was given", () => {
    const p = plan.buildSetupPlan(noGpu(16, 12), { llamaPin: PIN });
    expect(p.voice.planned).toBe(false);
    expect(p.voice.reason).toMatch(/no FRIDAY folder/);
  });

  it("a voice plan that throws never throws the setup plan", () => {
    const p = plan.buildSetupPlan(
      noGpu(16, 12),
      deps({
        voiceWeights: {
          voiceInstallPlan: () => {
            throw new Error("boom");
          },
        },
      }),
    );
    expect(p.voice.planned).toBe(false);
    expect(p.voice.reason).toMatch(/boom/);
  });

  it("describePlan prints the 'this PC' block in the [friday] INFO style", () => {
    const f = nvidia(6, 5.2, {
      ramGb: 15.8,
      ramFreeGb: 5.8,
      cuda: { driverCuda: "12.6", cublas12: true, cudnn9: true, runtimeFilesFound: true },
    });
    const lines: string[] = plan.describePlan(plan.buildSetupPlan(f, deps()));
    expect(lines.every((l) => l.startsWith("[friday] INFO     "))).toBe(true);
    const joined = lines.join("\n");
    expect(joined).toMatch(/this PC: 15\.8 GB RAM \(5\.8 GB free\)/);
    expect(joined).toMatch(/6 GB video memory \(5\.2 GB free\), compute 7\.5/);
    expect(joined).toMatch(/CUDA 12: driver yes, cuBLAS\/cuDNN files found/);
    expect(joined).toMatch(/llama\.cpp: install cuda/);
    expect(joined).toMatch(/chat model: pull qwen3\.5:4b/);
    expect(joined).toMatch(/ONNX Runtime: install gpu - the CUDA libraries are on this PC/);
    expect(joined).toMatch(/chat context: \d+k tokens/);
    expect(joined).toMatch(/download now:/);
  });

  it("describePlan says what is skipped and why on a PC without a GPU", () => {
    const joined = plan.describePlan(plan.buildSetupPlan(noGpu(16, 12), deps())).join("\n");
    expect(joined).toMatch(/graphics: no GPU found/);
    expect(joined).toMatch(/skipped cuda-libs: no NVIDIA graphics card/);
    expect(joined).toMatch(/skipped llama\.cpp:cuda/);
  });

  it("toJSON is plain data: the required set, skipped and offered rows", () => {
    const f = nvidia(6, 5.2, {
      cuda: { driverCuda: "12.6", cublas12: true, cudnn9: true, runtimeFilesFound: true },
    });
    const json = plan.toJSON(plan.buildSetupPlan(f, deps()));
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    const ids = json.required.map((r: { id: string }) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining(["llama.cpp", "qwen3.5:4b", "cuda-libs", "onnxruntime"]),
    );
    const none = plan.toJSON(plan.buildSetupPlan(noGpu(16, 12), deps()));
    expect(none.required.map((r: { id: string }) => r.id)).not.toContain("cuda-libs");
    expect(none.skipped.some((s: { id: string }) => s.id === "cuda-libs")).toBe(true);
  });

  it("garbage facts never throw", () => {
    for (const f of [null, undefined, "x", 7, [], {}, { gpus: "no", network: 3, ramGb: "lots" }]) {
      expect(() => plan.describePlan(plan.buildSetupPlan(f, deps()))).not.toThrow();
      expect(() => plan.toJSON(plan.buildSetupPlan(f, deps()))).not.toThrow();
    }
    const p = plan.buildSetupPlan(null, deps());
    expect(p.llama.install.backend).toBe("cpu");
  });

  it("Ollama settings are recorded, not forced", () => {
    const small = plan.buildSetupPlan(nvidia(6, 5.2), deps()).chat.settings;
    expect(small.forced).toBe(false);
    expect(small.options.num_ctx).toBe(8192);
    expect(small.keep_alive).toBe("30m");
    expect(small.env.OLLAMA_KV_CACHE_TYPE).toBe("f16");
    // Ollama accepts 0 or 1 for this variable: "automatic" is the unset default and is never written to it.
    expect(small.env.OLLAMA_FLASH_ATTENTION).toBeUndefined();
    expect(tiersFile.ollamaSettings.env.OLLAMA_FLASH_ATTENTION).toBeUndefined();
    expect(tiersFile.ollamaSettings.flashAttention).toBe("automatic");
    expect(small.env.OLLAMA_MAX_LOADED_MODELS).toBe("1");
    const big = plan.buildSetupPlan(nvidia(24, 23.2), deps()).chat.settings;
    expect(big.env.OLLAMA_MAX_LOADED_MODELS).toBeUndefined();
  });
});

describe("setup plan: the tier table and the source", () => {
  const rows = (): any[] => tiersFile.tiers;

  it("covers every PC class the packet names, each with tag, size, context and capabilities", () => {
    expect(rows().map((r) => r.id)).toEqual([
      "cpu-ram-under-8",
      "cpu-ram-8",
      "cpu-ram-16",
      "cpu-ram-24",
      "cpu-ram-32",
      "cpu-ram-64",
      "gpu-4",
      "gpu-6",
      "gpu-8",
      "gpu-12",
      "gpu-16",
      "gpu-24",
      "gpu-32",
      "gpu-48",
    ]);
    for (const r of rows()) {
      expect(String(r.tag)).toMatch(/^[a-z0-9.-]+:[A-Za-z0-9._-]+$/);
      expect(Number(r.downloadGb)).toBeGreaterThan(0);
      expect(Number(r.contextK)).toBeGreaterThan(0);
      expect((r.capabilities as string[]).length).toBeGreaterThan(0);
      expect(String(r.licence)).toBeTruthy();
      expect(String(r.unverified)).toMatch(/estimates/);
      expect(plan.qualityOf(String(r.tag), tiersFile)).not.toBeNull();
    }
  });

  it("never lists a superseded, community or Apple-oriented tag", () => {
    const tags = rows().flatMap((r) => [
      String(r.tag),
      ...((r.alternatives as Array<{ tag: string }>) || []).map((a) => a.tag),
    ]);
    for (const tag of tags) {
      expect(tag).not.toMatch(/-mtp-|-mlx|mxfp8|nvfp4|^qwen3:|phi4|sarvam/i);
    }
    expect(tiersFile.rules.partialOffloadByDefault).toBe(false);
  });

  it("marks what was not read from the library page", () => {
    const text = JSON.stringify(tiersFile);
    expect(text).toMatch(/sizeUnverified/);
    expect(text).toMatch(/licenceUnverified/);
    expect(text).toMatch(/contextUnverified/);
  });

  it("the module never branches on a graphics card's name", () => {
    const source = readFileSync(path.join(root, "electron/setup-plan.cjs"), "utf8");
    expect(source).not.toMatch(
      /\b(rtx|gtx|geforce|radeon|quadro|titan|iris|arc\s?a\d|rx\s?\d{3,4})\b/i,
    );
    expect(source).not.toMatch(/\.name\s*(===|!==|==|!=|\.test|\.includes|\.match)/);
    expect(source).not.toMatch(/(?:name|gpuName)\)?\s*\.(?:test|includes|match|startsWith)\(/);
    expect(JSON.stringify(tiersFile)).not.toMatch(/\b(rtx|gtx|geforce|radeon)\b/i);
  });
});
