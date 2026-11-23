/**
 * Engine fit: one pure verdict (supported, limited, unsupported) per Install Manager row on any PC, from no GPU to a
 * big one. The facts are the shape `hardwareFacts` returns; nothing here reads a real PC, a clock or the network.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const fit = require_(path.join(root, "electron/engine-fit.cjs"));
const pins = require_(path.join(root, "electron/voice-pins.cjs"));
const hardware = require_(path.join(root, "electron/hardware.cjs"));

type Facts = Record<string, unknown>;

/** A measured PC. Every field the probes fill is here; `over` replaces whole top-level keys. */
function pc(over: Facts = {}): Facts {
  return {
    vramGb: null,
    vramFreeGb: null,
    ramGb: 16,
    ramFreeGb: 10,
    diskFreeGb: 200,
    gpuVendor: null,
    gpuName: null,
    gpus: [],
    cudaReady: false,
    driverVersion: null,
    npu: false,
    cpuClass: "mid",
    sources: ["os-memory", "model-drive"],
    os: { is64Bit: true, build: 22631, platform: "win32" },
    cpu: { avx2: true, avx512: false },
    memory: { pressure: "ok" },
    modelDrive: { letter: "D:", freeGb: 200, media: "ssd" },
    vulkan: false,
    cuda: { driverCuda: null, cublas12: null, cudnn9: null, dllDirs: [], runtimeFilesFound: null },
    network: { online: true, type: "ethernet", metered: false, roaming: false, latencyMs: 20 },
    power: { onAc: true, batterySaver: false },
    ...over,
  };
}

function nvidia(
  vramGb: number,
  extra: { cudnn?: boolean; driverCuda?: string; free?: number } = {},
) {
  const cudnn = extra.cudnn ?? true;
  return pc({
    vramGb,
    vramFreeGb: extra.free ?? vramGb - 0.8,
    gpuVendor: "nvidia",
    gpuName: "Some NVIDIA card",
    gpus: [
      {
        vendor: "nvidia",
        name: "Some NVIDIA card",
        vramGb,
        vramCapped: false,
        driver: "576.80",
        integrated: false,
      },
    ],
    cudaReady: true,
    driverVersion: "576.80",
    sources: ["nvidia-smi", "os-memory", "model-drive"],
    vulkan: true,
    cuda: {
      driverCuda: extra.driverCuda ?? "12.9",
      cublas12: cudnn,
      cudnn9: cudnn,
      dllDirs: [],
      runtimeFilesFound: cudnn,
    },
  });
}

const igpu = () =>
  pc({
    gpuVendor: "intel",
    gpus: [
      {
        vendor: "intel",
        name: "iGPU",
        vramGb: null,
        vramCapped: false,
        driver: "31.0",
        integrated: true,
      },
    ],
    sources: ["Win32_VideoController", "os-memory", "model-drive"],
    vulkan: true,
  });

const CUDA_LIBS = {
  id: "CUDA runtime libraries",
  requirements: { gpu: "nvidia", cudaMin: "12", computeCapMin: 7.5, diskBytes: 1_249_463_701 },
};
const ORT_GPU = {
  id: "ONNX Runtime (GPU)",
  requirements: {
    gpu: "nvidia",
    cudaMin: "12",
    cudaLibs: true,
    diskBytes: 157_765_830,
    alternative: "ONNX Runtime (DirectML)",
  },
};
const ORT_DML = {
  id: "ONNX Runtime (DirectML)",
  requirements: { gpu: "any", diskBytes: 25_111_930 },
};
const LLAMA_CUDA = {
  id: "llama.cpp CUDA",
  requirements: {
    gpu: "nvidia",
    cudaMin: "12.4",
    vramGb: 4,
    heavyGpu: true,
    alternative: "llama.cpp",
  },
};
const code = (v: { reasons: { code: string }[] }) => v.reasons.map((r) => r.code);

