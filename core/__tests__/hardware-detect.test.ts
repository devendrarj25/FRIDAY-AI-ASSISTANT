import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const hw = require_("../../electron/hardware.cjs") as {
  buildPlan: (o: Record<string, unknown>) => {
    backend: string;
    reason: string;
    threads: number;
    maxRamGb: number;
    maxVramGb: number;
  };
  parseVideoControllers: (text: string) => Array<{
    vendor: string;
    name: string;
    vramTotalMb: number | null;
    vramKnown: boolean;
    driver: string | null;
  }>;
  parseLogicalDisks: (text: string) => Array<{
    letter: string;
    label: string;
    totalGb: number;
    freeGb: number;
    usedPercent: number;
  }>;
  parseCpuTopology: (text: string) => { physical: number; logical: number | null } | null;
  physicalCoresFromProcCpuinfo: (text: string) => number | null;
};
const { threadEnv } = require_("../../electron/system-health.cjs") as {
  threadEnv: (threads: unknown, env?: Record<string, string>) => Record<string, string>;
};

const GB = 1024 ** 3;

describe("graphics cards on Windows", () => {
  it("prefers the driver's 64-bit memory figure over the 32-bit AdapterRAM, which caps at 4 GB", () => {
    const [gpu] = hw.parseVideoControllers(
      JSON.stringify([
        { Name: "AMD Radeon RX 7900 XTX", AdapterRAM: 4293918720, Qw: 24 * GB, Driver: "31.0.1" },
      ]),
    );
    expect(gpu).toMatchObject({
      vendor: "amd",
      vramTotalMb: 24576,
      vramKnown: true,
      driver: "31.0.1",
    });
  });

  it("marks a 32-bit figure at the cap as 'at least', and unwraps a negative one", () => {
    const [capped] = hw.parseVideoControllers(
      JSON.stringify({ Name: "Intel(R) Arc(TM) A770", AdapterRAM: 4293918720 }),
    );
    expect(capped?.vramKnown).toBe(false);
    expect(capped?.vramTotalMb).toBe(4095);
    const [wrapped] = hw.parseVideoControllers(
      JSON.stringify({ Name: "Some Card", AdapterRAM: -1048576 }),
    );
    expect(wrapped?.vramTotalMb).toBe(4095);
    expect(wrapped?.vramKnown).toBe(false);
    const [small] = hw.parseVideoControllers(
      JSON.stringify({ Name: "Intel(R) UHD Graphics 620", AdapterRAM: 1073741824 }),
    );
    expect(small).toMatchObject({ vendor: "intel", vramTotalMb: 1024, vramKnown: true });
  });

  it("drops virtual and basic adapters, and accepts one object or a list", () => {
    const rows = hw.parseVideoControllers(
      JSON.stringify([
        { Name: "Microsoft Basic Display Adapter", AdapterRAM: 0 },
        { Name: "Parsec Virtual Display Adapter" },
        { Name: "NVIDIA GeForce RTX 4060 Laptop GPU", AdapterRAM: 4293918720, Qw: 8 * GB },
        { Name: "Intel(R) Iris(R) Xe Graphics", AdapterRAM: 1073741824 },
      ]),
    );
    expect(rows.map((r) => r.vendor)).toEqual(["nvidia", "intel"]);
    expect(hw.parseVideoControllers(JSON.stringify({ Name: "NVIDIA RTX A2000" }))).toHaveLength(1);
    expect(hw.parseVideoControllers("not json")).toEqual([]);
    expect(hw.parseVideoControllers("")).toEqual([]);
  });
});

describe("drives and CPU cores", () => {
  it("reads every fixed drive with its free space", () => {
    const drives = hw.parseLogicalDisks(
      JSON.stringify([
        {
          DeviceID: "C:",
          Size: 500 * GB,
          FreeSpace: 125 * GB,
          VolumeName: "System",
          FileSystem: "NTFS",
        },
        {
          DeviceID: "D:",
          Size: 2000 * GB,
          FreeSpace: 1900 * GB,
          VolumeName: "",
          FileSystem: "NTFS",
        },
        { DeviceID: "E:", Size: 0, FreeSpace: 0 },
      ]),
    );
    expect(drives).toHaveLength(2);
    expect(drives[0]).toMatchObject({
      letter: "C:",
      label: "System",
      totalGb: 500,
      freeGb: 125,
      usedPercent: 75,
    });
    expect(drives[1]?.usedPercent).toBe(5);
  });

  it("sums physical and logical cores over sockets, and says nothing when there are none", () => {
    expect(
      hw.parseCpuTopology(
        JSON.stringify([
          { NumberOfCores: 8, NumberOfLogicalProcessors: 16 },
          { NumberOfCores: 8, NumberOfLogicalProcessors: 16 },
        ]),
      ),
    ).toEqual({ physical: 16, logical: 32 });
    expect(
      hw.parseCpuTopology(JSON.stringify({ NumberOfCores: 6, NumberOfLogicalProcessors: 12 })),
    ).toEqual({
      physical: 6,
      logical: 12,
    });
    expect(hw.parseCpuTopology("[]")).toBeNull();
    expect(hw.parseCpuTopology("garbage")).toBeNull();
  });

  it("counts physical cores in /proc/cpuinfo, not hardware threads", () => {
    const block = (cpu: number, core: number) =>
      `processor\t: ${cpu}\nphysical id\t: 0\ncore id\t\t: ${core}\ncpu cores\t: 2\n`;
    const text = [block(0, 0), block(1, 1), block(2, 0), block(3, 1)].join("\n");
    expect(hw.physicalCoresFromProcCpuinfo(text)).toBe(2);
    expect(hw.physicalCoresFromProcCpuinfo("processor\t: 0\ncpu cores\t: 4\n")).toBe(4);
    expect(hw.physicalCoresFromProcCpuinfo("")).toBeNull();
  });
});

