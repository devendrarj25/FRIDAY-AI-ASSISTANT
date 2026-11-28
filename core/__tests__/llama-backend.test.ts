/**
 * llama.cpp and the other release-zip engines: the build is chosen from the measured facts (CUDA 12, Vulkan, CPU by
 * flags), downloaded against the official digest, started once as a health check and swapped in next to the old copy;
 * a build that does not start falls back one step with the reason recorded. Pinned wheels (the CUDA pair, the ONNX
 * Runtime variants) install with a rollback. Fake releases, a fake pip and a throwaway folder: no network, no GPU.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const llama = require_(path.join(root, "electron/llama-runtime.cjs"));
const engines = require_(path.join(root, "electron/engine-install.cjs"));
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const SERVER = process.platform === "win32" ? "llama-server.exe" : "llama-server";

type Facts = Record<string, unknown>;
function pc(over: Facts = {}): Facts {
  return {
    ramGb: 16,
    gpus: [],
    gpuVendor: null,
    vramFreeGb: null,
    cudaReady: false,
    vulkan: false,
    cpu: { avx2: true, avx512: false },
    cuda: { driverCuda: null },
    ...over,
  };
}
function nvidia(vram: number, o: { driverCuda?: string; free?: number; cap?: number } = {}): Facts {
  return pc({
    gpus: [
      {
        vendor: "nvidia",
        name: "card",
        vramGb: vram,
        vramCapped: false,
        integrated: false,
        ...(o.cap ? { computeCap: o.cap } : {}),
      },
    ],
    gpuVendor: "nvidia",
    vramFreeGb: o.free ?? vram - 0.5,
    cudaReady: true,
    vulkan: true,
    cuda: { driverCuda: o.driverCuda ?? "12.9" },
  });
}
const chainOf = (facts: Facts, opts = {}) =>
  llama.backendChain(facts, opts).chain.map((e: { backend: string }) => e.backend);

describe("backendChain: the build is chosen by facts, never by a card's name", () => {
  it("NVIDIA with a CUDA 12 driver and room: cuda, vulkan, cpu in that order", () => {
    expect(chainOf(nvidia(8))).toEqual(["cuda", "vulkan", "cpu"]);
    expect(chainOf(nvidia(24, { driverCuda: "12.4" }))).toEqual(["cuda", "vulkan", "cpu"]);
  });
  it("skips CUDA, with a reason, below 4 GB free, below compute 7.5 or on a CUDA 11 driver", () => {
    const small = llama.backendChain(nvidia(8, { free: 3 }));
    expect(small.chain.map((e: { backend: string }) => e.backend)).toEqual(["vulkan", "cpu"]);
    expect(small.skipped[0]).toMatchObject({ backend: "cuda" });
    expect(small.skipped[0].reason).toMatch(/3 GB.*free/);
    expect(chainOf(nvidia(8, { cap: 6.1 }))).toEqual(["vulkan", "cpu"]);
    expect(llama.backendChain(nvidia(8, { cap: 6.1 })).skipped[0].reason).toMatch(/6\.1/);
    expect(chainOf(nvidia(8, { driverCuda: "11.8" }))).toEqual(["vulkan", "cpu"]);
    expect(chainOf(nvidia(8), { computeCap: 7.5 })).toContain("cuda"); // 7.5 is the floor
    expect(chainOf(nvidia(8), { computeCap: 7.0 })).not.toContain("cuda");
  });
  it("an unknown compute capability does not rule CUDA out; the health check decides", () => {
    expect(chainOf(nvidia(8))).toContain("cuda");
  });
  it("a card whose size only reads as the 32-bit cap (4 GB or more) still counts; an unmeasured one does not", () => {
    const capped = nvidia(8);
    (capped["gpus"] as Record<string, unknown>[])[0] = {
      vendor: "nvidia",
      vramGb: null,
      vramCapped: true,
    };
    capped["vramFreeGb"] = null;
    expect(chainOf(capped)).toContain("cuda");
    const unknown = nvidia(8);
    (unknown["gpus"] as Record<string, unknown>[])[0] = {
      vendor: "nvidia",
      vramGb: null,
      vramCapped: false,
    };
    unknown["vramFreeGb"] = null;
    expect(chainOf(unknown)).not.toContain("cuda");
  });
  it("a discrete AMD card tries rocm first; Intel or an iGPU with Vulkan: vulkan then cpu", () => {
    const amd = pc({ gpus: [{ vendor: "amd", vramGb: 8 }], vulkan: true });
    expect(chainOf(amd)).toEqual(["rocm", "vulkan", "cpu"]);
    const intel = pc({ gpus: [{ vendor: "intel", vramGb: null, integrated: true }], vulkan: true });
    expect(chainOf(intel)).toEqual(["vulkan", "cpu"]);
  });
  it("no GPU, no Vulkan driver or only a software device: cpu only", () => {
    expect(chainOf(pc())).toEqual(["cpu"]);
    expect(chainOf(pc({ vulkan: true }))).toEqual(["cpu"]); // a loader with no real device
    expect(chainOf(pc({ gpus: [{ vendor: "amd", vramGb: 8 }], vulkan: false }))).toEqual(["cpu"]);
    expect(chainOf(pc({ gpus: [{ vendor: "amd" }], vulkan: null }))).toEqual(["cpu"]);
  });
  it("the CPU variant follows the flags: avx512, avx2, plain without AVX2, generic when unmeasured", () => {
    expect(llama.cpuVariant(pc({ cpu: { avx2: true, avx512: true } }))).toBe("avx512");
    expect(llama.cpuVariant(pc({ cpu: { avx2: true, avx512: false } }))).toBe("avx2");
    expect(llama.cpuVariant(pc({ cpu: { avx2: false } }))).toBe("plain");
    expect(llama.cpuVariant(pc({ cpu: { avx2: null } }))).toBe("cpu");
    expect(llama.cpuVariant(null)).toBe("cpu");
    expect(llama.cpuVariant(pc({ cpu: { avx2: false, avx512: true } }))).toBe("plain");
  });
  it("garbage facts give the CPU build, never a throw", () => {
    for (const f of [null, undefined, "x", 5, { gpus: "no", cuda: 3 }]) {
      expect(llama.backendChain(f as never).chain.at(-1).backend).toBe("cpu");
    }
  });
  it("nextStep goes cuda, vulkan, cpu and ends", () => {
    const { chain } = llama.backendChain(nvidia(8));
    expect(llama.nextStep(chain, "cuda").backend).toBe("vulkan");
    expect(llama.nextStep(chain, "vulkan").backend).toBe("cpu");
    expect(llama.nextStep(chain, "cpu")).toBeNull();
  });
});

const ZIP = (name: string, extra = {}) => ({
  name,
  url: `https://github.com/ggml-org/llama.cpp/releases/download/b11300/${name}`,
  bytes: 1000,
  sha256: sha(name),
  ...extra,
});
const ASSETS = [
  ZIP("llama-b11300-bin-win-cpu-x64.zip"),
  ZIP("llama-b11300-bin-win-cpu-arm64.zip"),
  ZIP("llama-b11300-bin-win-vulkan-x64.zip"),
  ZIP("llama-b11300-bin-win-cuda-12.4-x64.zip"),
  ZIP("llama-b11300-bin-win-cuda-12.8-x64.zip"),
  ZIP("cudart-llama-bin-win-cuda-12.4-x64.zip"),
  ZIP("cudart-llama-bin-win-cuda-12.8-x64.zip"),
  ZIP("llama-b11300-bin-win-cuda-13.1-x64.zip"),
  ZIP("llama-b11300-bin-win-sycl-x64.zip"),
];

describe("planAssets: patterns matched against the release's own names", () => {
  it("CUDA: the newest 12.x the driver supports, with the cudart zip of the same minor", () => {
    const hi = llama.planAssets({ backend: "cuda", variant: "cuda", driverCuda: 12.9 }, ASSETS);
    expect(hi).toMatchObject({ ok: true, variant: "cuda-12.8" });
    expect(hi.zips.map((z: { name: string }) => z.name)).toEqual([
      "llama-b11300-bin-win-cuda-12.8-x64.zip",
      "cudart-llama-bin-win-cuda-12.8-x64.zip",
    ]);
    const mid = llama.planAssets({ backend: "cuda", variant: "cuda", driverCuda: 12.4 }, ASSETS);
    expect(mid.variant).toBe("cuda-12.4");
    // CUDA 13 is never chosen for a 12.x driver, and a driver below 12.4 has no matching build here
    const low = llama.planAssets({ backend: "cuda", variant: "cuda", driverCuda: 12.1 }, ASSETS);
    expect(low.ok).toBe(false);
  });
  it("names are matched case-insensitively", () => {
    const loud = ASSETS.map((a) => ({ ...a, name: a.name.toUpperCase().replace(".ZIP", ".zip") }));
    expect(llama.planAssets({ backend: "vulkan", variant: "vulkan" }, loud).ok).toBe(true);
    expect(llama.planAssets({ backend: "cuda", variant: "cuda", driverCuda: 12.9 }, loud).ok).toBe(
      true,
    );
  });
  it("a CUDA main zip without its cudart zip is refused", () => {
    const noRt = ASSETS.filter((a) => !a.name.startsWith("cudart"));
    expect(
      llama.planAssets({ backend: "cuda", variant: "cuda", driverCuda: 12.9 }, noRt),
    ).toMatchObject({ ok: false });
  });
  it("Vulkan and the CPU variants; the plain build falls to the CPU zip when the release has no noavx zip", () => {
    expect(llama.planAssets({ backend: "vulkan", variant: "vulkan" }, ASSETS).zips[0].name).toBe(
      "llama-b11300-bin-win-vulkan-x64.zip",
    );
    expect(llama.planAssets({ backend: "cpu", variant: "avx2" }, ASSETS)).toMatchObject({
      ok: true,
      variant: "cpu",
    });
    const old = [
      ...ASSETS,
      ZIP("llama-b11300-bin-win-avx2-x64.zip"),
      ZIP("llama-b11300-bin-win-noavx-x64.zip"),
    ];
    expect(llama.planAssets({ backend: "cpu", variant: "avx2" }, old).variant).toBe("avx2");
    expect(llama.planAssets({ backend: "cpu", variant: "plain" }, old).variant).toBe("noavx");
    expect(llama.planAssets({ backend: "cpu", variant: "plain" }, ASSETS).zips[0].name).toBe(
      "llama-b11300-bin-win-cpu-x64.zip",
    );
  });
  it("never picks an ARM or SYCL zip, and a zip without a digest is not installable", () => {
    const arm = [ZIP("llama-b11300-bin-win-cpu-arm64.zip")];
    expect(llama.planAssets({ backend: "cpu", variant: "cpu" }, arm).ok).toBe(false);
    const bare = [ZIP("llama-b11300-bin-win-cpu-x64.zip", { sha256: "" })];
    const out = llama.planAssets({ backend: "cpu", variant: "cpu" }, bare);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/SHA-256/);
    expect(llama.planAssets({ backend: "cpu", variant: "cpu" }, [] as never).ok).toBe(false);
  });
});

const NEW = [
  ZIP("llama-b12619-bin-win-cpu-x64.zip"),
  ZIP("llama-b12619-bin-win-cpu-arm64.zip"),
  ZIP("llama-b12619-bin-win-vulkan-x64.zip"),
  ZIP("llama-b12619-bin-win-vulkan-arm64.zip"),
  ZIP("llama-b12619-bin-win-cuda-12.4-x64.zip"),
  ZIP("cudart-llama-bin-win-cuda-12.4-x64.zip"),
  ZIP("llama-b12619-bin-win-cuda-13.5-x64.zip"),
  ZIP("cudart-llama-bin-win-cuda-13.5-x64.zip"),
  ZIP("llama-b12619-bin-win-rocm-10.0-x64.zip"),
  ZIP("llama-b12619-bin-win-sycl-x64.zip"),
  ZIP("llama-b12619-bin-win-openvino-2026.4.1-x64.zip"),
];
const names = (r: { zips: { name: string }[] }) => r.zips.map((z) => z.name);
const gpuOf = (vendor: string, over: Facts = {}): Facts =>
  pc({
    gpus: [{ vendor, name: "card", vramGb: 16, vramCapped: false, integrated: false, ...over }],
    gpuVendor: vendor,
    vulkan: true,
  });

describe("CUDA 13, ROCm, ARM64, SYCL and OpenVINO builds (b12619 names)", () => {
  it("a CUDA 13 driver gets cuda-13.5 with its cudart; a 12.x driver never gets 13", () => {
    const hi = llama.planAssets({ backend: "cuda", variant: "cuda", driverCuda: 13 }, NEW);
    expect(hi).toMatchObject({ ok: true, variant: "cuda-13.5" });
    expect(names(hi)).toEqual([
      "llama-b12619-bin-win-cuda-13.5-x64.zip",
      "cudart-llama-bin-win-cuda-13.5-x64.zip",
    ]);
    const mid = llama.planAssets({ backend: "cuda", variant: "cuda", driverCuda: 12.9 }, NEW);
    expect(mid.variant).toBe("cuda-12.4");
    const only12 = NEW.filter((a) => !/13\.5/.test(a.name));
    expect(
      llama.planAssets({ backend: "cuda", variant: "cuda", driverCuda: 13 }, only12).variant,
    ).toBe("cuda-12.4");
    const noRt13 = NEW.filter((a) => a.name !== "cudart-llama-bin-win-cuda-13.5-x64.zip");
    expect(
      llama.planAssets({ backend: "cuda", variant: "cuda", driverCuda: 13 }, noRt13).variant,
    ).toBe("cuda-12.4");
  });
  it("the chain carries the driver's CUDA level so a CUDA 13 driver reaches the planner", () => {
    const entry = llama.backendChain(nvidia(12, { driverCuda: "13.0" })).chain[0];
    expect(entry).toMatchObject({ backend: "cuda", driverCuda: 13 });
    expect(llama.planAssets(entry, NEW).variant).toBe("cuda-13.5");
  });
  it("AMD: rocm, then vulkan, then cpu; an integrated AMD part goes straight to vulkan", () => {
    expect(chainOf(gpuOf("amd"))).toEqual(["rocm", "vulkan", "cpu"]);
    expect(chainOf(gpuOf("amd", { integrated: true }))).toEqual(["vulkan", "cpu"]);
    expect(chainOf(gpuOf("intel"))).toEqual(["vulkan", "cpu"]);
    const rocm = llama.planAssets(llama.backendChain(gpuOf("amd")).chain[0], NEW);
    expect(rocm).toMatchObject({ ok: true, variant: "rocm-10.0" });
    expect(names(rocm)).toEqual(["llama-b12619-bin-win-rocm-10.0-x64.zip"]);
    expect(llama.planAssets({ backend: "rocm", variant: "rocm" }, ASSETS)).toMatchObject({
      ok: false,
    });
  });
  it("SYCL and OpenVINO are planned by name when asked for, never by the default chain", () => {
    expect(names(llama.planAssets({ backend: "sycl", variant: "sycl" }, NEW))).toEqual([
      "llama-b12619-bin-win-sycl-x64.zip",
    ]);
    expect(names(llama.planAssets({ backend: "openvino", variant: "openvino" }, NEW))).toEqual([
      "llama-b12619-bin-win-openvino-2026.4.1-x64.zip",
    ]);
    for (const f of [gpuOf("amd"), gpuOf("intel"), nvidia(8)])
      expect(chainOf(f)).not.toEqual(expect.arrayContaining(["sycl"]));
  });
  it("Windows on ARM: only the arm64 CPU zip, from the facts' arch; an unknown arch stays x64", () => {
    const arm = llama.backendChain(pc({ arch: "arm64" }));
    expect(arm.chain).toEqual([{ backend: "cpu", variant: "cpu", arch: "arm64" }]);
    expect(names(llama.planAssets(arm.chain[0], NEW))).toEqual([
      "llama-b12619-bin-win-cpu-arm64.zip",
    ]);
    expect(chainOf(nvidia(8, {}))).toContain("cuda");
    expect(chainOf({ ...nvidia(8), arch: "arm64" })).toEqual(["cpu"]);
    expect(chainOf(pc({ os: { arch: "ARM64" } }))).toEqual(["cpu"]);
    for (const arch of [undefined, null, "x64", "AMD64", "ia32"]) {
      const c = llama.backendChain(pc({ arch })).chain.at(-1);
      expect(names(llama.planAssets(c, NEW))).toEqual(["llama-b12619-bin-win-cpu-x64.zip"]);
    }
  });
  it("rocm, sycl and openvino count as GPU backends", () => {
    for (const b of ["cuda", "vulkan", "rocm", "sycl", "openvino"])
      expect(llama.isGpuBackend(b)).toBe(true);
    expect(llama.isGpuBackend("cpu")).toBe(false);
  });
});

describe("healthCheck: three seconds, and a loader failure is a failure", () => {
  it("exit 0 is healthy; a timeout, a missing-DLL status and silence are not", async () => {
    expect(
      await llama.healthCheck("bin", ["--version"], {
        exec: async () => ({ code: 0, output: "version: 11300" }),
      }),
    ).toMatchObject({ ok: true });
    const timeoutSeen: number[] = [];
    const slow = await llama.healthCheck("bin", ["--version"], {
      exec: async (_f: string, _a: string[], o: { timeout: number }) => {
        timeoutSeen.push(o.timeout);
        return { code: -1, killed: true, output: "" };
      },
    });
    expect(timeoutSeen).toEqual([3000]);
    expect(slow).toMatchObject({ ok: false });
    expect(slow.reason).toMatch(/3 s/);
    const dll = await llama.healthCheck("bin", [], {
      exec: async () => ({ code: 0xc0000135, output: "" }),
    });
    expect(dll.ok).toBe(false);
    expect(dll.reason).toMatch(/0xc0000135/);
    expect(
      (
        await llama.healthCheck("bin", [], {
          exec: async () => ({ code: 1, output: "", error: "boom" }),
        })
      ).ok,
    ).toBe(false);
    // a tool that prints its usage and exits 1 still started
    expect(
      (
        await llama.healthCheck("bin", [], {
          exec: async () => ({ code: 1, output: "usage: sd [options]" }),
        })
      ).ok,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------ installEngine */

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-engine-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake download that writes the name as the content (so sha(name) is the right digest) unless told otherwise. */
function fakes(
  options: {
    tamper?: string[];
    failUrl?: string[];
    unhealthy?: string[];
    noServer?: string[];
  } = {},
) {
  const log: string[] = [];
  return {
    log,
    deps: {
      download: async (url: string, dest: string) => {
        const name = decodeURIComponent(url.split("/").pop()!);
        log.push(`download ${name}`);
        if (options.failUrl?.some((u) => name.includes(u))) throw new Error("connection reset");
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, options.tamper?.some((u) => name.includes(u)) ? "TAMPERED" : name);
      },
      extract: async (zip: string, dest: string) => {
        const name = path.basename(zip);
        log.push(`extract ${name}`);
        mkdirSync(dest, { recursive: true });
        if (name.startsWith("cudart")) writeFileSync(path.join(dest, "cudart64_12.dll"), "x");
        else if (!options.noServer?.some((u) => name.includes(u)))
          writeFileSync(path.join(dest, SERVER), name);
        writeFileSync(path.join(dest, `${name}.marker`), "x");
        return { ok: true };
      },
      health: async (bin: string) => {
        const built = readFileSync(bin, "utf8");
        log.push(`health ${built}`);
        return options.unhealthy?.some((u) => built.includes(u))
          ? { ok: false, reason: "it could not start (exit status 0xc0000135)" }
          : { ok: true };
      },
      diskFree: () => 50 * 1024 ** 3,
      now: () => 1_800_000_000_000,
    },
  };
}
const release = (tag = "b11300", assets = ASSETS) => ({
  ok: true,
  version: tag.replace(/^b/, ""),
  tag,
  assets,
  source: "github-api",
});
const spec = () => engines.ENGINES["llama.cpp"];
const folders = () => {
  const base = engines.engineBase(dir, spec());
  return existsSync(base) ? readdirSync(base).sort() : [];
};