describe("classify: a PC with no GPU", () => {
  const facts = pc();
  it("runs CPU rows and says nothing about a GPU", () => {
    const v = fit.classify({ id: "ONNX Runtime", requirements: { diskBytes: 16_698_767 } }, facts);
    expect(v.state).toBe("supported");
    expect(v.recommended).toBe(true);
  });
  it("is unsupported for every NVIDIA and DirectML row, with the alternative named", () => {
    const cuda = fit.classify(CUDA_LIBS, facts);
    expect(cuda.state).toBe("unsupported");
    expect(code(cuda)).toContain("no-nvidia-gpu");
    const gpu = fit.classify(ORT_GPU, facts);
    expect(gpu.state).toBe("unsupported");
    expect(gpu.alternative).toBe("ONNX Runtime (DirectML)");
    expect(fit.classify(ORT_DML, facts)).toMatchObject({ state: "unsupported" });
    expect(code(fit.classify(ORT_DML, facts))).toContain("no-gpu");
  });
  it("a heavy voice model that cannot run on a CPU is unsupported, a CPU one is fine", () => {
    const large = pins.manifestFor("Systran/faster-whisper-large-v3");
    expect(fit.classify({ id: "large", facts: large }, facts).state).toBe("unsupported");
    const small = pins.manifestFor("Systran/faster-whisper-small");
    expect(fit.classify({ id: "small", facts: small }, facts).state).toBe("supported");
  });
});

describe("classify: an integrated GPU", () => {
  it("runs DirectML, is unsupported for CUDA, and Vulkan builds are fine", () => {
    const facts = igpu();
    expect(fit.classify(ORT_DML, facts).state).toBe("supported");
    expect(fit.classify(CUDA_LIBS, facts).state).toBe("unsupported");
    expect(
      fit.classify({ id: "vk", requirements: { vulkan: true, diskBytes: 40_000_000 } }, facts)
        .state,
    ).toBe("supported");
  });
});

describe("classify: NVIDIA cards of 6, 16 and 24 GB", () => {
  for (const gb of [6, 16, 24]) {
    it(`${gb} GB with the CUDA pair: CUDA libs, ORT GPU and the CUDA llama.cpp all fit`, () => {
      const facts = nvidia(gb);
      expect(fit.classify(CUDA_LIBS, facts).state).toBe("supported");
      expect(fit.classify(ORT_GPU, facts).state).toBe("supported");
      expect(fit.classify(LLAMA_CUDA, facts).state).toBe("supported");
      const large = fit.classify(
        { id: "l", facts: pins.manifestFor("Systran/faster-whisper-large-v3") },
        facts,
      );
      expect(large.state).toBe(gb >= 6 ? "supported" : "unsupported");
    });
    it(`${gb} GB without cuDNN: ORT GPU is limited and points at the DirectML row; the libs row still fits`, () => {
      const facts = nvidia(gb, { cudnn: false });
      const v = fit.classify(ORT_GPU, facts);
      expect(v.state).toBe("limited");
      expect(code(v)).toContain("cuda-libs-missing");
      expect(v.alternative).toBe("ONNX Runtime (DirectML)");
      expect(fit.classify(CUDA_LIBS, facts).state).toBe("supported");
    });
  }

  it("a driver too old for CUDA 12 is unsupported and names the driver floor", () => {
    const facts = nvidia(8, { driverCuda: "11.8" });
    const v = fit.classify(CUDA_LIBS, facts);
    expect(v.state).toBe("unsupported");
    expect(code(v)).toContain("driver-too-old");
    expect(v.needs.driverMin).toBe("527.41");
    expect(fit.classify(LLAMA_CUDA, nvidia(8, { driverCuda: "12.2" })).state).toBe("unsupported");
    expect(fit.classify(LLAMA_CUDA, nvidia(8, { driverCuda: "12.4" })).state).toBe("supported");
  });

  it("a card below the compute capability floor is unsupported when a probe supplied it", () => {
    const facts = nvidia(8);
    (facts["gpus"] as { computeCap?: number }[])[0]!.computeCap = 6.1;
    expect(code(fit.classify(CUDA_LIBS, facts))).toContain("compute-too-old");
    expect(fit.classify(CUDA_LIBS, nvidia(8)).state).toBe("supported"); // not measured: never blocks
  });

  it("less video memory than the minimum is unsupported, and a busy card is only limited", () => {
    expect(fit.classify(LLAMA_CUDA, nvidia(3)).state).toBe("unsupported");
    const busy = fit.classify(LLAMA_CUDA, nvidia(8, { free: 2 }));
    expect(busy.state).toBe("limited");
    expect(code(busy)).toContain("vram-busy");
  });

  it("an unmeasured driver or card size reads as limited, never unsupported", () => {
    const f = nvidia(8);
    f["cuda"] = {
      driverCuda: null,
      cublas12: null,
      cudnn9: null,
      dllDirs: [],
      runtimeFilesFound: null,
    };
    f["driverVersion"] = null;
    (f["gpus"] as { driver: string | null }[])[0]!.driver = null;
    const v = fit.classify(LLAMA_CUDA, f);
    expect(v.state).toBe("limited");
    expect(code(v)).toContain("driver-unknown");
  });
});

