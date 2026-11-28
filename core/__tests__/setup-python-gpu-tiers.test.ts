/**
 * Setup installs the GPU stack the NVIDIA driver can run, with the same tables the Install Manager uses
 * (electron/engine-install.cjs): CUDA 13 libraries and ONNX Runtime 1.32.0 from driver 580, the CUDA 12.9 set and ONNX
 * Runtime 1.26.0 from 576, DirectML below that. The health check is a real session (GPU_HEALTH_PROBE), not a provider
 * list. The unhashed PyPI index fallback is opt-in. Script text runs with stand-ins for pip and nvidia-smi: Linux
 * evidence only, no Windows PC, no GPU, no mirror was reached.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const setup = readFileSync(path.join(root, "scripts/setup-python.cjs"), "utf8");
const engine = require_(path.join(root, "electron/engine-install.cjs"));
const loader = require_(path.join(root, "scripts/electron-module.cjs"));

/** The text of one top-level function, from its signature to its closing brace at column 0. */
const fn = (signature: string) => {
  const start = setup.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  return setup.slice(start, setup.indexOf("\n}\n", start) + 3);
};

describe("setup-python takes the GPU tables from engine-install", () => {
  it("imports the stack picker, the health probe and both driver floors from electron/engine-install.cjs", () => {
    const at = setup.indexOf('load("engine-install.cjs")');
    expect(at).toBeGreaterThan(-1);
    const head = setup.slice(Math.max(0, at - 400), at);
    for (const name of [
      "gpuStackFor",
      "GPU_HEALTH_PROBE",
      "CUDA13_DRIVER_FLOOR",
      "CUDA12_DRIVER_FLOOR",
    ])
      expect(head, name).toContain(name);
  });

  it("the GPU ONNX Runtime step picks its tier from the driver and checks health with the real session probe", () => {
    const body = fn("function installGpuOnnxRuntime()");
    expect(body).toContain("const driver = nvidiaDriverVersion();");
    expect(body).toContain("gpuStackFor(driver)");
    expect(body).toContain("installTierLibraries(stack)");
    expect(body).toContain("GPU_HEALTH_PROBE");
    expect(body).not.toContain("get_available_providers");
    expect(body).toContain("pinnedGpuOrtLines(");
    // get_available_providers() lists CUDA when its DLLs are missing: it is gone from the whole script.
    expect(setup).not.toContain("get_available_providers");
  });
});

describe("nvidiaDriverVersion", () => {
  const run = (capture: (exe: string, args: string[]) => unknown) =>
    new Function(
      "capture",
      `${fn("function nvidiaDriverVersion()")}; return nvidiaDriverVersion();`,
    )(capture);
  it("reads the first line of the driver_version query", () => {
    let seen: string[] = [];
    const got = run((exe, args) => {
      expect(exe).toBe("nvidia-smi");
      seen = args;
      return { status: 0, stdout: "581.15\r\n576.80\r\n" };
    });
    expect(got).toBe("581.15");
    expect(seen).toEqual(["--query-gpu=driver_version", "--format=csv,noheader"]);
  });
  it("says nothing when nvidia-smi fails or prints nothing", () => {
    expect(run(() => ({ status: 1, stdout: "581.15" }))).toBe("");
    expect(run(() => ({ status: 0, stdout: "\n" }))).toBe("");
    expect(run(() => ({ status: 0 }))).toBe("");
  });
});

