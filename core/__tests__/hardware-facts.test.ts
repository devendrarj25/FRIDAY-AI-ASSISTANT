import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const hwMod = require_("../../electron/hardware.cjs") as {
  hardwareFacts: (hw: unknown, deps?: Record<string, unknown>) => Facts;
  parseNvidiaSmi: (text: string) => Array<Record<string, unknown>>;
  parseCudaDriverVersion: (text: string) => string | null;
  parseVideoControllers: (text: string) => Array<Record<string, unknown>>;
  bestGpuFirst: (gpus: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
};

type Facts = {
  vramGb: number | null;
  vramFreeGb: number | null;
  ramGb: number | null;
  ramFreeGb: number | null;
  diskFreeGb: number | null;
  gpuVendor: string | null;
  gpuName: string | null;
  gpus: Array<{
    vendor: string;
    name: string;
    vramGb: number | null;
    driver: string | null;
    vramCapped: boolean;
  }>;
  cudaReady: boolean;
  driverVersion: string | null;
  npu: boolean;
  cpuClass: "low" | "mid" | "high" | null;
  sources: string[];
};

const GB = 1024 ** 3;

// Fake probe outputs, shaped exactly like the real probes print them.
const smi = (name: string, mib: number, usedMib = 600, driver = "560.94") =>
  `${name}, ${mib}, ${usedMib}, ${driver}, 3, 41`;
const smiHeader = (cuda: string) =>
  `+-----------------------------------------------------------------------------+\n| NVIDIA-SMI 560.94   Driver Version: 560.94   CUDA Version: ${cuda}     |\n+---`;

function machine(opts: {
  smiText?: string | null;
  smiPlain?: string | null;
  video?: Array<Record<string, unknown>> | string | null;
  ramGb?: number;
  freeGb?: number;
  diskFreeGb?: number | null;
  cores?: number;
  threads?: number;
}) {
  const nvidia = opts.smiText ? hwMod.parseNvidiaSmi(opts.smiText) : [];
  const cim =
    opts.video == null
      ? []
      : hwMod
          .parseVideoControllers(
            typeof opts.video === "string" ? opts.video : JSON.stringify(opts.video),
          )
          .filter((g) => nvidia.length === 0 || g["vendor"] !== "nvidia");
  const gpus = hwMod.bestGpuFirst([...nvidia, ...cim]);
  const cudaVersion = opts.smiPlain ? hwMod.parseCudaDriverVersion(opts.smiPlain) : null;
  return {
    cpu: { cores: opts.threads ?? 16, threads: opts.threads ?? 16, physicalCores: opts.cores ?? 8 },
    memory: { totalGb: opts.ramGb ?? 32, freeGb: opts.freeGb ?? 20 },
    disk: opts.diskFreeGb === null ? null : { freeGb: opts.diskFreeGb ?? 400, totalGb: 1000 },
    gpus,
    cuda: { driverAvailable: nvidia.length > 0, driverCudaVersion: cudaVersion },
  };
}

describe("hardwareFacts shape and sources", () => {
  it("returns exactly the documented keys", () => {
    const facts = hwMod.hardwareFacts(machine({}));
    expect(Object.keys(facts).sort()).toEqual(
      [
        "cpuClass",
        "cudaReady",
        "diskFreeGb",
        "driverVersion",
        "gpuName",
        "gpuVendor",
        "gpus",
        "npu",
        "ramFreeGb",
        "ramGb",
        "sources",
        "vramFreeGb",
        "vramGb",
      ].sort(),
    );
  });

  it("reads NVIDIA cards of 6, 12, 16 and 24 GB from nvidia-smi MiB and reports free VRAM", () => {
    for (const gb of [6, 12, 16, 24]) {
      const facts = hwMod.hardwareFacts(
        machine({
          smiText: smi("Some Card", gb * 1024, 1024),
          smiPlain: smiHeader("12.6"),
        }),
      );
      expect(facts.vramGb).toBe(gb);
      expect(facts.vramFreeGb).toBe(gb - 1);
      expect(facts.gpuVendor).toBe("nvidia");
      expect(facts.cudaReady).toBe(true);
      expect(facts.driverVersion).toBe("560.94");
      expect(facts.sources).toContain("nvidia-smi");
    }
  });

  it("does not trust a 4 GB AdapterRAM for an AMD card and never calls it CUDA", () => {
    const facts = hwMod.hardwareFacts(
      machine({
        video: [{ Name: "AMD Radeon RX 7800 XT", AdapterRAM: 4293918720, Driver: "31.0.1" }],
      }),
    );
    expect(facts.gpuVendor).toBe("amd");
    expect(facts.vramGb).toBeNull();
    expect(facts.cudaReady).toBe(false);
    expect(facts.sources).toContain("Win32_VideoController");
  });

  it("uses the driver's 64-bit figure for an AMD card when present", () => {
    const facts = hwMod.hardwareFacts(
      machine({
        video: [{ Name: "AMD Radeon RX 7900 XTX", AdapterRAM: 4293918720, Qw: 24 * GB }],
      }),
    );
    expect(facts.vramGb).toBe(24);
  });

  it("reports an Intel integrated GPU with its small dedicated memory", () => {
    const facts = hwMod.hardwareFacts(
      machine({ video: [{ Name: "Intel(R) UHD Graphics 770", AdapterRAM: 1073741824 }] }),
    );
    expect(facts.gpuVendor).toBe("intel");
    expect(facts.vramGb).toBe(1);
    expect(facts.cudaReady).toBe(false);
  });

  it("gives null GPU fields (never throws) on a PC with no GPU", () => {
    const facts = hwMod.hardwareFacts(machine({}));
    expect(facts.gpus).toEqual([]);
    expect(facts.gpuName).toBeNull();
    expect(facts.gpuVendor).toBeNull();
    expect(facts.vramGb).toBeNull();
    expect(facts.vramFreeGb).toBeNull();
    expect(facts.driverVersion).toBeNull();
    expect(facts.cudaReady).toBe(false);
  });

  it("picks the card with the most dedicated VRAM on a hybrid laptop", () => {
    const facts = hwMod.hardwareFacts(
      machine({
        smiText: smi("Laptop dGPU", 8 * 1024, 300),
        video: [
          { Name: "Intel(R) Iris Xe Graphics", AdapterRAM: 134217728 },
          { Name: "NVIDIA Laptop dGPU", AdapterRAM: 4293918720 },
        ],
      }),
    );
    expect(facts.gpus.map((g) => g.vendor).sort()).toEqual(["intel", "nvidia"]);
    expect(facts.gpuVendor).toBe("nvidia");
    expect(facts.vramGb).toBe(8);
  });

  it("an AMD discrete card with a capped AdapterRAM still outranks a 1 GB Intel iGPU", () => {
    const facts = hwMod.hardwareFacts(
      machine({
        video: [
          { Name: "Intel(R) UHD Graphics", AdapterRAM: 1073741824 },
          { Name: "AMD Radeon RX 6700", AdapterRAM: 4293918720 },
        ],
      }),
    );
    expect(facts.gpuVendor).toBe("amd");
    expect(facts.vramGb).toBeNull();
  });

  it("survives nvidia-smi absent, empty or garbage output with null fields", () => {
    for (const text of [null, "", "garbage\n[N/A], [N/A]\n,,,\n", "NVIDIA-SMI has failed"]) {
      const facts = hwMod.hardwareFacts(machine({ smiText: text }));
      expect(facts.vramGb).toBeNull();
      expect(facts.cudaReady).toBe(false);
    }
    expect(hwMod.parseNvidiaSmi("not, a, number, here")[0]?.["vramTotalMb"]).toBeNull();
  });

  it("never throws on null, a string, nested garbage or wrong types", () => {
    const junk: unknown[] = [
      null,
      undefined,
      "x",
      42,
      {},
      { gpus: "no", memory: 5, cpu: [], disk: "x", cuda: 1 },
      { gpus: [null, 7, { vendor: 1, vramTotalMb: "NaN" }], memory: { totalGb: -4, freeGb: "a" } },
    ];
    for (const hw of junk) {
      const facts = hwMod.hardwareFacts(hw, { gpuInfo: "bad", freeRamGb: "bad" });
      expect(facts.sources).toBeInstanceOf(Array);
      expect(["low", "mid", "high", null]).toContain(facts.cpuClass);
      expect(facts.ramGb === null || facts.ramGb > 0).toBe(true);
    }
  });

  it("CUDA needs the NVIDIA driver AND CUDA 12 or newer", () => {
    const base = { smiText: smi("Card", 8192) };
    expect(hwMod.hardwareFacts(machine({ ...base, smiPlain: smiHeader("12.0") })).cudaReady).toBe(
      true,
    );
    expect(hwMod.hardwareFacts(machine({ ...base, smiPlain: smiHeader("11.8") })).cudaReady).toBe(
      false,
    );
    expect(hwMod.hardwareFacts(machine({ ...base, smiPlain: smiHeader("13.1") })).cudaReady).toBe(
      true,
    );
    // No CUDA line: the driver version decides (R525+ ships CUDA 12), and an old driver is not ready.
    expect(
      hwMod.hardwareFacts(machine({ smiText: smi("Card", 8192, 1, "552.22") })).cudaReady,
    ).toBe(true);
    expect(
      hwMod.hardwareFacts(machine({ smiText: smi("Card", 8192, 1, "472.12") })).cudaReady,
    ).toBe(false);
    expect(
      hwMod.hardwareFacts(machine({ smiText: smi("Card", 8192, 1, "garbage") })).cudaReady,
    ).toBe(false);
  });

  it("a non-NVIDIA card is never CUDA even if the plain text claims it", () => {
    const hw = machine({
      video: [{ Name: "AMD Radeon RX 7900 XTX", AdapterRAM: 4293918720, Qw: 24 * GB }],
    });
    hw.cuda = { driverAvailable: false, driverCudaVersion: "12.6" };
    expect(hwMod.hardwareFacts(hw).cudaReady).toBe(false);
  });

  it("uses Electron gpuInfo when the other probes found nothing, and fills a missing driver", () => {
    const gpuInfo = {
      gpuDevice: [
        { active: true, vendorId: 0x10de, deviceId: 0x2684, driverVersion: "31.0.15.5222" },
        { vendorId: 0x8086, deviceId: 0x4680, driverVersion: "31.0.101" },
      ],
    };
    const facts = hwMod.hardwareFacts(machine({}), { gpuInfo });
    expect(facts.sources).toContain("electron-gpuInfo");
    expect(facts.gpus.map((g) => g.vendor).sort()).toEqual(["intel", "nvidia"]);
    expect(facts.vramGb).toBeNull();
    // gpuInfo cannot prove CUDA by itself.
    expect(facts.cudaReady).toBe(false);
    const withVideo = hwMod.hardwareFacts(
      machine({ video: [{ Name: "NVIDIA Card", AdapterRAM: 0 }] }),
      { gpuInfo },
    );
    expect(withVideo.gpus.filter((g) => g.vendor === "nvidia")).toHaveLength(1);
    expect(withVideo.driverVersion).toBe("31.0.15.5222");
  });

  it("classifies the CPU from physical cores, falling back to logical threads", () => {
    expect(hwMod.hardwareFacts(machine({ cores: 2, threads: 4 })).cpuClass).toBe("low");
    expect(hwMod.hardwareFacts(machine({ cores: 6, threads: 12 })).cpuClass).toBe("mid");
    expect(hwMod.hardwareFacts(machine({ cores: 16, threads: 32 })).cpuClass).toBe("high");
    const noPhysical = { ...machine({}), cpu: { cores: 16, threads: 16, physicalCores: null } };
    expect(hwMod.hardwareFacts(noPhysical).cpuClass).toBe("mid");
  });

  it("reads RAM, live free RAM override, and the model drive's free space", () => {
    const facts = hwMod.hardwareFacts(machine({ ramGb: 16, freeGb: 9, diskFreeGb: 120 }), {
      freeRamGb: 7.26,
    });
    expect(facts.ramGb).toBe(16);
    expect(facts.ramFreeGb).toBe(7.3);
    expect(facts.diskFreeGb).toBe(120);
    expect(hwMod.hardwareFacts(machine({ diskFreeGb: null })).diskFreeGb).toBeNull();
  });

  it("npu is a boolean, true only when a probe said so", () => {
    expect(hwMod.hardwareFacts(machine({})).npu).toBe(false);
    expect(hwMod.hardwareFacts({ ...machine({}), npu: true }).npu).toBe(true);
  });

  it("is pure: the input is not mutated and the same input gives the same answer", () => {
    const hw = machine({ smiText: smi("Card", 8192), smiPlain: smiHeader("12.4") });
    const before = JSON.stringify(hw);
    const a = hwMod.hardwareFacts(hw);
    const b = hwMod.hardwareFacts(hw);
    expect(JSON.stringify(hw)).toBe(before);
    expect(a).toEqual(b);
  });
});

describe("no source, no number", () => {
  it("with no probe, live free RAM alone is not a measurement and the CPU class is unknown", () => {
    for (const hw of [null, undefined, {}, "x"]) {
      const facts = hwMod.hardwareFacts(hw, { freeRamGb: 12 });
      expect(facts.ramGb).toBeNull();
      expect(facts.ramFreeGb).toBeNull();
      expect(facts.cpuClass).toBeNull();
      expect(facts.sources).toEqual([]);
    }
  });

  it("a probe without a CPU reading leaves cpuClass null, and one with cores still classifies it", () => {
    const noCpu = { ...machine({}), cpu: null };
    expect(hwMod.hardwareFacts(noCpu).cpuClass).toBeNull();
    expect(hwMod.hardwareFacts({ ...machine({}), cpu: { cores: 0 } }).cpuClass).toBeNull();
    expect(hwMod.hardwareFacts(machine({ cores: 2, threads: 4 })).cpuClass).toBe("low");
  });

  it("a probe with memory still lets the live free figure override the probed one", () => {
    const facts = hwMod.hardwareFacts(machine({ ramGb: 16, freeGb: 9 }), { freeRamGb: 3 });
    expect(facts.ramFreeGb).toBe(3);
  });
});

describe("gpus[].vramCapped marks a figure that only came from the capped 32-bit reading", () => {
  const rowOf = (hw: unknown) => hwMod.hardwareFacts(hw).gpus;

  it("is false for nvidia-smi and for a 64-bit driver figure, true for the capped AdapterRAM", () => {
    expect(rowOf(machine({ smiText: smi("Card", 8192) }))[0]?.vramCapped).toBe(false);
    expect(
      rowOf(
        machine({
          video: [{ Name: "AMD Radeon RX 7900 XTX", AdapterRAM: 4293918720, Qw: 24 * GB }],
        }),
      )[0],
    ).toMatchObject({ vramGb: 24, vramCapped: false });
    const capped = rowOf(
      machine({ video: [{ Name: "AMD Radeon RX 7800 XT", AdapterRAM: 4293918720 }] }),
    )[0];
    expect(capped).toMatchObject({ vramGb: null, vramCapped: true });
  });

  it("is true for a wrapped negative AdapterRAM and for an NVIDIA card seen only through WMI", () => {
    expect(
      rowOf(machine({ video: [{ Name: "AMD Radeon Pro W7900", AdapterRAM: -1 }] }))[0]?.vramCapped,
    ).toBe(true);
    expect(
      rowOf(machine({ video: [{ Name: "NVIDIA Card", AdapterRAM: 4293918720 }] }))[0],
    ).toMatchObject({ vendor: "nvidia", vramGb: null, vramCapped: true });
  });

  it("is false for a small honest 32-bit reading, for no memory figure and for Electron-only cards", () => {
    expect(
      rowOf(machine({ video: [{ Name: "Intel(R) UHD Graphics 770", AdapterRAM: 1073741824 }] }))[0],
    ).toMatchObject({ vramGb: 1, vramCapped: false });
    expect(rowOf(machine({ video: [{ Name: "Mystery Chip", AdapterRAM: 0 }] }))[0]).toMatchObject({
      vramGb: null,
      vramCapped: false,
    });
    const info = hwMod.hardwareFacts(machine({}), {
      gpuInfo: { gpuDevice: [{ vendorId: 0x1002, deviceId: 7, driverVersion: "31.0.1" }] },
    });
    expect(info.gpus[0]).toMatchObject({ vendor: "amd", vramGb: null, vramCapped: false });
  });

  it("every row carries the boolean, including on a hybrid laptop", () => {
    const rows = rowOf(
      machine({
        smiText: smi("Laptop dGPU", 8 * 1024, 300),
        video: [{ Name: "Intel(R) Iris Xe Graphics", AdapterRAM: 134217728 }],
      }),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(typeof row.vramCapped).toBe("boolean");
  });
});

describe("no GPU model names in the hardware facts or routing code", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const names = /\b(rtx|gtx|rx\s?\d|radeon|geforce|quadro|iris|uhd|arc\s?a\d|a100|h100|titan)\b/i;
  for (const file of ["electron/hardware.cjs", "electron/model-router.cjs"]) {
    it(`${file} has no branch on a GPU model name`, () => {
      const code = strip(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"));
      const hits = code
        .split("\n")
        .filter((line) => names.test(line))
        // The virtual-adapter filter and vendor test are patterns on adapter families, not model branches.
        .filter((line) => !/VIRTUAL_ADAPTER|vendorOf|amd\|radeon/i.test(line));
      expect(hits).toEqual([]);
    });
  }
});
