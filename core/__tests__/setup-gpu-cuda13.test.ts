/**
 * CUDA 13 in the Install Manager, the fit wording, the setup plan and the prefetch message (decisions D-8 and D-9).
 * The driver picks the GPU stack through gpuStackFor (electron/engine-install.cjs): CUDA 13 libraries with ONNX Runtime
 * 1.32.0 from driver 580, the CUDA 12.9 set with ONNX Runtime 1.26.0 for 576 to 579, DirectML below. Pure data and
 * logic on fake facts; no GPU, no network. The real DLLs and a real GPU session are unverified on Windows.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const engines = require_(path.join(root, "electron/engine-install.cjs"));
const fit = require_(path.join(root, "electron/engine-fit.cjs"));
const plan = require_(path.join(root, "electron/setup-plan.cjs"));
const catalogMod = require_(path.join(root, "electron/installer-catalog.cjs"));
const prefetch = require_(path.join(root, "scripts/prefetch-models.cjs"));

type Facts = Record<string, any>;
type Row = {
  id: string;
  pipBundle?: string;
  requirements?: Record<string, unknown>;
};
const tool = (id: string): Row => toolchain.TOOLS.find((t: Row) => t.id === id);
const code = (v: { reasons: Array<{ code: string }> }) => v.reasons.map((r) => r.code);
const text = (v: { reasons: Array<{ text: string }> }) => v.reasons.map((r) => r.text).join(" | ");

/** Pinned bytes of a bundle for the cp312 wheels: what the install writes. */
const bundleBytes = (id: string): number =>
  engines.PIP_BUNDLES[id].parts.reduce((sum: number, part: { dist: string; pin?: string }) => {
    const pin = engines.PINNED_WHEELS[part.pin ?? part.dist];
    const asset = pin.assets.find((a: { name: string }) => /cp312|py3-none/.test(a.name));
    return sum + asset.bytes;
  }, 0);

describe("Install Manager rows for the CUDA 13 stack", () => {
  it("cuda13-libs is a GPU Support row that needs a CUDA 13 driver and weighs its pinned wheels", () => {
    const row = tool("CUDA 13 runtime libraries");
    expect(row).toMatchObject({ pipBundle: "cuda13-libs", category: "GPU Support" });
    expect(row.requirements).toMatchObject({ gpu: "nvidia", cudaMin: "13", computeCapMin: 7.5 });
    expect(row.requirements?.["diskBytes"]).toBe(bundleBytes("cuda13-libs"));
  });

  it("cuda12-ort-libs and the CUDA 12 ONNX Runtime are rows that need a CUDA 12 driver", () => {
    const libs = tool("CUDA 12 runtime libraries for ONNX Runtime");
    expect(libs).toMatchObject({ pipBundle: "cuda12-ort-libs", category: "GPU Support" });
    expect(libs.requirements).toMatchObject({ gpu: "nvidia", cudaMin: "12" });
    expect(libs.requirements?.["diskBytes"]).toBe(bundleBytes("cuda12-ort-libs"));
    const ort = tool("ONNX Runtime (GPU, CUDA 12)");
    expect(ort).toMatchObject({ pipBundle: "ort-gpu-cu12", category: "GPU Support" });
    expect(ort.requirements).toMatchObject({ gpu: "nvidia", cudaMin: "12", cudaLibs: true });
    expect(ort.requirements?.["diskBytes"]).toBe(bundleBytes("ort-gpu-cu12"));
  });

  it("the CUDA 13 ONNX Runtime row follows its bundle: CUDA 13 driver, pinned wheel size, DirectML as the alternative", () => {
    const row = tool("ONNX Runtime (GPU)");
    expect(row.pipBundle).toBe("ort-gpu");
    expect(row.requirements).toMatchObject({
      gpu: "nvidia",
      cudaMin: "13",
      cudaLibs: true,
      alternative: "ONNX Runtime (DirectML)",
    });
    expect(row.requirements?.["diskBytes"]).toBe(bundleBytes("ort-gpu"));
  });

  it("every new row points at a bundle that exists and the speech libraries row keeps the CUDA 12 pair", () => {
    for (const id of [
      "CUDA 13 runtime libraries",
      "CUDA 12 runtime libraries for ONNX Runtime",
      "ONNX Runtime (GPU, CUDA 12)",
    ])
      expect(engines.PIP_BUNDLES[tool(id).pipBundle as string]).toBeTruthy();
    expect(tool("CUDA runtime libraries").pipBundle).toBe("cuda-libs");
    expect(tool("CUDA runtime libraries").requirements).toMatchObject({ cudaMin: "12" });
  });

  it("the Doctor lists the CUDA 13 libraries beside the speech pair and repairs only a PC that can use them", () => {
    const base = { name: "x", installed: false, installedVersion: null, engine: null };
    const rows = [
      { ...base, id: "CUDA runtime libraries", fit: { state: "supported", reasons: [] } },
      { ...base, id: "CUDA 13 runtime libraries", fit: { state: "supported", reasons: [] } },
    ];
    const doctor = catalogMod.doctorRows(rows);
    expect(doctor.find((d: { id: string }) => d.id === "cuda-libs")).toBeTruthy();
    const c13 = doctor.find((d: { id: string }) => d.id === "cuda13-libs");
    expect(c13).toMatchObject({
      status: "warn",
      repair: { id: "CUDA 13 runtime libraries", action: "install" },
    });
    const old = catalogMod.doctorRows([
      {
        ...rows[1],
        fit: { state: "unsupported", reasons: [{ text: "driver too old", level: "block" }] },
      },
    ]);
    expect(old.find((d: { id: string }) => d.id === "cuda13-libs")).toMatchObject({
      status: "skip",
      repair: null,
    });
  });
});