describe("pinnedGpuOrtLines follows the tier", () => {
  const code = `${fn("function pinnedGpuOrtLines(")}; return pinnedGpuOrtLines;`;
  const lines = new Function("require", code)((id: string) =>
    id === "./electron-module.cjs" ? loader : require_(id),
  ) as (tag: string, tier?: string) => { line: string; wheel: { name: string } } | null;
  const pin = engine.PINNED_WHEELS as Record<string, { version: string }>;

  it("CUDA 13 reads onnxruntime-gpu, CUDA 12 reads onnxruntime-gpu-cu12, DirectML its own pin", () => {
    expect(lines("cp312", "cuda13")?.line).toMatch(
      new RegExp(
        `^onnxruntime-gpu==${pin["onnxruntime-gpu"]!.version.replace(/\./g, "\\.")} --hash=sha256:[a-f0-9]{64}$`,
      ),
    );
    expect(lines("cp312", "cuda12")?.line).toMatch(
      /^onnxruntime-gpu==1\.26\.0 --hash=sha256:[a-f0-9]{64}$/,
    );
    expect(lines("cp312", "directml")?.line).toMatch(
      /^onnxruntime-directml==[\d.]+ --hash=sha256:[a-f0-9]{64}$/,
    );
    expect(lines("cp312")?.line).toBe(lines("cp312", "cuda13")?.line);
  });
  it("is null for a Python the pin does not cover", () => {
    expect(lines("cp27", "cuda13")).toBeNull();
    expect(lines("cp27", "cuda12")).toBeNull();
  });
});