describe("classify: small memory, low disk, metered line, battery", () => {
  it("4 GB of RAM: a model that needs more is unsupported, a tight one is limited", () => {
    const facts = pc({ ramGb: 4, ramFreeGb: 2 });
    const small = pins.manifestFor("Systran/faster-whisper-small"); // min 0.8, recommended 1.2
    expect(fit.classify({ id: "s", facts: small }, facts).state).toBe("supported");
    const medium = { id: "m", requirements: { ramGb: 6 } };
    expect(fit.classify(medium, facts).state).toBe("unsupported");
    const tight = { id: "t", requirements: { ramGb: 3, ramRecommendedGb: 8 } };
    const v = fit.classify(tight, facts);
    expect(v.state).toBe("limited");
    expect(code(v)).toContain("ram-tight");
  });

  it("RAM that is free only in total, not now, is limited", () => {
    const v = fit.classify(
      { id: "x", requirements: { ramGb: 6 } },
      pc({ ramGb: 16, ramFreeGb: 3 }),
    );
    expect(v.state).toBe("limited");
    expect(code(v)).toContain("ram-busy");
  });

  it("disk: not enough is unsupported, enough but under 1.3 times is limited, uses the model drive", () => {
    const row = { id: "big", requirements: { diskBytes: 10 * 1024 ** 3 } };
    expect(
      fit.classify(row, pc({ modelDrive: { letter: "C:", freeGb: 6, media: "ssd" } })).state,
    ).toBe("unsupported");
    const tight = fit.classify(row, pc({ modelDrive: { letter: "C:", freeGb: 11, media: "hdd" } }));
    expect(tight.state).toBe("limited");
    expect(code(tight)).toContain("disk-tight");
    expect(fit.classify(row, pc({ modelDrive: { letter: "C:", freeGb: 30 } })).state).toBe(
      "supported",
    );
    // the model drive wins over a roomier system drive figure
    expect(
      fit.classify(row, pc({ diskFreeGb: 500, modelDrive: { letter: "E:", freeGb: 4 } })).state,
    ).toBe("unsupported");
    expect(fit.classify(row, pc({ modelDrive: null, diskFreeGb: null })).state).toBe("limited");
    // an installed row needs no new disk
    expect(
      fit.classify({ ...row, installed: true }, pc({ modelDrive: { letter: "C:", freeGb: 1 } }))
        .state,
    ).toBe("supported");
  });

  it("a metered connection marks a big download limited and a small one fine; offline waits", () => {
    const big = { id: "cudnn", requirements: { diskBytes: 696_300_805 } };
    const small = { id: "tiny", requirements: { diskBytes: 9_000_000 } };
    const metered = pc({
      network: { online: true, metered: true, roaming: false, type: "cellular", latencyMs: 80 },
    });
    const v = fit.classify(big, metered);
    expect(v.state).toBe("limited");
    expect(code(v)).toContain("metered-network");
    expect(fit.classify(small, metered).state).toBe("supported");
    const offline = fit.classify(big, pc({ network: { online: false, metered: null } }));
    expect(offline.state).toBe("limited");
    expect(code(offline)).toContain("offline");
    expect(fit.classify({ ...big, installed: true }, metered).state).toBe("supported");
  });

  it("on battery marks a heavy GPU row limited, a light row unaffected", () => {
    const facts = nvidia(8);
    (facts as { power: unknown }).power = { onAc: false, batterySaver: false };
    const v = fit.classify(LLAMA_CUDA, facts);
    expect(v.state).toBe("limited");
    expect(code(v)).toContain("on-battery");
    expect(fit.classify(CUDA_LIBS, facts).state).toBe("supported");
  });

  it("no AVX2 blocks the AVX2 build only; Vulkan rows follow the Vulkan fact", () => {
    const avx = { id: "avx2", requirements: { avx2: true } };
    expect(fit.classify(avx, pc({ cpu: { avx2: false } })).state).toBe("unsupported");
    expect(fit.classify(avx, pc({ cpu: { avx2: null } })).state).toBe("limited");
    const vk = { id: "vk", requirements: { vulkan: true } };
    expect(fit.classify(vk, pc({ vulkan: false })).state).toBe("unsupported");
    expect(fit.classify(vk, pc({ vulkan: null })).state).toBe("limited");
  });
});