describe("engine fit wording follows the driver tier", () => {
  const nv = (driver: string, driverCuda: string, cuda: Facts = {}): Facts => ({
    gpus: [
      {
        vendor: "nvidia",
        name: "Test card",
        vramGb: 8,
        driver,
        integrated: false,
        computeCap: 8.6,
      },
    ],
    sources: ["nvidia-smi"],
    driverVersion: driver,
    cuda: { driverCuda, cublas12: false, cudnn9: false, runtimeFilesFound: false, ...cuda },
    ramGb: 16,
    diskFreeGb: 200,
  });
  const ORT13 = {
    id: "ONNX Runtime (GPU)",
    requirements: { gpu: "nvidia", cudaMin: "13", cudaLibs: true, diskBytes: 157_765_830 },
  };
  const ORT12 = {
    id: "ONNX Runtime (GPU, CUDA 12)",
    requirements: { gpu: "nvidia", cudaMin: "12", cudaLibs: true, diskBytes: 226_548_963 },
  };

  it("a CUDA 13 driver asks for the CUDA 13 libraries and never names cuBLAS 12", () => {
    const v = fit.classify(ORT13, nv("581.15", "13.0"));
    expect(v.state).toBe("limited");
    expect(code(v)).toContain("cuda-libs-unknown");
    expect(text(v)).toMatch(/cuBLAS 13 and cuDNN 9/);
    expect(text(v)).not.toMatch(/cuBLAS 12/);
  });

  it("the CUDA 12 files on a CUDA 13 PC do not count as the CUDA 13 libraries", () => {
    const v = fit.classify(
      ORT13,
      nv("581.15", "13.0", { cublas12: true, cudnn9: true, runtimeFilesFound: true }),
    );
    expect(v.state).toBe("limited");
    expect(text(v)).not.toMatch(/cuBLAS 12/);
  });

  it("the CUDA 13 libraries found on this PC make the row supported", () => {
    const v = fit.classify(ORT13, nv("581.15", "13.0", { cuda13LibsFound: true }));
    expect(v.state).toBe("supported");
  });

  it("a CUDA 12 driver keeps the cuBLAS 12 and cuDNN 9 wording", () => {
    const v = fit.classify(ORT12, nv("577.00", "12.9"));
    expect(code(v)).toContain("cuda-libs-missing");
    expect(text(v)).toMatch(/cuBLAS 12 and cuDNN 9/);
  });

  it("a row that needs CUDA 13 names the CUDA 13 driver floor and blocks an older driver", () => {
    const v = fit.classify(ORT13, nv("577.00", "12.9"));
    expect(v.state).toBe("unsupported");
    expect(code(v)).toContain("driver-too-old");
    expect(v.needs.driverMin).toBe("580");
    expect(text(v)).toContain("CUDA 13");
  });
});

