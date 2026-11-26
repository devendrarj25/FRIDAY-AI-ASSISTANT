/**
 * Setup keeps what the Install Manager put on the PC and installs what it names with checks: the CUDA 12 speech
 * libraries go in by SHA-256 pin, an installed GPU or DirectML ONNX Runtime is not overwritten by the CPU wheel, and
 * the semantic-memory model lands in <FRIDAY_ROOT>/cache/chroma, where the installed app's kernel reads it. Pure
 * helpers run for real; the Windows-only script text is pinned by shape. Nothing here ran on a Windows PC.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const runtime = require_(path.join(root, "scripts/python-runtime.cjs"));
const engine = require_(path.join(root, "electron/engine-install.cjs"));
const setup = read("scripts/setup-python.cjs");

/** The body of one top-level function of a script, from its signature to its closing brace at column 0. */
const fn = (source: string, signature: string) => {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}\n", start) + 3);
};

describe("an installed GPU ONNX Runtime is kept", () => {
  const caps = [
    "numpy>=2.5.4",
    "chromadb>=1.5.9",
    "onnxruntime>=1.31.1",
    "# onnxruntime-directml is an optional tool",
    "onnx-asr>=0.12.0",
    "",
  ];

  it("reads the GPU and DirectML builds from pip list, whatever the spelling of the name", () => {
    const seen = runtime.onnxRuntimesIn([
      { name: "onnxruntime_gpu", version: "1.32.0" },
      { name: "Onnxruntime.DirectML", version: "1.24.4" },
      { name: "numpy", version: "2.5.4" },
    ]);
    expect(seen.gpu).toEqual([
      { name: "onnxruntime-gpu", version: "1.32.0" },
      { name: "onnxruntime-directml", version: "1.24.4" },
    ]);
    expect(seen.plain).toBe(false);
    expect(runtime.onnxRuntimesIn([{ name: "onnxruntime", version: "1.31.1" }])).toEqual({
      gpu: [],
      plain: true,
    });
    for (const bad of [null, undefined, {}, "x", [null], [{}]]) {
      expect(runtime.onnxRuntimesIn(bad)).toEqual({ gpu: [], plain: false });
    }
  });

  it("drops only the plain onnxruntime line when a GPU build is installed", () => {
    const gpu = runtime.onnxRuntimesIn([{ name: "onnxruntime-gpu", version: "1.32.0" }]);
    const kept = runtime.keepGpuOnnxRuntime(caps, gpu);
    expect(kept.dropped).toEqual(["onnxruntime>=1.31.1"]);
    expect(kept.lines).toEqual(caps.filter((line) => line !== "onnxruntime>=1.31.1"));
    expect(kept.lines).toContain("onnx-asr>=0.12.0");
    // Name-alike lines and extras are not the plain wheel.
    expect(
      runtime.keepGpuOnnxRuntime(["onnxruntime-gpu>=1", "onnxruntime-extensions>=0.1"], gpu)
        .dropped,
    ).toEqual([]);
    expect(
      runtime.keepGpuOnnxRuntime(["ONNXRuntime[extra]==1.0 ; sys_platform == 'win32'"], gpu)
        .dropped,
    ).toHaveLength(1);
  });

  it("keeps the plain line on a PC without a GPU build, and on an unreadable list", () => {
    for (const none of [
      runtime.onnxRuntimesIn([]),
      runtime.onnxRuntimesIn([{ name: "onnxruntime", version: "1.31.1" }]),
      runtime.onnxRuntimesIn("garbage"),
    ]) {
      expect(runtime.keepGpuOnnxRuntime(caps, none)).toEqual({ lines: caps, dropped: [] });
    }
  });

  it("is wired in setup-python: detected before the first install, filtered, restored after", () => {
    const before = setup.indexOf("const onnxBefore = installedOnnxRuntimes();");
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(setup.indexOf("let installed = installWithMethods"));
    expect(setup).toContain('"--format=json"');
    expect(setup).toContain("runtime.keepGpuOnnxRuntime(");
    expect(setup).toContain('installWithMethods(["-r", capFile]');
    // The one-by-one fallback skips the plain wheel too.
    expect(setup).toContain("for (const pin of capInstall)");
    const restore = fn(setup, "function restoreGpuOnnxRuntime()");
    expect(restore).toContain("if (!onnxBefore.gpu.length) return;");
    expect(restore).toContain('"uninstall"');
    expect(restore).toContain('"--force-reinstall", "--no-deps"');
    // It runs after the capability list and before the chroma probe.
    const call = setup.indexOf("\nrestoreGpuOnnxRuntime();");
    expect(call).toBeGreaterThan(setup.indexOf("capInstall"));
    expect(call).toBeLessThan(setup.indexOf("fetchChromaEmbeddingModel();\n}"));
  });
});