describe("classify: unknown never blocks, bad input never throws", () => {
  it("a row with no requirements is supported on every PC, including a PC never probed", () => {
    for (const facts of [pc(), nvidia(8), null, undefined, {}, "x", 42]) {
      expect(fit.classify({ id: "plain" }, facts as never).state).toBe("supported");
    }
  });
  it("before any probe answered, GPU rows are limited (unknown), never unsupported", () => {
    const unprobed = hardware.hardwareFacts(null);
    for (const row of [CUDA_LIBS, ORT_GPU, ORT_DML, LLAMA_CUDA]) {
      expect(fit.classify(row, unprobed).state).toBe("limited");
    }
  });
  it("garbage rows and facts return a verdict of the fixed shape", () => {
    for (const row of [null, undefined, 5, "x", { requirements: "nope" }, { facts: [1] }]) {
      const v = fit.classify(row as never, { gpus: "x", cuda: 5 } as never);
      expect(["supported", "limited", "unsupported"]).toContain(v.state);
      expect(v.needs).toHaveProperty("ramGb");
      expect(Array.isArray(v.reasons)).toBe(true);
    }
  });
  it("32-bit Windows blocks every row", () => {
    expect(fit.classify({ id: "x" }, pc({ os: { is64Bit: false } })).state).toBe("unsupported");
  });
  it("needs carries the units the UI shows", () => {
    const v = fit.classify(LLAMA_CUDA, nvidia(8));
    expect(v.needs).toMatchObject({ vramGb: 4, cuda: true, driverMin: "551.61", network: false });
    const big = fit.classify(CUDA_LIBS, nvidia(8));
    expect(big.needs.diskGb).toBeCloseTo(1.5, 1);
    expect(big.needs.network).toBe(true);
  });
  it("the voice manifest is read as it is and recommended follows its priority", () => {
    const facts = pc({ ramGb: 16 });
    const primary = fit.classify(
      { id: "p", facts: pins.manifestFor("Systran/faster-whisper-small") },
      facts,
    );
    expect(primary.recommended).toBe(true);
    const light = fit.classify(
      { id: "l", facts: pins.manifestFor("Systran/faster-whisper-tiny") },
      facts,
    );
    expect(light.state).toBe("supported");
    expect(light.recommended).toBe(false); // plenty of memory: the small model is the pick
    expect(
      fit.classify(
        { id: "l", facts: pins.manifestFor("Systran/faster-whisper-tiny") },
        pc({ ramGb: 4 }),
      ).recommended,
    ).toBe(true);
    expect(
      fit.classify(
        { id: "e", facts: pins.manifestFor("MSpider3/whisper-hindi2hinglish-swift-ct2") },
        facts,
      ).recommended,
    ).toBe(false);
  });
  it("no row or branch in the module names a graphics card", () => {
    const src = require_("node:fs").readFileSync(
      path.join(root, "electron/engine-fit.cjs"),
      "utf8",
    );
    expect(src).not.toMatch(/\b(RTX|GTX|Radeon|Arc A|Quadro|Tesla|GeForce)\b/);
  });
});

describe("splitByState", () => {
  it("groups row ids by state and ignores rows without a verdict", () => {
    const rows = [
      { id: "a", fit: { state: "supported" } },
      { id: "b", fit: { state: "limited" } },
      { id: "c", fit: { state: "unsupported" } },
      { id: "d" },
      { id: "e", fit: { state: "supported" } },
    ];
    expect(fit.splitByState(rows)).toEqual({
      supported: ["a", "e"],
      limited: ["b"],
      unsupported: ["c"],
    });
    expect(fit.splitByState(null)).toEqual({ supported: [], limited: [], unsupported: [] });
  });
});