describe("installTierLibraries installs the library bundles of the tier, in order, by pin", () => {
  type Ctx = { installs: string[][]; files: Record<string, string>; cudaProbe: number };
  function make(driver: string, opts: { cudaLibsPresent?: boolean; failOn?: string } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-tier-"));
    const ctx: Ctx = { installs: [], files: {}, cudaProbe: opts.cudaLibsPresent ? 0 : 1 };
    const stack = engine.gpuStackFor(driver);
    const pinned = new Function(
      "win",
      "process",
      "require",
      `${fn("function pinnedBundleLines(")}; return pinnedBundleLines;`,
    )(true, { arch: "x64" }, (id: string) =>
      id === "./electron-module.cjs" ? loader : require_(id),
    );
    const installWithMethods = (args: string[]) => {
      const file = args[args.indexOf("-r") + 1]!;
      ctx.files[path.basename(file)] = readFileSync(file, "utf8");
      ctx.installs.push(args);
      return !(opts.failOn && file.includes(opts.failOn));
    };
    const call = new Function(
      "pinnedBundleLines",
      "capture",
      "python",
      "CUDA_LIBS_PROBE",
      "installWithMethods",
      "log",
      "root",
      "path",
      "fs",
      "PIP_BUNDLES",
      `${fn("function installTierLibraries(")}; return installTierLibraries;`,
    )(
      pinned,
      () => ({ status: ctx.cudaProbe }),
      "python",
      ["-c", "probe"],
      installWithMethods,
      () => {},
      dir,
      path,
      require_("node:fs"),
      engine.PIP_BUNDLES,
    ) as (s: unknown) => { ok: boolean; reason?: string };
    return { out: () => call(stack), ctx, stack, dir };
  }

  it("CUDA 13 (driver 580+): one hashed install of the seven CUDA 13 wheels, no ONNX Runtime wheel", () => {
    const t = make("581.15");
    const out = t.out();
    expect(out.ok).toBe(true);
    expect(t.ctx.installs).toHaveLength(1);
    expect(t.ctx.installs[0]).toEqual(
      expect.arrayContaining(["--require-hashes", "--no-deps", "-r"]),
    );
    const text = Object.values(t.ctx.files)[0]!;
    const names = text
      .trim()
      .split("\n")
      .map((l) => l.split("==")[0]);
    expect(names).toEqual(
      engine.PIP_BUNDLES["cuda13-libs"].parts.map((p: { dist: string }) => p.dist),
    );
    for (const line of text.trim().split("\n"))
      expect(line).toMatch(/ --hash=sha256:[a-f0-9]{64}$/);
    rmSync(t.dir, { recursive: true, force: true });
  });

  it("CUDA 12 (576-579): cuda-libs then the CUDA 12 extras; cuda-libs is skipped when its DLLs are already there", () => {
    const fresh = make("577.0");
    expect(fresh.stack.tier).toBe("cuda12");
    expect(fresh.out().ok).toBe(true);
    const order = fresh.ctx.installs.map((a) => path.basename(a[a.indexOf("-r") + 1]!));
    expect(order).toHaveLength(2);
    expect(order[0]).toContain("cuda-libs");
    expect(order[1]).toContain("cuda12-ort-libs");
    expect(Object.values(fresh.ctx.files)[1]).toContain("nvidia-cufft-cu12==");

    const present = make("577.0", { cudaLibsPresent: true });
    expect(present.out().ok).toBe(true);
    expect(present.ctx.installs).toHaveLength(1);
    expect(Object.keys(present.ctx.files)[0]).toContain("cuda12-ort-libs");
    rmSync(fresh.dir, { recursive: true, force: true });
    rmSync(present.dir, { recursive: true, force: true });
  });

  it("DirectML (older or unknown driver): nothing to install here", () => {
    for (const driver of ["550.0", ""]) {
      const t = make(driver);
      expect(t.out()).toEqual({ ok: true });
      expect(t.ctx.installs).toEqual([]);
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("a bundle that does not install stops the tier with a reason and later bundles are not tried", () => {
    const t = make("577.0", { failOn: "cuda-libs" });
    const out = t.out();
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/CUDA/);
    expect(t.ctx.installs).toHaveLength(1);
    rmSync(t.dir, { recursive: true, force: true });
  });
});

describe("installGpuOnnxRuntime runs the tier's ONNX Runtime and its real health session", () => {
  function swap(driver: string, opts: { libsFail?: boolean } = {}) {
    const text = (() => {
      const start = setup.indexOf("function installGpuOnnxRuntime()");
      return setup.slice(start, setup.indexOf("\ninstallGpuOnnxRuntime();", start));
    })();
    const pips: string[] = [];
    const probes: string[] = [];
    const notices: string[] = [];
    const tiers: string[] = [];
    const run = (_exe: string, args: string[]) => {
      pips.push(args.slice(args.indexOf("pip") + 1).join(" "));
      return { status: 0 };
    };
    const capture = (_exe: string, args: string[]) => {
      if (args[0] === "-c" && /import sys; print/.test(args[1]!))
        return { status: 0, stdout: "cp312" };
      probes.push(String(args[1]));
      return { status: 0 };
    };
    const pinnedGpuOrtLines = (_tag: string, tier: string) => {
      tiers.push(tier);
      return {
        line: "onnxruntime-gpu==1.0 --hash=sha256:x",
        wheel: { name: "w.whl", bytes: 1024 ** 2 },
      };
    };
    const libs: string[] = [];
    new Function(
      "win",
      "thisPcPlan",
      "installedOnnxRuntimes",
      "log",
      "notice",
      "noticeCleared",
      "capture",
      "run",
      "python",
      "CUDA_LIBS_PROBE",
      "pinnedGpuOrtLines",
      "installedPlainOrtVersion",
      "root",
      "path",
      "fs",
      "nvidiaDriverVersion",
      "gpuStackFor",
      "GPU_HEALTH_PROBE",
      "CUDA13_DRIVER_FLOOR",
      "CUDA12_DRIVER_FLOOR",
      "installTierLibraries",
      `${text}\nreturn installGpuOnnxRuntime();`,
    )(
      true,
      () => ({ required: [{ id: "onnxruntime", variant: "gpu", action: "install" }] }),
      () => ({ gpu: [], plain: true }),
      () => {},
      (entry: { id: string }) => notices.push(entry.id),
      () => {},
      capture,
      run,
      "python",
      ["-c", "cuda12probe"],
      pinnedGpuOrtLines,
      () => "1.22.0",
      path.join(tmpdir(), "friday-ort-tier"),
      path,
      { rmSync() {}, mkdirSync() {}, writeFileSync() {} },
      () => driver,
      engine.gpuStackFor,
      engine.GPU_HEALTH_PROBE,
      engine.CUDA13_DRIVER_FLOOR,
      engine.CUDA12_DRIVER_FLOOR,
      (stack: { tier: string }) => {
        libs.push(stack.tier);
        return opts.libsFail
          ? { ok: false, reason: "the CUDA libraries did not install" }
          : { ok: true };
      },
    );
    return { pips, probes, notices, tiers, libs };
  }

  it("driver 581: CUDA 13 stack, libraries first, health is GPU_HEALTH_PROBE", () => {
    const out = swap("581.15");
    expect(out.libs).toEqual(["cuda13"]);
    expect(out.tiers).toEqual(["cuda13"]);
    expect(out.probes).toContain(engine.GPU_HEALTH_PROBE);
    expect(out.notices).toEqual([]);
  });
  it("driver 577: the CUDA 12 ONNX Runtime pin is read", () => {
    const out = swap("577.1");
    expect(out.libs).toEqual(["cuda12"]);
    expect(out.tiers).toEqual(["cuda12"]);
    expect(out.probes).toContain(engine.GPU_HEALTH_PROBE);
  });
  it("driver below 576: DirectML, an import check instead of a CUDA session", () => {
    const out = swap("550.2");
    expect(out.tiers).toEqual(["directml"]);
    expect(out.probes).not.toContain(engine.GPU_HEALTH_PROBE);
    expect(out.probes).toContain("import onnxruntime");
  });
  it("a library bundle that fails records one notice and swaps nothing", () => {
    const out = swap("581.15", { libsFail: true });
    expect(out.notices).toEqual(["package:onnxruntime-gpu"]);
    expect(out.pips.filter((p) => /^(uninstall|install)\b/.test(p))).toEqual([]);
    expect(out.tiers).toEqual([]);
  });
});

describe("the unhashed PyPI index fallback is opt-in", () => {
  const indexes = new Function(
    "pypiMirrors",
    `${fn("function pypiMirrorIndexes(")}; return pypiMirrorIndexes;`,
  )(engine.pypiMirrors) as (env: Record<string, string | undefined>) => string[];

  it("is empty by default", () => {
    expect(indexes({})).toEqual([]);
    expect(indexes({ FRIDAY_PYPI_MIRROR: "0" })).toEqual([]);
    expect(indexes({ FRIDAY_PYPI_MIRROR: "true" })).toEqual([]);
  });
  it("FRIDAY_PYPI_MIRROR=1 lists the mirrors of config/download-hosts.json in order", () => {
    const got = indexes({ FRIDAY_PYPI_MIRROR: "1" });
    expect(got).toEqual(engine.pypiMirrors().map((m: { simple: string }) => m.simple));
    expect(got).toHaveLength(5);
    expect(got[0]).toContain("tuna.tsinghua");
  });
  it("an existing https PIP_INDEX_URL is the only index; a plain http or empty one is ignored", () => {
    expect(indexes({ PIP_INDEX_URL: "https://pypi.example.org/simple" })).toEqual([
      "https://pypi.example.org/simple",
    ]);
    expect(indexes({ PIP_INDEX_URL: "http://pypi.example.org/simple" })).toEqual([]);
    expect(indexes({ PIP_INDEX_URL: "" })).toEqual([]);
  });

  it("pipMethods adds those indexes as --index-url methods after the official ones, and never --extra-index-url", () => {
    expect(setup).not.toContain("--extra-index-url");
    const block = setup.slice(
      setup.indexOf("const base = ["),
      setup.indexOf("// A newest-release install"),
    );
    const build = new Function("pypiMirrorIndexes", `${block}; return { base, pipMethods };`) as (
      f: () => string[],
    ) => { base: string[]; pipMethods: (e: string[]) => Array<{ label: string; args: string[] }> };
    const off = build(() => []).pipMethods(["pkg"]);
    expect(off.some((m) => /mirror/i.test(m.label))).toBe(false);
    const on = build(() => ["https://m1/simple", "https://m2/simple"]).pipMethods(["pkg"]);
    const mirrors = on.filter((m) => /mirror/i.test(m.label));
    expect(mirrors).toHaveLength(2);
    expect(on.indexOf(mirrors[0]!)).toBeGreaterThan(
      on.findIndex((m) => m.args.includes("https://pypi.org/simple")),
    );
    expect(mirrors[0]!.args).toEqual(
      expect.arrayContaining(["--index-url", "https://m1/simple", "pkg"]),
    );
    expect(mirrors[0]!.label).toMatch(/no hash check|unhashed/i);
  });

  it("FRIDAY_PYPI_MIRROR is documented in the code, nowhere else is a new key added", () => {
    expect(setup).toContain("FRIDAY_PYPI_MIRROR");
  });
});