describe("installEngine: verified, started once, then swapped in", () => {
  it("installs the CUDA build with its cudart zip, writes the marker and leaves no staging folder", async () => {
    const f = fakes();
    const out = await engines.installEngine(
      dir,
      spec(),
      { release: release(), facts: nvidia(8) },
      f.deps,
    );
    expect(out).toMatchObject({
      ok: true,
      backend: "cuda",
      variant: "cuda-12.8",
      tag: "b11300",
      fellBack: [],
    });
    expect(folders()).toEqual(["b11300-cuda-12.8"]);
    const folder = path.join(engines.engineBase(dir, spec()), "b11300-cuda-12.8");
    expect(existsSync(path.join(folder, SERVER))).toBe(true);
    expect(existsSync(path.join(folder, "cudart64_12.dll"))).toBe(true);
    const marker = JSON.parse(readFileSync(path.join(folder, engines.MARKER), "utf8"));
    expect(marker).toMatchObject({ backend: "cuda", version: "11300", pinnedRelease: false });
    expect(marker.files.map((x: { sha256: string }) => x.sha256)).toEqual([
      sha("llama-b11300-bin-win-cuda-12.8-x64.zip"),
      sha("cudart-llama-bin-win-cuda-12.8-x64.zip"),
    ]);
    // the engine is found by the same function the app uses to start it
    expect(llama.findServer(dir)).toBe(path.join(folder, SERVER));
    expect(llama.readBackend(dir)).toMatchObject({ backend: "cuda", variant: "cuda-12.8" });
    expect(engines.detectEngine(dir, spec())).toMatchObject({
      installed: true,
      version: "11300",
      backend: "cuda",
    });
  });

  it("a CUDA build that does not start falls to Vulkan, then CPU, and the reasons are recorded", async () => {
    const f = fakes({ unhealthy: ["cuda", "vulkan"] });
    const out = await engines.installEngine(
      dir,
      spec(),
      { release: release(), facts: nvidia(8) },
      f.deps,
    );
    expect(out).toMatchObject({ ok: true, backend: "cpu" });
    expect(
      out.fellBack.map((x: { backend: string; stage: string }) => [x.backend, x.stage]),
    ).toEqual([
      ["cuda", "health"],
      ["vulkan", "health"],
    ]);
    expect(out.fellBack[0].reason).toMatch(/0xc0000135/);
    expect(folders()).toEqual(["b11300-cpu"]); // the two failed builds were removed
    const order = f.log.filter((l) => l.startsWith("health")).length;
    expect(order).toBe(3);
    expect(
      JSON.parse(
        readFileSync(
          path.join(engines.engineBase(dir, spec()), "b11300-cpu", engines.MARKER),
          "utf8",
        ),
      ).fellBack,
    ).toHaveLength(2);
  });

  it("when CUDA is skipped by the facts the reason is kept too", async () => {
    const out = await engines.installEngine(
      dir,
      spec(),
      { release: release(), facts: nvidia(8, { free: 2 }) },
      fakes().deps,
    );
    expect(out.backend).toBe("vulkan");
    expect(out.fellBack[0]).toMatchObject({ backend: "cuda", stage: "skipped" });
  });

  it("a tampered download is refused against the official digest and the next build is tried", async () => {
    const f = fakes({ tamper: ["vulkan"] });
    const out = await engines.installEngine(
      dir,
      spec(),
      { release: release(), facts: pc({ gpus: [{ vendor: "amd", vramGb: 8 }], vulkan: true }) },
      f.deps,
    );
    expect(out).toMatchObject({ ok: true, backend: "cpu" });
    const vulkan = out.fellBack.find((x: { backend: string }) => x.backend === "vulkan");
    expect(vulkan).toMatchObject({ stage: "download" });
    expect(vulkan.reason).toMatch(/digest/i);
    expect(out.fellBack[0]).toMatchObject({ backend: "cuda", stage: "skipped" });
    expect(
      existsSync(
        path.join(dir, "runtime", "installers", "llama.cpp", "llama-b11300-bin-win-vulkan-x64.zip"),
      ),
    ).toBe(false);
  });

  it("every build failing is a clear error and the old install keeps working untouched", async () => {
    const old = ASSETS.map((a) => {
      const name = a.name.replace("b11300", "b11200");
      return {
        ...a,
        name,
        url: a.url.replace("b11300", "b11200").replace(a.name, name),
        sha256: sha(name),
      };
    });
    await engines.installEngine(
      dir,
      spec(),
      { release: release("b11200", old), facts: pc() },
      fakes().deps,
    );
    const before = folders();
    const f = fakes({ tamper: ["cpu"] });
    const out = await engines.installEngine(
      dir,
      spec(),
      { release: release(), facts: pc() },
      f.deps,
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/previous install is untouched/);
    expect(folders()).toEqual(before);
    expect(llama.installed(dir)).toBe(true);
    expect(llama.findServer(dir)).toContain("b11200");
  });

  it("an update installs next to the old copy, becomes the active one, and only the newest two are kept", async () => {
    const mk = (tag: string) =>
      release(
        tag,
        ASSETS.map((a) => {
          const name = a.name.replace("b11300", tag);
          return {
            ...a,
            name,
            url: a.url.replace("b11300", tag).replace(a.name, name),
            sha256: sha(name),
          };
        }),
      );
    for (const tag of ["b11100", "b11200", "b11300"]) {
      const out = await engines.installEngine(
        dir,
        spec(),
        { release: mk(tag), facts: pc() },
        fakes().deps,
      );
      expect(out.ok).toBe(true);
    }
    expect(folders()).toEqual(["b11200-cpu", "b11300-cpu"]);
    expect(llama.findServer(dir)).toContain("b11300-cpu");
  });

  it("re-installing the same release swaps through .prev and keeps no leftovers", async () => {
    await engines.installEngine(dir, spec(), { release: release(), facts: pc() }, fakes().deps);
    const out = await engines.installEngine(
      dir,
      spec(),
      { release: release(), facts: pc() },
      fakes().deps,
    );
    expect(out.ok).toBe(true);
    expect(folders()).toEqual(["b11300-cpu"]);
  });

  it("a zip that unpacks without the server is a failed build, not an install", async () => {
    const out = await engines.installEngine(
      dir,
      spec(),
      { release: release(), facts: pc() },
      fakes({ noServer: ["cpu"] }).deps,
    );
    expect(out.ok).toBe(false);
    expect(out.attempts.at(-1).reason).toMatch(/no llama-server/);
    expect(folders()).toEqual([]);
  });

  it("not enough disk skips a build without downloading it", async () => {
    const f = fakes();
    const out = await engines.installEngine(
      dir,
      spec(),
      { release: release(), facts: pc() },
      { ...f.deps, diskFree: () => 1000 },
    );
    expect(out.ok).toBe(false);
    expect(out.attempts.at(-1).stage).toBe("disk");
    expect(f.log).toEqual([]);
  });

  it("the vendor digest and the pin must agree for the same file", async () => {
    const pinned = engines.ENGINES["llama.cpp"].pinned;
    const pin = pinned.assets[0];
    const forged = {
      ...release(pinned.tag),
      version: pinned.version,
      assets: [{ ...pin, sha256: "f".repeat(64) }],
    };
    const f = fakes();
    const out = await engines.installEngine(dir, spec(), { release: forged, facts: pc() }, f.deps);
    expect(out.ok).toBe(false);
    expect(out.attempts.at(-1)).toMatchObject({ stage: "digest" });
    expect(f.log).toEqual([]);
  });

  it("the work runs in the governor's lanes: download then install, and the install lane for unpack", async () => {
    const lanes: string[] = [];
    const f = fakes();
    await engines.installEngine(
      dir,
      spec(),
      { release: release(), facts: pc() },
      { ...f.deps, run: (kind: string, fn: () => unknown) => (lanes.push(kind), fn()) },
    );
    expect(lanes).toEqual(["download", "install"]);
  });

  it("uninstall removes only the engine's own folder", async () => {
    await engines.installEngine(dir, spec(), { release: release(), facts: pc() }, fakes().deps);
    mkdirSync(path.join(dir, "runtime", "engines", "other"), { recursive: true });
    expect(engines.uninstallEngine(dir, spec())).toBe(true);
    expect(existsSync(engines.engineBase(dir, spec()))).toBe(false);
    expect(existsSync(path.join(dir, "runtime", "engines", "other"))).toBe(true);
    expect(engines.uninstallEngine(null as never, spec())).toBe(false);
  });
});