describe("the CUDA 12 speech libraries are installed by pin", () => {
  it("the pinned bundle gives exact versions and SHA-256 for both wheels", () => {
    const bundle = engine.PIP_BUNDLES["cuda-libs"];
    const resolved = Object.fromEntries(
      bundle.parts.map((part: { dist: string }) => {
        const pin = engine.PINNED_WHEELS[part.dist];
        return [part.dist, { ok: true, version: pin.version, assets: pin.assets }];
      }),
    );
    const plan = engine.planWheels(bundle, resolved);
    expect(plan.ok).toBe(true);
    expect(plan.lines).toHaveLength(2);
    for (const line of plan.lines)
      expect(line).toMatch(/^nvidia-[a-z0-9-]+==[\d.]+ --hash=sha256:[a-f0-9]{64}$/);
  });

  it("setup-python builds that list, installs it with --require-hashes, and never retries a pin unpinned", () => {
    const lines = fn(setup, "function pinnedCudaLibsLines()");
    // Run the real function with the real engine-install module (win32 x64 injected).
    const run = new Function(
      "win",
      "process",
      "require",
      `${lines}; return pinnedCudaLibsLines();`,
    );
    const requireFor = (id: string) =>
      id === "./electron-module.cjs"
        ? require_(path.join(root, "scripts/electron-module.cjs"))
        : require_(id);
    const got = run(true, { arch: "x64" }, requireFor);
    expect(got).toHaveLength(2);
    expect(got[0]).toContain("nvidia-cublas-cu12==");
    expect(got[1]).toContain("nvidia-cudnn-cu12==");
    expect(got.every((line: string) => /--hash=sha256:[a-f0-9]{64}$/.test(line))).toBe(true);
    // No pin for this PC (not Windows x64): null, and the caller says so.
    expect(run(false, { arch: "x64" }, requireFor)).toBeNull();
    expect(run(true, { arch: "arm64" }, requireFor)).toBeNull();

    const install = fn(setup, "function installGpuSpeechLibraries()");
    expect(install).toContain("const pinned = pinnedCudaLibsLines();");
    expect(install).toContain('"--require-hashes", "--no-deps", "-r", file');
    expect(install).toContain("with SHA-256 checks");
    expect(install).toContain("NOTE no pinned CUDA 12 wheel fits this PC");
    // The unpinned names appear only in the NOTE branch.
    const plain = install.indexOf('"nvidia-cublas-cu12", "nvidia-cudnn-cu12>=9,<10"');
    expect(plain).toBeGreaterThan(install.indexOf("NOTE no pinned CUDA 12 wheel fits this PC"));
    expect(install).not.toMatch(/if \(!ok\)[^]*installWithMethods\(\["nvidia-cublas/);
  });
});

describe("the semantic-memory model lives in the FRIDAY folder", () => {
  it("setup fetches it into <FRIDAY_ROOT>/cache/chroma and points Chroma at it", () => {
    const chroma = fn(setup, "function fetchChromaEmbeddingModel()");
    expect(chroma).toContain('path.join(fridayRoot, "cache", "chroma")');
    expect(chroma).toContain("process.env.CHROMA_CACHE_DIR ||");
    expect(chroma).toContain("env: { ...process.env, CHROMA_CACHE_DIR: cache }");
    // Chroma 1.x reads a class attribute, not the variable.
    expect(chroma).toContain("m.DOWNLOAD_PATH = pathlib.Path(cache)");
    expect(chroma).toContain("onnx_models");
    // The already-on-disk check looks where the model is fetched.
    expect(chroma).toContain(
      'path.join(cache, "onnx_models", "all-MiniLM-L6-v2", "onnx", "model.onnx")',
    );
  });

  it("the kernel launch hands the kernel FRIDAY_ROOT and the same cache folder", () => {
    const main = read("electron/main.cjs");
    const spawnAt = main.indexOf("kernel = spawn(python, [...pythonPrefix, entry], {");
    expect(spawnAt).toBeGreaterThan(-1);
    const block = main.slice(spawnAt, main.indexOf("stdio:", spawnAt));
    // The spawn spreads one helper; the helper owns both variables.
    expect(block).toMatch(/\.\.\.kernelRootEnv\(\)/);
    const helperAt = main.indexOf("function kernelRootEnv()");
    expect(helperAt).toBeGreaterThan(-1);
    const helper = main.slice(helperAt, main.indexOf("\n}\n", helperAt));
    expect(helper).toMatch(/FRIDAY_ROOT: root/);
    expect(helper).toMatch(
      /CHROMA_CACHE_DIR: process\.env\.CHROMA_CACHE_DIR \|\| path\.join\(root, "cache", "chroma"\)/,
    );
    // Both land only when a FRIDAY folder is known: no folder, no half-set variables.
    expect(helper).toMatch(/const root = paths\.root\(\);\s*if \(!root\) return \{\};/);
    // The same folder shape setup uses.
    expect(setup).toContain('path.join(fridayRoot, "cache", "chroma")');
  });

  it("the kernel applies the variable to Chroma before it opens the store", () => {
    const memory = read("kernel/memory.py");
    expect(memory).toContain("def _point_chroma_model_cache() -> None:");
    expect(memory).toContain("ONNXMiniLM_L6_V2.DOWNLOAD_PATH = Path(cache)");
    const open = memory.indexOf("async def open(self)");
    const called = memory.indexOf("_point_chroma_model_cache()\n        try:", open);
    expect(called).toBeGreaterThan(open);
    expect(called).toBeLessThan(memory.indexOf("chromadb.PersistentClient(", open));
  });
});