describe("the setup plan picks the GPU stack by driver tier", () => {
  const PIN = {
    kind: "pinned",
    version: "12619",
    tag: "b12619",
    assets: [
      {
        name: "llama-b12619-bin-win-cpu-x64.zip",
        url: "https://example.invalid/llama-b12619-bin-win-cpu-x64.zip",
        bytes: 25027471,
        sha256: "a".repeat(64),
      },
    ],
  };
  const deps = (extra: Facts = {}) => ({
    llamaPin: PIN,
    root: path.join(root, "testing", "setup-gpu-cuda13-fake-root"),
    exists: () => false,
    statfs: () => ({ bavail: 500 * 1024 ** 2, bsize: 1024 }),
    ...extra,
  });
  const pc = (driver: string, driverCuda: string, extra: Facts = {}): Facts => ({
    vramGb: 8,
    vramFreeGb: 7,
    ramGb: 16,
    ramFreeGb: 12,
    diskFreeGb: 200,
    gpuVendor: "nvidia",
    gpuName: "Test NVIDIA card",
    gpus: [
      {
        vendor: "nvidia",
        name: "Test NVIDIA card",
        vramGb: 8,
        vramCapped: false,
        driver,
        integrated: false,
        computeCap: 8.6,
      },
    ],
    cudaReady: true,
    driverVersion: driver,
    cpuClass: "mid",
    cpu: { avx2: true, avx512: false, logicalCores: 8, physicalCores: 4 },
    vulkan: true,
    cuda: { driverCuda, cublas12: false, cudnn9: false, runtimeFilesFound: false },
    network: { online: true, metered: false },
    power: { batteryPresent: false, onAc: true },
    health: { level: "ok", reasons: [] },
    ...extra,
  });

  it("driver 580 or newer: the speech pair, the CUDA 13 libraries and the CUDA 13 ONNX Runtime", () => {
    const p = plan.buildSetupPlan(pc("581.15", "13.0"), deps());
    expect(p.packages.gpuStack).toMatchObject({ tier: "cuda13" });
    expect(p.packages.ortLibs).toMatchObject({
      id: "cuda13-libs",
      action: "install",
      bytes: bundleBytes("cuda13-libs"),
    });
    expect(p.packages.ort).toMatchObject({ variant: "gpu", installNow: "gpu" });
    expect(p.packages.ort.bytes).toBe(bundleBytes("ort-gpu"));
    expect(p.packages.cudaLibs.action).toBe("install");
    expect(p.packages.ortLibs.reason).toMatch(/CUDA 13/);
    // the planned download counts the new libraries too
    const without = plan.buildSetupPlan(
      pc("581.15", "13.0", { network: { online: true } }),
      deps(),
    );
    expect(without.downloadBytes).toBeGreaterThanOrEqual(bundleBytes("cuda13-libs"));
  });

  it("driver 576 to 579: the CUDA 12 extras and the pinned CUDA 12 ONNX Runtime", () => {
    const p = plan.buildSetupPlan(pc("577.00", "12.9"), deps());
    expect(p.packages.gpuStack).toMatchObject({ tier: "cuda12" });
    expect(p.packages.ortLibs).toMatchObject({
      id: "cuda12-ort-libs",
      action: "install",
      bytes: bundleBytes("cuda12-ort-libs"),
    });
    expect(p.packages.ort).toMatchObject({ variant: "gpu", installNow: "gpu" });
    expect(p.packages.ort.bytes).toBe(bundleBytes("ort-gpu-cu12"));
  });

  it("a driver below 576: DirectML is offered, no CUDA ONNX Runtime and no extra libraries", () => {
    const p = plan.buildSetupPlan(pc("560.94", "12.6"), deps());
    expect(p.packages.gpuStack).toMatchObject({ tier: "directml" });
    expect(p.packages.ortLibs.action).toBe("skip");
    expect(p.packages.ort).toMatchObject({ variant: "directml", installNow: "cpu" });
    // the speech libraries (CUDA 12) are unchanged
    expect(p.packages.cudaLibs.action).toBe("install");
  });

  it("an unknown driver version falls back to DirectML, never to a CUDA stack", () => {
    const f = pc("", "12.6", { driverVersion: null });
    f["gpus"][0].driver = null;
    expect(plan.buildSetupPlan(f, deps()).packages.gpuStack.tier).toBe("directml");
  });

  it("a PC without an NVIDIA card has no GPU stack", () => {
    const p = plan.buildSetupPlan(
      pc("581.15", "13.0", { gpus: [], gpuVendor: null, cudaReady: false }),
      deps(),
    );
    expect(p.packages.gpuStack.tier).toBe("none");
    expect(p.packages.ortLibs.action).toBe("skip");
  });

  it("the required set the Doctor reads names the CUDA 13 libraries by their row id", () => {
    const json = plan.toJSON(plan.buildSetupPlan(pc("581.15", "13.0"), deps()));
    const ids = (json.required || []).map((r: { id: string }) => r.id);
    expect(ids).toContain("cuda13-libs");
    expect(ids).toContain("cuda-libs");
  });

  it("a deferred install (metered line) waits for the CUDA 13 libraries too", () => {
    const p = plan.buildSetupPlan(
      pc("581.15", "13.0", { network: { online: true, metered: true } }),
      deps(),
    );
    expect(p.packages.ortLibs.action).toBe("defer");
    expect(p.packages.ort.installNow).toBe("cpu");
    expect(p.deferredBytes).toBeGreaterThanOrEqual(bundleBytes("cuda13-libs"));
  });
});