describe("releaseForInstall: the pinned release is the last source", () => {
  it("a release with assets is used as it is; atom-only (no assets) uses the pin and says so; none is a clear error", () => {
    const live = {
      ok: true,
      version: "11300",
      tag: "b11300",
      assets: ASSETS,
      source: "github-api",
      pinned: false,
    };
    expect(engines.releaseForInstall(spec(), live)).toMatchObject({
      usedPin: false,
      tag: "b11300",
    });
    const atom = { ok: true, version: "11299", tag: "b11299", assets: [], source: "github-atom" };
    const pinned = engines.releaseForInstall(spec(), atom);
    expect(pinned).toMatchObject({ usedPin: true, source: "pinned" });
    expect(pinned.tag).toMatch(/^b\d+$/);
    expect(pinned.assets[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    const none = engines.releaseForInstall(engines.ENGINES["stable-diffusion.cpp"], {
      ok: false,
      error: "no official source answered",
    });
    expect(none).toMatchObject({ ok: false });
    expect(none.error).toMatch(/no official source/);
  });
  it("the pin equals what the setup path verifies (config/local-runners.json)", () => {
    const runners = JSON.parse(
      readFileSync(path.join(root, "config/local-runners.json"), "utf8"),
    ).runners;
    const row = runners.find((r: { id: string }) => r.id === "llamacpp").release;
    const pin = engines.ENGINES["llama.cpp"].pinned;
    expect(row.tag).toBe(pin.tag);
    expect(pin.assets[0]).toMatchObject({ name: row.asset, sha256: row.sha256, bytes: row.bytes });
  });
});

describe("stable-diffusion.cpp and FFmpeg: same logic, their own names", () => {
  const SD = [
    {
      name: "sd-master-abc1234-bin-win-avx2-x64.zip",
      url: "https://x/a",
      bytes: 5,
      sha256: sha("a"),
    },
    {
      name: "sd-master-abc1234-bin-win-avx512-x64.zip",
      url: "https://x/b",
      bytes: 5,
      sha256: sha("b"),
    },
    {
      name: "sd-master-abc1234-bin-win-noavx-x64.zip",
      url: "https://x/c",
      bytes: 5,
      sha256: sha("c"),
    },
    {
      name: "sd-master-abc1234-bin-win-vulkan-x64.zip",
      url: "https://x/d",
      bytes: 5,
      sha256: sha("d"),
    },
    {
      name: "sd-master-abc1234-bin-win-cuda12-x64.zip",
      url: "https://x/e",
      bytes: 5,
      sha256: sha("e"),
    },
    { name: "cudart-sd-bin-win-cu12-x64.zip", url: "https://x/f", bytes: 5, sha256: sha("f") },
  ];
  it("picks cuda12 / vulkan / avx by the same facts", () => {
    const plan = (backend: string, variant: string) => engines.sdPlan({ backend, variant }, SD);
    expect(plan("cuda", "cuda").zips.map((z: { name: string }) => z.name)).toEqual([
      SD[4]!.name,
      SD[5]!.name,
    ]);
    expect(plan("vulkan", "vulkan").zips[0].name).toBe(SD[3]!.name);
    expect(plan("cpu", "avx512").variant).toBe("avx512");
    expect(plan("cpu", "avx2").variant).toBe("avx2");
    expect(plan("cpu", "plain").variant).toBe("noavx");
    expect(plan("cpu", "avx2").zips[0].name).not.toMatch(/cudart/);
    expect(engines.sdPlan({ backend: "cpu", variant: "avx2" }, [])).toMatchObject({ ok: false });
  });
  it("FFmpeg: the numbered LGPL shared build, digest from the asset or from checksums.sha256", async () => {
    const assets = [
      {
        name: "ffmpeg-master-latest-win64-lgpl-shared.zip",
        url: "https://x/m",
        bytes: 9,
        sha256: "",
      },
      {
        name: "ffmpeg-n7.1-latest-win64-lgpl-shared-7.1.zip",
        url: "https://x/n",
        bytes: 9,
        sha256: "",
      },
      {
        name: "ffmpeg-n7.1-latest-win64-gpl-shared-7.1.zip",
        url: "https://x/g",
        bytes: 9,
        sha256: sha("g"),
      },
      { name: "checksums.sha256", url: "https://x/sums", bytes: 1, sha256: "" },
    ];
    const sums = `${sha("n")}  ffmpeg-n7.1-latest-win64-lgpl-shared-7.1.zip\n${sha("m")}  ffmpeg-master-latest-win64-lgpl-shared.zip\n`;
    const out = await engines.ffmpegPlan({}, assets, { fetchText: async () => sums });
    expect(out).toMatchObject({ ok: true, variant: "lgpl-shared" });
    expect(out.zips[0]).toMatchObject({
      name: "ffmpeg-n7.1-latest-win64-lgpl-shared-7.1.zip",
      sha256: sha("n"),
    });
    expect((await engines.ffmpegPlan({}, assets, {})).ok).toBe(false); // no digest, no install
    expect((await engines.ffmpegPlan({}, [assets[2]], {})).ok).toBe(false); // never the GPL build
  });
  it("FFmpeg installs through the same path into its own folder", async () => {
    const ff = engines.ENGINES["FFmpeg (LGPL, portable)"];
    const assets = [
      {
        name: "ffmpeg-n7.1-latest-win64-lgpl-shared-7.1.zip",
        url: "https://x/n",
        bytes: 9,
        sha256: sha("n"),
      },
    ];
    const f = fakes();
    const deps = {
      ...f.deps,
      extract: async (_z: string, dest: string) => {
        mkdirSync(path.join(dest, "bin"), { recursive: true });
        writeFileSync(
          path.join(dest, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
          "ff",
        );
        return { ok: true };
      },
      health: async () => ({ ok: true }),
    };
    const out = await engines.installEngine(
      dir,
      ff,
      {
        release: { ok: true, version: "7.1", tag: "latest", assets, source: "github-api" },
        facts: pc(),
      },
      deps,
    );
    expect(out).toMatchObject({ ok: true, backend: "cpu", variant: "lgpl-shared" });
    expect(engines.detectEngine(dir, ff)).toMatchObject({ installed: true });
  });
});

/* ------------------------------------------------------------ pinned wheels */

describe("pinned wheels: pip verifies the SHA-256 before anything installed is touched", () => {
  const bundle = engines.PIP_BUNDLES["cuda-libs"];
  const answer = (dist: string) => ({
    ok: true,
    version: engines.PINNED_WHEELS[dist].version,
    assets: engines.PINNED_WHEELS[dist].assets,
  });
  const resolved = {
    "nvidia-cublas-cu12": answer("nvidia-cublas-cu12"),
    "nvidia-cudnn-cu12": answer("nvidia-cudnn-cu12"),
  };

  it("the pins are the wheels PyPI listed on 2026-11-23: Windows wheels, 64-hex digests, the sizes in the roadmap", () => {
    expect(engines.PINNED_WHEELS["nvidia-cublas-cu12"]).toMatchObject({ version: "12.9.2.10" });
    expect(engines.PINNED_WHEELS["nvidia-cublas-cu12"].assets[0].bytes).toBe(553162896);
    expect(engines.PINNED_WHEELS["nvidia-cudnn-cu12"]).toMatchObject({ version: "9.28.1.4" });
    expect(engines.PINNED_WHEELS["nvidia-cudnn-cu12"].assets[0].bytes).toBe(696300805);
    for (const pin of Object.values(engines.PINNED_WHEELS) as {
      assets: { name: string; sha256: string }[];
    }[]) {
      for (const a of pin.assets) {
        expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(a.name).toMatch(/win_amd64\.whl$/);
      }
    }
    expect(engines.PINNED_WHEELS["onnxruntime-gpu"].assets).toHaveLength(4);
  });

  it("the requirements file has name==version --hash=sha256 lines; a Python-specific wheel follows the interpreter", () => {
    const plan = engines.planWheels(bundle, resolved);
    expect(plan.lines).toEqual([
      `nvidia-cublas-cu12==12.9.2.10 --hash=sha256:${engines.PINNED_WHEELS["nvidia-cublas-cu12"].assets[0].sha256}`,
      `nvidia-cudnn-cu12==9.28.1.4 --hash=sha256:${engines.PINNED_WHEELS["nvidia-cudnn-cu12"].assets[0].sha256}`,
    ]);
    const ort = engines.PIP_BUNDLES["ort-directml"];
    const r = { "onnxruntime-directml": answer("onnxruntime-directml") };
    expect(engines.planWheels(ort, r, { pyTag: "cp312" }).wheels[0].name).toContain("cp312");
    expect(engines.planWheels(ort, r, { pyTag: "cp313" }).wheels[0].name).toContain("cp313");
    expect(engines.planWheels(ort, r, { pyTag: "cp39" })).toMatchObject({ ok: false });
    expect(engines.planWheels(ort, r, {})).toMatchObject({ ok: false });
  });

  it("refuses a wheel with no digest and a vendor digest that contradicts the pin", () => {
    const bare = {
      "nvidia-cublas-cu12": {
        ok: true,
        version: "12.9.2.10",
        assets: [{ name: "nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl", sha256: "" }],
      },
      "nvidia-cudnn-cu12": resolved["nvidia-cudnn-cu12"],
    };
    expect(engines.planWheels(bundle, bare)).toMatchObject({ ok: false });
    const forged = {
      ...resolved,
      "nvidia-cudnn-cu12": {
        ok: true,
        version: "9.28.1.4",
        assets: [
          { ...engines.PINNED_WHEELS["nvidia-cudnn-cu12"].assets[0], sha256: "e".repeat(64) },
        ],
      },
    };
    const out = engines.planWheels(bundle, forged);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pinned/);
    expect(
      engines.planWheels(bundle, { ...resolved, "nvidia-cudnn-cu12": { ok: false } }),
    ).toMatchObject({ ok: false });
  });

  /** `pip download name==version -d folder` leaves a wheel there, as pip does (the rollback copy of the installed one). */
  function keepWheels(args: string[]) {
    if (args[args.indexOf("-m") + 2] !== "download" || args.includes("-r")) return;
    const folder = args[args.indexOf("-d") + 1]!;
    mkdirSync(folder, { recursive: true });
    for (const spec of args.filter((a) => /==/.test(a))) {
      const [name, version] = spec.split("==") as [string, string];
      writeFileSync(
        path.join(folder, `${name.replace(/-/g, "_")}-${version}-cp312-cp312-win_amd64.whl`),
        spec,
      );
    }
  }

  function pipFake(script: { failOn?: string } = {}) {
    const calls: string[][] = [];
    const exec = async (_exe: string, args: string[]) => {
      calls.push(args);
      const verb = args.includes("-c") ? "probe" : args[args.indexOf("pip") + 1] || args[2]!;
      keepWheels(args);
      if (script.failOn === verb) return { code: 1, output: `ERROR: ${verb} failed\nsecond line` };
      return { code: 0, output: "ok" };
    };
    return { calls, exec };
  }
  const python = { exe: "python", prefix: [] as string[] };
  const verbs = (calls: string[][]) =>
    calls.map((a) => (a.includes("-c") ? "probe" : (a[a.indexOf("-m") + 2] ?? "probe")));

  it("download first, conflicting variants removed only afterwards, then install from the verified folder", async () => {
    const plan = engines.planWheels(
      engines.PIP_BUNDLES["ort-gpu"],
      { "onnxruntime-gpu": answer("onnxruntime-gpu") },
      { pyTag: "cp312" },
    );
    const fake = pipFake();
    const out = await engines.installPinnedWheels(
      dir,
      engines.PIP_BUNDLES["ort-gpu"],
      plan,
      python,
      {
        exec: fake.exec,
        freeze: async () =>
          new Map([
            ["onnxruntime", "1.30.0"],
            ["numpy", "2.0"],
          ]),
      },
    );
    expect(out).toMatchObject({ ok: true, removed: ["onnxruntime"] });
    // the installed variant is copied out first (download), and only then removed
    expect(verbs(fake.calls)).toEqual([
      "download",
      "download",
      "uninstall",
      "install",
      "install",
      "probe",
    ]);
    const download = fake.calls[0]!;
    expect(download).toContain("--require-hashes");
    expect(download).toContain("--no-deps");
    expect(fake.calls[3]).toEqual(
      expect.arrayContaining(["--no-index", "--require-hashes", "--no-deps"]),
    );
    expect(fake.calls[2]).toContain("onnxruntime");
    expect(fake.calls[2]).not.toContain("numpy");
    const reqFile = download[download.indexOf("-r") + 1]!;
    expect(readFileSync(reqFile, "utf8")).toMatch(
      /^onnxruntime-gpu==1\.32\.0 --hash=sha256:[0-9a-f]{64}\n$/,
    );
    expect(reqFile.startsWith(path.join(dir, "runtime"))).toBe(true);
  });

  it("a refused download leaves the installed variant untouched: nothing is uninstalled", async () => {
    const plan = engines.planWheels(
      engines.PIP_BUNDLES["ort-gpu"],
      { "onnxruntime-gpu": answer("onnxruntime-gpu") },
      { pyTag: "cp312" },
    );
    const fake = pipFake({ failOn: "download" });
    const out = await engines.installPinnedWheels(
      dir,
      engines.PIP_BUNDLES["ort-gpu"],
      plan,
      python,
      {
        exec: fake.exec,
        freeze: async () => new Map([["onnxruntime", "1.30.0"]]),
      },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/untouched/);
    expect(verbs(fake.calls)).toEqual(["download"]);
  });

  it("a failed install puts the previous variant back", async () => {
    const plan = engines.planWheels(
      engines.PIP_BUNDLES["ort-gpu"],
      { "onnxruntime-gpu": answer("onnxruntime-gpu") },
      { pyTag: "cp312" },
    );
    const calls: string[][] = [];
    let installs = 0;
    const exec = async (_e: string, args: string[]) => {
      calls.push(args);
      keepWheels(args);
      if (args.includes("install") && args.includes("--require-hashes") && !isRestore(args)) {
        installs += 1;
        return { code: 1, output: "boom" };
      }
      return { code: 0, output: "ok" };
    };
    const isRestore = (args: string[]) => args.some((a) => a.endsWith(`${path.sep}previous`));
    const out = await engines.installPinnedWheels(
      dir,
      engines.PIP_BUNDLES["ort-gpu"],
      plan,
      python,
      {
        exec,
        freeze: async () => new Map([["onnxruntime", "1.30.0"]]),
      },
    );
    expect(installs).toBe(1);
    expect(out).toMatchObject({ ok: false, rolledBack: true });
    expect(out.error).toMatch(/previous version was put back/);
    // the previous variant returns from the hashed local copy, never from an unhashed network install
    expect(calls.at(-1)).toEqual(
      expect.arrayContaining(["install", "--no-index", "--require-hashes", "--no-deps"]),
    );
    expect(calls.filter((a) => a.includes("install") && !a.includes("--no-index"))).toEqual([]);
  });

  it("an import that fails after install is a failure, with the rollback", async () => {
    const plan = engines.planWheels(bundle, resolved);
    const fake = pipFake({ failOn: "probe" });
    const out = await engines.installPinnedWheels(dir, bundle, plan, python, {
      exec: fake.exec,
      freeze: async () => new Map(),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/failed/);
    expect(out.rolledBack).toBe(false); // nothing was installed before
  });

  it("the CUDA pair installs both wheels together with no dependency fetch, and runs in the governor lanes", async () => {
    const plan = engines.planWheels(bundle, resolved);
    const fake = pipFake();
    const lanes: string[] = [];
    const out = await engines.installPinnedWheels(dir, bundle, plan, python, {
      exec: fake.exec,
      freeze: async () => new Map(),
      run: (k: string, fn: () => unknown) => (lanes.push(k), fn()),
    });
    expect(out).toMatchObject({
      ok: true,
      versions: { "nvidia-cublas-cu12": "12.9.2.10", "nvidia-cudnn-cu12": "9.28.1.4" },
    });
    expect(verbs(fake.calls)).toEqual(["download", "install", "probe"]);
    expect(lanes).toEqual(["download", "install"]);
  });

  it("the wheel sources are PyPI JSON, PyPI Simple, then the pin", () => {
    const chain = engines.wheelSources("onnxruntime-gpu");
    expect(chain.map((s: { kind: string }) => s.kind)).toEqual([
      "pypi-json",
      "pypi-simple",
      "pinned",
    ]);
    expect(chain[0].platform).toBe("win_amd64");
    expect(engines.wheelSources("unknown-pkg").map((s: { kind: string }) => s.kind)).toEqual([
      "pypi-json",
      "pypi-simple",
    ]);
  });

  it("the engine source chains end in the pin only where one exists", () => {
    expect(
      engines.engineSources(engines.ENGINES["llama.cpp"]).map((s: { kind: string }) => s.kind),
    ).toEqual(["github-list", "github-atom", "pinned"]);
    expect(
      engines
        .engineSources(engines.ENGINES["stable-diffusion.cpp"])
        .map((s: { kind: string }) => s.kind),
    ).toEqual(["github-api", "github-atom"]);
    expect(vendor.chainFor({ sources: [{ kind: "npm", pkg: "x" }] })).toEqual([
      { kind: "npm", pkg: "x" },
    ]);
  });
});

describe("FRIDAY Core launch follows the installed build", () => {
  const tmpRoot = () => mkdtempSync(path.join(tmpdir(), "friday-core-build-"));
  const stat = (r: string) => {
    const core = require_(path.join(root, "electron/friday-core.cjs"));
    const manifest = require_(path.join(root, "config/friday-core.json"));
    const have = new Map<string, number>();
    for (const f of core.variantOf(manifest, "e4b").files)
      have.set(core.diskPath(r, f.disk), f.bytes);
    return (p: string) => (have.has(p) ? { size: have.get(p) } : undefined);
  };
  function installBuild(r: string, backend: string) {
    const folder = path.join(llama.engineDir(r), `b12230-${backend}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, SERVER), "x");
    writeFileSync(
      path.join(folder, ".friday-engine.json"),
      JSON.stringify({ backend, healthy: true }),
    );
  }

  it("adds GPU offload for a CUDA or Vulkan folder and none for a CPU folder", async () => {
    for (const [backend, gpu] of [
      ["cuda", true],
      ["vulkan", true],
      ["cpu", false],
    ] as const) {
      const r = tmpRoot();
      try {
        installBuild(r, backend);
        const out = await llama.coreLaunch(r, { stat: stat(r), port: 40101, key: "k", cpus: 8 });
        expect(out.ok).toBe(true);
        expect(out.bin).toBe(llama.findServer(r));
        expect(out.args.includes("-ngl")).toBe(gpu);
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    }
  });
});
