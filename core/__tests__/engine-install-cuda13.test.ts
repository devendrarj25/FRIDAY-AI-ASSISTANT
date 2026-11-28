/**
 * The CUDA 13 libraries bundle and the GPU health check (electron/engine-install.cjs). The pinned ONNX Runtime GPU
 * wheel (1.32.0) is built for CUDA 13, so it needs the CUDA 13 libraries, not the CUDA 12 ones that ctranslate2 keeps
 * using. Drivers 576-579 get a CUDA 12 ONNX Runtime set, older drivers DirectML. The health check builds a real
 * session on a tiny Identity graph and must see CUDAExecutionProvider first; the wheel pins are the PyPI digests.
 * Linux evidence only: the real CUDA DLL names and a real GPU session are unverified on Windows.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const engines = require_(path.join(root, "electron/engine-install.cjs"));

type Asset = { name: string; bytes: number; sha256: string };
const pins = engines.PINNED_WHEELS as Record<
  string,
  { version: string; dist?: string; pinnedOnly?: boolean; assets: Asset[] }
>;
const bundles = engines.PIP_BUNDLES as Record<
  string,
  {
    parts: Array<{ dist: string; pin?: string; pythonSpecific: boolean }>;
    conflicts: string[];
    requires?: string[];
    verifyImport: string;
  }
>;

// Digests read from the PyPI JSON of each file (win_amd64 wheels).
const CU13 = {
  "nvidia-cuda-runtime": [
    "13.5.37",
    "f225d3fa5ea6bfbb58fc4979ef72375cbe661d9107f0d8a4ff22cc151525e4a9",
  ],
  "nvidia-cuda-nvrtc": [
    "13.5.37",
    "e8e6c10b251385707ae3abd7b4ee118de6736fd7678d0f0f4eab4d759f679c21",
  ],
  "nvidia-nvjitlink": [
    "13.5.37",
    "4465d4e8f2212118220b580c82523c5654f93a62906bd51d29d79bdfc12376c1",
  ],
  "nvidia-cufft": ["12.5.0.14", "78e7585159ecf37d73af1ce43a5dea7fd3360e1af71cde08f070c07966a336bc"],
  "nvidia-curand": [
    "10.4.5.25",
    "f6a02a70f5b9715235df31a164a4bf3237a45be1600a5f435f5e4a0d8682eb22",
  ],
  "nvidia-cublas": [
    "13.10.0.20",
    "c310b749eea855b88fafb906de08d6819b87216c6711640771764fea5dcd8546",
  ],
  "nvidia-cudnn-cu13": [
    "9.28.1.4",
    "73d874c6bd8a1c75ca040228f77c4e163efe9bab3b65bd85914e2b7334ac68ee",
  ],
} as const;

describe("the cuda13-libs bundle", () => {
  it("holds the seven CUDA 13 libraries at the pinned versions and PyPI digests", () => {
    const bundle = bundles["cuda13-libs"]!;
    expect(bundle.parts.map((p) => p.dist).sort()).toEqual(Object.keys(CU13).sort());
    for (const part of bundle.parts) {
      expect(part.pythonSpecific).toBe(false);
      const [version, sha] = CU13[part.dist as keyof typeof CU13];
      expect(pins[part.dist]!.version).toBe(version);
      expect(pins[part.dist]!.assets).toHaveLength(1);
      const asset = pins[part.dist]!.assets[0]!;
      expect(asset.sha256).toBe(sha);
      expect(asset.name).toMatch(/-py3-none-win_amd64\.whl$/);
      expect(asset.bytes).toBeGreaterThan(1_000_000);
    }
    expect(bundle.conflicts).toEqual([]);
  });

  it("plans one hashed requirement line per library", () => {
    const bundle = bundles["cuda13-libs"]!;
    const resolved = Object.fromEntries(
      bundle.parts.map((p) => [
        p.dist,
        { ok: true, version: pins[p.dist]!.version, assets: pins[p.dist]!.assets },
      ]),
    );
    const plan = engines.planWheels(bundle, resolved);
    expect(plan.ok).toBe(true);
    expect(plan.lines).toHaveLength(7);
    expect(plan.lines).toContain(
      `nvidia-cublas==13.10.0.20 --hash=sha256:${CU13["nvidia-cublas"][1]}`,
    );
  });

  it("leaves cuda-libs (CUDA 12, for ctranslate2) exactly as it was", () => {
    const bundle = bundles["cuda-libs"]!;
    expect(bundle.parts.map((p) => p.dist)).toEqual(["nvidia-cublas-cu12", "nvidia-cudnn-cu12"]);
    expect(pins["nvidia-cublas-cu12"]!.version).toBe("12.9.2.10");
    expect(pins["nvidia-cudnn-cu12"]!.version).toBe("9.28.1.4");
    expect(bundle.verifyImport).toBe("import nvidia.cublas, nvidia.cudnn");
  });
});

describe("the ONNX Runtime GPU sets", () => {
  it("ort-gpu (1.32.0, built for CUDA 13) requires cuda13-libs", () => {
    expect(bundles["ort-gpu"]!.requires).toEqual(["cuda13-libs"]);
    expect(pins["onnxruntime-gpu"]!.version).toBe("1.32.0");
  });

  it("ort-gpu-cu12 pins ORT 1.26.0 for CUDA 12 and requires cuda-libs plus the extra CUDA 12 libraries", () => {
    const bundle = bundles["ort-gpu-cu12"]!;
    expect(bundle.parts).toEqual([
      { dist: "onnxruntime-gpu", pin: "onnxruntime-gpu-cu12", pythonSpecific: true },
    ]);
    expect(bundle.requires).toEqual(["cuda-libs", "cuda12-ort-libs"]);
    expect(bundle.conflicts.sort()).toEqual(["onnxruntime", "onnxruntime-directml"]);
    const pin = pins["onnxruntime-gpu-cu12"]!;
    expect(pin.version).toBe("1.26.0");
    expect(pin.pinnedOnly).toBe(true);
    const byTag = Object.fromEntries(
      pin.assets.map((a) => [/-(cp\d+)-/.exec(a.name)![1], a.sha256]),
    );
    expect(byTag).toEqual({
      cp311: "cc5329aad02d9745cc3ae9cdb185bfa1aad242a7bf89b8c471280002ec40f98a",
      cp312: "5f49c44689894650990e4c8a857d2edafc276fbd79bba57ceb224bd18d25d491",
      cp313: "6ab9f9c741d2e239b2e321ab0d389c04329d4ab7f11e3b92dd3aa7db1c59dee4",
      cp314: "3e592439b0183d303c2374517b5b392599a3d50b2dc9de949b9b15731ac921c9",
    });
  });

  it("the cu12 plan installs the name onnxruntime-gpu at 1.26.0 with the cp312 hash", () => {
    const bundle = bundles["ort-gpu-cu12"]!;
    const pin = pins["onnxruntime-gpu-cu12"]!;
    const plan = engines.planWheels(
      bundle,
      { "onnxruntime-gpu-cu12": { ok: true, version: pin.version, assets: pin.assets } },
      { pyTag: "cp312" },
    );
    expect(plan.ok).toBe(true);
    expect(plan.lines).toEqual([
      "onnxruntime-gpu==1.26.0 --hash=sha256:5f49c44689894650990e4c8a857d2edafc276fbd79bba57ceb224bd18d25d491",
    ]);
    expect(plan.wheels[0].dist).toBe("onnxruntime-gpu");
  });

  it("cuda12-ort-libs adds cuFFT, cuRAND, the runtime, NVRTC and nvJitLink of CUDA 12.9", () => {
    const bundle = bundles["cuda12-ort-libs"]!;
    expect(bundle.parts.map((p) => p.dist).sort()).toEqual([
      "nvidia-cuda-nvrtc-cu12",
      "nvidia-cuda-runtime-cu12",
      "nvidia-cufft-cu12",
      "nvidia-curand-cu12",
      "nvidia-nvjitlink-cu12",
    ]);
    expect(pins["nvidia-cufft-cu12"]!.assets[0]!.sha256).toBe(
      "8e5bfaac795e93f80611f807d42844e8e27e340e0cde270dcb6c65386d795b80",
    );
    expect(pins["nvidia-curand-cu12"]!.assets[0]!.sha256).toBe(
      "e8129e6ac40dc123bd948e33d3e11b4aa617d87a583fa2f21b3210e90c743cde",
    );
    expect(pins["nvidia-cuda-runtime-cu12"]!.assets[0]!.sha256).toBe(
      "8e018af8fa02363876860388bd10ccb89eb9ab8fb0aa749aaf58430a9f7c4891",
    );
    expect(pins["nvidia-cuda-nvrtc-cu12"]!.assets[0]!.sha256).toBe(
      "72972ebdcf504d69462d3bcd67e7b81edd25d0fb85a2c46d3ea3517666636349",
    );
    expect(bundle.requires).toEqual(["cuda-libs"]);
  });

  it("every pinned wheel carries a 64-hex digest and a Windows file name", () => {
    for (const [name, pin] of Object.entries(pins)) {
      for (const a of pin.assets) {
        expect(a.sha256, `${name} ${a.name}`).toMatch(/^[a-f0-9]{64}$/);
        expect(a.name, name).toMatch(/win_amd64\.whl$/);
      }
    }
  });

  it("wheelSources never asks PyPI for the newest build of a pinned-only set", () => {
    expect(
      engines.wheelSources("onnxruntime-gpu-cu12").map((s: { kind: string }) => s.kind),
    ).toEqual(["pinned"]);
    expect(engines.wheelSources("nvidia-cublas").map((s: { kind: string }) => s.kind)).toEqual([
      "pypi-json",
      "pypi-simple",
      "pinned",
    ]);
  });
});

describe("gpuStackFor: the driver picks the stack", () => {
  const pick = (driver: unknown) => engines.gpuStackFor(driver);
  it("580 and above: CUDA 13 libraries then ORT 1.32.0", () => {
    for (const driver of ["580.00", "581.15", "596.36", 590, "580"]) {
      expect(pick(driver)).toMatchObject({
        tier: "cuda13",
        bundles: ["cuda13-libs", "ort-gpu"],
      });
    }
  });
  it("576 to 579: the CUDA 12 set with ORT 1.26.0", () => {
    for (const driver of ["576.02", "579.99", 578]) {
      expect(pick(driver)).toMatchObject({
        tier: "cuda12",
        bundles: ["cuda-libs", "cuda12-ort-libs", "ort-gpu-cu12"],
      });
    }
  });
  it("below 576, unknown or unreadable: DirectML, no CUDA libraries", () => {
    for (const driver of ["575.99", "552.22", "", null, undefined, "garbage", NaN]) {
      expect(pick(driver)).toMatchObject({ tier: "directml", bundles: ["ort-directml"] });
    }
  });
  it("names the floors and every bundle it returns exists", () => {
    expect(engines.CUDA13_DRIVER_FLOOR).toBe(580);
    expect(engines.CUDA12_DRIVER_FLOOR).toBe(576);
    for (const driver of ["600", "578", "500"]) {
      for (const id of pick(driver).bundles) expect(bundles[id], id).toBeTruthy();
    }
  });
});

describe("the GPU health check", () => {
  it("is the verification of both GPU ORT sets", () => {
    expect(bundles["ort-gpu"]!.verifyImport).toBe(engines.GPU_HEALTH_PROBE);
    expect(bundles["ort-gpu-cu12"]!.verifyImport).toBe(engines.GPU_HEALTH_PROBE);
  });

  it("preloads the DLLs, builds a real session and requires CUDAExecutionProvider first", () => {
    const code = String(engines.GPU_HEALTH_PROBE);
    expect(code).toMatch(/preload_dlls/);
    expect(code).toMatch(/InferenceSession\(/);
    expect(code).toMatch(
      /providers=\[['"]CUDAExecutionProvider['"],\s*['"]CPUExecutionProvider['"]\]/,
    );
    expect(code).toMatch(/get_providers\(\)\[0\]\s*==\s*['"]CUDAExecutionProvider['"]/);
    expect(code).toMatch(/else 3\)/);
  });

  // A fake onnxruntime module drives the probe's real Python code on any machine that has python3.
  const python = ["python3", "python"].find(
    (exe) => spawnSync(exe, ["-c", "pass"], { encoding: "utf8" }).status === 0,
  );
  const run = (module: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-ortfake-"));
    try {
      mkdirSync(path.join(dir, "onnxruntime"));
      writeFileSync(path.join(dir, "onnxruntime", "__init__.py"), module);
      return spawnSync(python!, ["-c", engines.GPU_HEALTH_PROBE], {
        encoding: "utf8",
        cwd: dir,
        env: { PATH: process.env["PATH"] ?? "", PYTHONPATH: dir },
      }).status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const fake = (providers: string, extra = "") => `
class InferenceSession:
    def __init__(self, model, providers=None):
        assert isinstance(model, (bytes, bytearray)) and model[:2] == b"\\x08\\x08"
        assert providers == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    def get_providers(self):
        return ${providers}
${extra}
`;

  it.runIf(Boolean(python))("passes (exit 0) when CUDAExecutionProvider comes first", () => {
    expect(run(fake('["CUDAExecutionProvider", "CPUExecutionProvider"]'))).toBe(0);
  });
  it.runIf(Boolean(python))("exits 3 when ORT quietly fell back to the CPU", () => {
    expect(run(fake('["CPUExecutionProvider"]'))).toBe(3);
  });
  it.runIf(Boolean(python))("exits 3 when CUDA is listed behind the CPU", () => {
    expect(run(fake('["CPUExecutionProvider", "CUDAExecutionProvider"]'))).toBe(3);
  });
  it.runIf(Boolean(python))(
    "calls preload_dlls when the build has it, and still passes without it",
    () => {
      const marker = `
def preload_dlls():
    raise SystemExit(7)
`;
      expect(run(fake('["CUDAExecutionProvider"]', marker))).toBe(7);
    },
  );
  it.runIf(Boolean(python))("fails (not 0) when the session cannot be built", () => {
    const broken = `
class InferenceSession:
    def __init__(self, model, providers=None):
        raise RuntimeError("cublas64_13.dll missing")
`;
    expect(run(broken)).not.toBe(0);
  });

  // The Identity graph is a real ONNX model: real ONNX Runtime must accept it on the CPU where it is installed.
  const hasOrt =
    Boolean(python) &&
    spawnSync(python!, ["-c", "import onnxruntime"], { encoding: "utf8" }).status === 0;
  it.runIf(hasOrt)("the embedded Identity graph loads in a real ONNX Runtime session", () => {
    const code = String(engines.GPU_HEALTH_PROBE).replace(
      /providers=\[['"]CUDAExecutionProvider['"],\s*['"]CPUExecutionProvider['"]\]/,
      "providers=['CPUExecutionProvider']",
    );
    const out = spawnSync(
      python!,
      ["-c", code.replace("== 'CUDAExecutionProvider'", "== 'CPUExecutionProvider'")],
      {
        encoding: "utf8",
      },
    );
    expect(out.status).toBe(0);
  });
});

describe("stable-diffusion.cpp asset names follow the current release", () => {
  const asset = (name: string) => ({
    name,
    url: `https://example.invalid/${name}`,
    sha256: "a".repeat(64),
  });
  it("takes the single cpu-x64 zip of a current release (no avx2 or noavx zips any more)", () => {
    const list = [asset("sd-master-d68f288-bin-win-cpu-x64.zip")];
    for (const variant of ["avx512", "avx2", "plain", "cpu"]) {
      const plan = engines.sdPlan({ backend: "cpu", variant }, list);
      expect(plan.ok, variant).toBe(true);
      expect(plan.zips[0].name).toBe("sd-master-d68f288-bin-win-cpu-x64.zip");
    }
  });
  it("still prefers the avx build of an older release, and keeps the cuda12 pair", () => {
    const old = [
      asset("sd-master-abc1234-bin-win-avx2-x64.zip"),
      asset("sd-master-abc1234-bin-win-cpu-x64.zip"),
    ];
    expect(engines.sdPlan({ backend: "cpu", variant: "avx2" }, old).zips[0].name).toMatch(/avx2/);
    const cuda = engines.sdPlan({ backend: "cuda", variant: "cuda12" }, [
      asset("sd-master-d68f288-bin-win-cuda12-x64.zip"),
      asset("cudart-sd-bin-win-cu12-x64.zip"),
    ]);
    expect(cuda.ok).toBe(true);
    expect(cuda.zips.map((z: { name: string }) => z.name)).toEqual([
      "sd-master-d68f288-bin-win-cuda12-x64.zip",
      "cudart-sd-bin-win-cu12-x64.zip",
    ]);
  });
  it("refuses a chain entry that is not cuda, vulkan or cpu, and any arm64 entry", () => {
    const list = [
      asset("sd-master-d68f288-bin-win-cpu-x64.zip"),
      asset("sd-master-d68f288-bin-win-cuda12-x64.zip"),
      asset("sd-master-d68f288-bin-win-vulkan-x64.zip"),
    ];
    for (const entry of [
      { backend: "rocm", variant: "rocm" },
      { backend: "sycl", variant: "sycl" },
      { backend: "openvino", variant: "openvino" },
      { backend: "cpu", variant: "cpu", arch: "arm64" },
      { backend: "vulkan", variant: "vulkan", arch: "arm64" },
      { backend: "cuda", variant: "cuda-13.5", arch: "arm64" },
    ]) {
      const plan = engines.sdPlan(entry, list);
      expect(plan.ok, JSON.stringify(entry)).toBe(false);
      expect(plan.reason).toMatch(/stable-diffusion\.cpp/);
    }
    for (const entry of [
      { backend: "cpu", variant: "cpu", arch: "x64" },
      { backend: "vulkan", variant: "vulkan" },
      { backend: "cuda", variant: "cuda-13.5" },
    ]) {
      expect(engines.sdPlan(entry, list).ok, JSON.stringify(entry)).toBe(true);
    }
  });
  it("the llama.cpp live-source pattern already matches the current cpu-x64 name", () => {
    const pattern = new RegExp(engines.ENGINES["llama.cpp"].sources[0].assetPattern);
    expect(pattern.test("llama-b12619-bin-win-cpu-x64.zip")).toBe(true);
    expect(pattern.test("llama-b12619-bin-win-cuda-13.5-x64.zip")).toBe(false);
  });
});