describe("the prefetch message only names a llama.cpp build that exists", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "config/friday-core.json"), "utf8"));
  const ids = manifest.runtime.assets.map((a: { id: string }) => a.id);

  it("the manifest carries the CUDA 13.5, ROCm and ARM64 ids this plan names", () => {
    for (const id of ["cuda-13.5-x64", "cudart-13.5-x64", "cpu-arm64", "rocm-10.0-x64"])
      expect(ids).toContain(id);
  });

  it("names a build whose asset is pinned and says so plainly when it is not", () => {
    const line = (install: Facts) => prefetch.llamaBuildNote(install, manifest);
    expect(line({ backend: "cuda", assetId: "cuda-13.5-x64" })).toContain("cuda-13.5-x64");
    expect(line({ backend: "cuda", assetId: "cuda-12.4-x64" })).toContain("cuda-12.4-x64");
    expect(line({ backend: "rocm", assetId: "rocm-10.0-x64" })).toContain("rocm-10.0-x64");
    expect(line({ backend: "vulkan", assetId: "vulkan-x64" })).toContain("vulkan-x64");
    const unknown = line({ backend: "cuda", assetId: "cuda-99.9-x64" });
    expect(unknown).not.toContain("cuda-99.9-x64");
    expect(unknown).toMatch(/no pinned release asset/);
    expect(line({ backend: "cuda" })).not.toMatch(/undefined/);
  });

  it("every asset id the plan can emit is in the manifest", () => {
    const named = plan.nameLlamaChain(
      [{ backend: "cuda" }, { backend: "rocm" }, { backend: "vulkan" }, { backend: "cpu" }],
      {
        driverVersion: "581.15",
        cuda: { driverCuda: "13.0" },
      },
      { nvidia: { driver: "581.15" } },
    );
    for (const step of named) expect(ids).toContain(step.assetId);
    for (const step of named) if (step.runtimeAssetId) expect(ids).toContain(step.runtimeAssetId);
  });
});