describe("the worker plan", () => {
  const base = { totalMemGb: 16, gpus: [], gpuAcceleration: false };

  it("uses physical cores, leaves one for the interface, and falls back to logical threads", () => {
    expect(hw.buildPlan({ ...base, cpuCount: 16, physicalCores: 8 }).threads).toBe(7);
    expect(hw.buildPlan({ ...base, cpuCount: 4, physicalCores: 2 }).threads).toBe(1);
    expect(hw.buildPlan({ ...base, cpuCount: 1, physicalCores: 1 }).threads).toBe(1);
    expect(hw.buildPlan({ ...base, cpuCount: 16, physicalCores: null }).threads).toBe(12);
    expect(hw.buildPlan({ ...base, cpuCount: 2 }).threads).toBe(1);
  });

  it("does not tell an AMD or Intel owner to install CUDA, and does not claim a GPU it cannot confirm", () => {
    const plan = hw.buildPlan({
      ...base,
      cpuCount: 8,
      physicalCores: 8,
      gpus: [{ vendor: "amd", name: "AMD Radeon RX 7900 XTX", vramTotalMb: 24576 }],
    });
    expect(plan.backend).toBe("cpu");
    expect(plan.reason).toContain("AMD Radeon RX 7900 XTX");
    expect(plan.reason).toContain("cannot confirm");
    expect(plan.reason).not.toContain("CUDA");
  });

  it("offloads to an NVIDIA card with real headroom only", () => {
    const nvidia = (vramTotalMb: number) => [{ vendor: "nvidia", name: "RTX", vramTotalMb }];
    expect(
      hw.buildPlan({
        ...base,
        cpuCount: 8,
        physicalCores: 8,
        gpus: nvidia(8192),
        gpuAcceleration: true,
      }),
    ).toMatchObject({ backend: "gpu", maxVramGb: 6.4 });
    expect(
      hw.buildPlan({
        ...base,
        cpuCount: 8,
        physicalCores: 8,
        gpus: nvidia(1024),
        gpuAcceleration: true,
      }).backend,
    ).toBe("cpu");
  });
});

describe("the plan reaches the libraries the kernel uses", () => {
  it("sets the four variables BLAS, ONNX Runtime and CTranslate2 read, and leaves the owner's own alone", () => {
    expect(threadEnv(7, {})).toEqual({
      OMP_NUM_THREADS: "7",
      OPENBLAS_NUM_THREADS: "7",
      MKL_NUM_THREADS: "7",
      NUMEXPR_NUM_THREADS: "7",
    });
    expect(threadEnv(7, { OMP_NUM_THREADS: "2" })).not.toHaveProperty("OMP_NUM_THREADS");
    expect(threadEnv(0, {})).toEqual({
      OMP_NUM_THREADS: "1",
      OPENBLAS_NUM_THREADS: "1",
      MKL_NUM_THREADS: "1",
      NUMEXPR_NUM_THREADS: "1",
    });
    expect(threadEnv("x", {})).toEqual({});
  });
});

describe("the main process uses what it detects", () => {
  const fsx = require_("node:fs");
  const main = fsx.readFileSync("electron/main.cjs", "utf8") as string;
  const doctor = fsx.readFileSync("electron/diagnostics.cjs", "utf8") as string;

  it("hands the plan to the kernel in the variables its libraries read, and waits for the probe first", () => {
    expect(main).toContain("...systemHealth.threadEnv(currentPlan().threads)");
    expect(main).toMatch(
      /if \(!lastHardware && hardwareBoot\) \{\s*await Promise\.race\(\[hardwareBoot,/,
    );
    expect(main).toContain("hardwareBoot = detectHardware({ root: getWorkspaceRoot() })");
  });

  it("shows every card, its memory and load, and every drive, in Setup & Doctor", () => {
    expect(doctor).toContain("at least ");
    expect(doctor).toContain("utilizationPercent");
    expect(doctor).toContain('id: "drives"');
    expect(doctor).toContain("hw.cpu.physicalCores");
    expect(doctor).toContain('hw.gpus[0].vendor !== "nvidia"');
  });
});
