import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
type Rec = Record<string, unknown>;
type Facts = {
  vramGb: number | null;
  vramFreeGb: number | null;
  gpuVendor: string | null;
  gpuName: string | null;
  driverVersion: string | null;
  npu: boolean;
  cpuClass: string | null;
  diskFreeGb: number | null;
  ramGb: number | null;
  ramFreeGb: number | null;
  gpus: Array<Rec>;
  cudaReady: boolean;
  vulkan: boolean | null;
  directxLevel: string | null;
  driverDate: string | null;
  integrated: boolean | null;
  multiGpu: boolean;
  os: Rec;
  cpu: Rec;
  memory: Rec;
  drives: Array<Rec>;
  dataRootDrive: string | null;
  modelCacheDrive: string | null;
  modelDrive: Rec | null;
  cuda: {
    driverCuda: string | null;
    cublas12: boolean | null;
    cudnn9: boolean | null;
    dllDirs: string[];
    runtimeFilesFound: boolean | null;
  };
  cudaRuntimeFilesFound: boolean | null;
  network: Rec;
  power: Rec;
  health: { level: string; reasons: string[] };
  sources: string[];
};
const hw = require_("../../electron/hardware.cjs") as {
  hardwareFacts: (hardware: unknown, deps?: Rec) => Facts;
  healthOf: (facts: unknown) => { level: string; reasons: string[] };
  detectCapabilities: (options?: Rec) => Promise<Rec | null>;
  detectHardware: (options?: Rec) => Promise<Rec>;
  createCapabilityCache: () => unknown;
  findCudaRuntimeFiles: (options: Rec) => Promise<Rec>;
  withDeadline: (work: unknown, ms: number, fallback?: unknown) => Promise<unknown>;
  parseOsInfo: (input: Rec) => Rec;
  parseWebView2: (value: unknown) => boolean | null;
  parseVcRuntime: (value: unknown) => boolean | null;
  parseCpuInfo: (cpu: unknown, arch?: string) => Rec;
  parseCpuFlagsFromCpuinfo: (text: string) => Rec;
  memoryPressure: (availableMb: unknown, totalMb: unknown) => string | null;
  parseMemoryCounters: (mem: unknown, pagefile?: unknown) => Rec;
  parseStorageMedia: (rows: unknown) => Array<Rec>;
  parseDriverDate: (value: unknown) => string | null;
  parseGpuExtras: (rows: unknown) => Array<Rec>;
  parsePower: (battery: unknown, plan: unknown, saver?: unknown) => Rec;
  driveOf: (target: unknown) => string | null;
  parseVideoControllers: (text: string) => Array<Rec>;
  parseNvidiaSmi: (text: string) => Array<Rec>;
  CAPABILITY_SCRIPTS: { STATIC_SCRIPT: string; dynamicScript: () => string };
};
const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------
// Realistic outputs of the two PowerShell groups (Windows PowerShell 5.1, ConvertTo-Json -Compress).
// ---------------------------------------------------------------------------------------------------------------
const NOW = 1_800_000_000_000;

const STATIC_IGPU_LAPTOP = JSON.stringify({
  os: {
    ProductName: "Windows 10 Home",
    DisplayVersion: "23H2",
    CurrentBuildNumber: "22631",
    UBR: 4037,
    EditionID: "Core",
  },
  webview2: ["119.0.2151.72"],
  vc: { installed: 1, version: "v14.38.33135" },
  cpu: {
    name: "12th Gen Intel(R) Core(TM) i5-1235U",
    cores: 10,
    logical: 12,
    maxMhz: 1300,
    feat: { avx: true, avx2: true, avx512: false, fma: null, src: "IsProcessorFeaturePresent" },
  },
  storage: [{ letter: "C:", media: "SSD", bus: "NVMe" }],
  vulkanIcds: 1,
  video: [{ name: "Intel(R) Iris(R) Xe Graphics", driverDate: "2023-09-12" }],
});
const DYNAMIC_LAPTOP_BATTERY = JSON.stringify({
  mem: { totalKb: 16482304, freeKb: 9123456, commitLimitKb: 21102592, commitFreeKb: 12000000 },
  pagefile: { count: 1, allocatedMb: 4608 },
  battery: { present: true, percent: 54, status: 1 },
  plan: { name: "Balanced", id: "Microsoft:PowerPlan\\{381b4222-f694-41f0-9685-ff5bb260df2e}" },
  saver: 1,
  net: { cost: 3, roaming: false, overLimit: false, iana: 71 },
});
const STATIC_NVIDIA_DESKTOP = JSON.stringify({
  os: {
    ProductName: "Windows 10 Pro",
    DisplayVersion: "22H2",
    CurrentBuildNumber: "19045",
    UBR: 5247,
    EditionID: "Professional",
  },
  webview2: ["130.0.2849.52", "130.0.2849.52"],
  vc: { installed: 1, version: "v14.40.33810" },
  cpu: {
    name: "AMD Ryzen 7 5800X 8-Core Processor",
    cores: 8,
    logical: 16,
    maxMhz: 3801,
    feat: { avx: true, avx2: true, avx512: false, fma: true, src: "intrinsics" },
  },
  storage: [
    { letter: "C:", media: "SSD", bus: "NVMe" },
    { letter: "D:", media: "HDD", bus: "SATA" },
  ],
  vulkanIcds: 1,
  video: [{ name: "NVIDIA GeForce RTX 2060", driverDate: "2024-05-14" }],
});
const DYNAMIC_DESKTOP = JSON.stringify({
  mem: { totalKb: 33445532, freeKb: 20000000, commitLimitKb: 38000000, commitFreeKb: 30000000 },
  pagefile: { count: 1, allocatedMb: 5120 },
  battery: { present: false, percent: null, status: null },
  plan: {
    name: "High performance",
    id: "Microsoft:PowerPlan\\{8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c}",
  },
  saver: 0,
  net: { cost: 1, roaming: false, overLimit: false, iana: 6 },
});

/** A fake PowerShell that answers each group by its script text, and counts the starts. */
function fakeShell(answers: {
  static?: string | Error | "hang" | undefined;
  dynamic?: string | Error | "hang" | undefined;
}) {
  const calls = { static: 0, dynamic: 0 };
  const run = (script: string) => {
    const group = script.includes("Win32_OperatingSystem") ? "dynamic" : "static";
    calls[group] += 1;
    const answer = answers[group];
    if (answer === "hang") return new Promise(() => undefined);
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === undefined)
      return Promise.resolve({ ok: false, stdout: null, error: "not answered" });
    return Promise.resolve({ ok: true, stdout: answer, error: null });
  };
  return { run, calls };
}

/** A fake file system: only the listed files exist; anything else is ENOENT. */
function fakeFs(files: string[], opts: { cpuinfo?: string; hang?: (p: string) => boolean } = {}) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  const stats: string[] = [];
  return {
    stats,
    stat: (target: string) => {
      stats.push(target);
      if (opts.hang?.(target)) return new Promise(() => undefined);
      return set.has(target.toLowerCase())
        ? Promise.resolve({ isFile: () => true })
        : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    },
    readdir: () => Promise.resolve([] as string[]),
    readFile: () =>
      opts.cpuinfo !== undefined
        ? Promise.resolve(opts.cpuinfo)
        : Promise.reject(new Error("ENOENT")),
  };
}

const WIN_ENV = {
  SystemRoot: "C:\\Windows",
  PATH: "C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs",
};
const fakeOs = (release: string, arch = "x64") => ({ release: () => release, arch: () => arch });

function winOptions(
  shell: ReturnType<typeof fakeShell>,
  fsApi: ReturnType<typeof fakeFs>,
  extra: Rec = {},
) {
  return {
    platform: "win32",
    os: fakeOs("10.0.22631"),
    env: WIN_ENV,
    fsApi,
    runPowerShell: shell.run,
    now: () => NOW,
    root: "D:\\FRIDAY",
    cache: hw.createCapabilityCache(),
    ...extra,
  };
}

/** The hardware object detectHardware returns, for a machine described by its parts. */
function hardwareObject(parts: {
  gpus?: Array<Rec>;
  ramGb?: number;
  freeGb?: number;
  capabilities?: Rec | null;
  cuda?: Rec;
  drives?: Array<Rec>;
}) {
  return {
    platform: "win32 10.0.22631",
    arch: "x64",
    cpu: { model: "Test CPU", cores: 12, threads: 12, physicalCores: 6 },
    memory: { totalGb: parts.ramGb ?? 16, freeGb: parts.freeGb ?? 9 },
    disk: { freeGb: 300, totalGb: 900 },
    drives: parts.drives ?? [
      { letter: "C:", totalGb: 476, freeGb: 120, holdsFridayFolder: false },
      { letter: "D:", totalGb: 931, freeGb: 300, holdsFridayFolder: true },
    ],
    gpus: parts.gpus ?? [],
    cuda: parts.cuda ?? { driverAvailable: false, driverCudaVersion: null },
    capabilities: parts.capabilities ?? null,
  };
}

const NVIDIA_SMI = "NVIDIA GeForce RTX 2060, 6144, 800, 556.12, 3, 41";
const SMI_HEADER = "| NVIDIA-SMI 556.12   Driver Version: 556.12   CUDA Version: 12.5     |";

// ---------------------------------------------------------------------------------------------------------------

describe("1. Windows build, 64-bit, WebView2 and the C++ runtime", () => {
  it("reads Windows 11 from build 22631 even though the registry still says Windows 10", () => {
    const os_ = hw.parseOsInfo({
      platform: "win32",
      release: "10.0.22631",
      arch: "x64",
      registry: {
        ProductName: "Windows 10 Home",
        DisplayVersion: "23H2",
        CurrentBuildNumber: "22631",
        UBR: 4037,
        EditionID: "Core",
      },
    });
    expect(os_).toMatchObject({
      ntVersion: "10.0.22631",
      build: 22631,
      ubr: 4037,
      buildFull: "22631.4037",
      name: "Windows 11 Home",
      displayVersion: "23H2",
      windows11: true,
      is64Bit: true,
    });
  });

  it("reads Windows 10 22H2, and a 32-bit process on a 64-bit Windows is still a 64-bit OS", () => {
    const ten = hw.parseOsInfo({
      platform: "win32",
      release: "10.0.19045",
      arch: "x64",
      registry: { ProductName: "Windows 10 Pro", CurrentBuildNumber: "19045" },
    });
    expect(ten).toMatchObject({ build: 19045, windows11: false, name: "Windows 10 Pro" });
    expect(
      hw.parseOsInfo({
        platform: "win32",
        release: "10.0.19045",
        arch: "ia32",
        env: { PROCESSOR_ARCHITEW6432: "AMD64" },
      })["is64Bit"],
    ).toBe(true);
    expect(
      hw.parseOsInfo({ platform: "win32", release: "10.0.19045", arch: "ia32", env: {} })[
        "is64Bit"
      ],
    ).toBe(false);
    expect(
      hw.parseOsInfo({ platform: "win32", release: "10.0.26100", arch: "arm64" }),
    ).toMatchObject({ is64Bit: true, windows11: true, name: "Windows 11" });
  });

  it("measures nothing about a Windows build on another platform or from garbage", () => {
    expect(
      hw.parseOsInfo({ platform: "linux", release: "6.8.0-45-generic", arch: "x64" }),
    ).toMatchObject({ build: null, windows11: null, ntVersion: null, name: null });
    expect(
      hw.parseOsInfo({ platform: "win32", release: "", arch: "", registry: "oops" }),
    ).toMatchObject({ build: null, windows11: null, is64Bit: null });
    expect(
      hw.parseOsInfo({
        platform: "win32",
        release: "10.0.22631",
        arch: "x64",
        registry: { CurrentBuildNumber: "NaN", UBR: "x" },
      }),
    ).toMatchObject({ build: 22631, ubr: null });
  });

  it("WebView2 is present only for a real version, absent for none or 0.0.0.0, unknown when not read", () => {
    expect(hw.parseWebView2(["119.0.2151.72"])).toBe(true);
    expect(hw.parseWebView2("119.0.2151.72")).toBe(true);
    expect(hw.parseWebView2([])).toBe(false);
    expect(hw.parseWebView2(["0.0.0.0"])).toBe(false);
    expect(hw.parseWebView2(["", "0.0.0.0", "130.0.1"])).toBe(true);
    expect(hw.parseWebView2(undefined)).toBeNull();
    expect(hw.parseWebView2(42)).toBeNull();
  });

  it("the Visual C++ x64 runtime is Installed=1, and missing is false only when the registry was read", () => {
    expect(hw.parseVcRuntime({ installed: 1, version: "v14.38.33135" })).toBe(true);
    expect(hw.parseVcRuntime({ installed: 0, version: "" })).toBe(false);
    expect(hw.parseVcRuntime({ Installed: 1 })).toBe(true);
    expect(hw.parseVcRuntime(undefined)).toBeNull();
    expect(hw.parseVcRuntime({ installed: "x" })).toBeNull();
  });
});

describe("2. CPU model, cores, clock and instruction sets", () => {
  it("passes through the flags the processor-feature call measured and leaves FMA null when no source says", () => {
    const cpu = hw.parseCpuInfo(
      {
        name: "12th Gen Intel(R) Core(TM) i5-1235U",
        cores: 10,
        logical: 12,
        maxMhz: 1300,
        feat: { avx: true, avx2: true, avx512: false, fma: null, src: "IsProcessorFeaturePresent" },
      },
      "x64",
    );
    expect(cpu).toEqual({
      model: "12th Gen Intel(R) Core(TM) i5-1235U",
      physicalCores: 10,
      logicalCores: 12,
      baseClockMhz: 1300,
      avx: true,
      avx2: true,
      avx512: false,
      fma: null,
      flagsSource: "IsProcessorFeaturePresent",
    });
  });

  it("an Arm PC has no x86 flags to report: null, not false", () => {
    const cpu = hw.parseCpuInfo(
      {
        name: "Snapdragon X Elite",
        cores: 12,
        logical: 12,
        feat: { avx: false, avx2: false, avx512: false, fma: false, src: "x" },
      },
      "arm64",
    );
    expect(cpu).toMatchObject({
      avx: null,
      avx2: null,
      avx512: null,
      fma: null,
      flagsSource: null,
      physicalCores: 12,
    });
  });

  it("reads the flags line of /proc/cpuinfo (AVX2 and FMA, no AVX-512) and says nothing without one", () => {
    const text =
      "processor\t: 0\nmodel name\t: Intel(R) Core(TM) i7\nflags\t\t: fpu vme sse sse2 ssse3 fma avx avx2 bmi2\n";
    expect(hw.parseCpuFlagsFromCpuinfo(text)).toEqual({
      avx: true,
      avx2: true,
      avx512: false,
      fma: true,
      source: "cpuinfo",
    });
    expect(hw.parseCpuFlagsFromCpuinfo("flags\t: avx512f avx512bw avx avx2 fma")["avx512"]).toBe(
      true,
    );
    expect(hw.parseCpuFlagsFromCpuinfo("")).toEqual({
      avx: null,
      avx2: null,
      avx512: null,
      fma: null,
      source: null,
    });
    expect(hw.parseCpuFlagsFromCpuinfo(undefined as unknown as string)["avx"]).toBeNull();
  });

  it("garbage in the cpu section leaves every field null", () => {
    expect(hw.parseCpuInfo("nope", "x64")).toMatchObject({
      model: null,
      physicalCores: null,
      baseClockMhz: null,
      avx2: null,
    });
    expect(
      hw.parseCpuInfo({ name: "", cores: -4, logical: "many", maxMhz: 0, feat: [1] }, "x64"),
    ).toMatchObject({
      model: null,
      physicalCores: null,
      logicalCores: null,
      baseClockMhz: null,
      avx: null,
    });
  });
});

describe("3. memory pressure, commit, drives and disk type", () => {
  it("draws the same lines as kernel/stt.py memory_pressure", () => {
    const stt = read("kernel/stt.py");
    expect(stt).toContain("PRESSURE_HIGH = (0.15, 2048, 3072)");
    expect(stt).toContain("PRESSURE_CRITICAL = (0.07, 1024, 1536)");
    // 4 GB PC: lines at 2048 and 1024 MB; 16 GB: high under 2457 MB, critical under 1146 MB; 64 GB: capped at 3072 and 1536.
    expect(hw.memoryPressure(2100, 4096)).toBe("ok");
    expect(hw.memoryPressure(2047, 4096)).toBe("high");
    expect(hw.memoryPressure(1023, 4096)).toBe("critical");
    expect(hw.memoryPressure(2500, 16384)).toBe("ok");
    expect(hw.memoryPressure(2400, 16384)).toBe("high");
    expect(hw.memoryPressure(1100, 16384)).toBe("critical");
    expect(hw.memoryPressure(3100, 65536)).toBe("ok");
    expect(hw.memoryPressure(3000, 65536)).toBe("high");
    expect(hw.memoryPressure(1500, 65536)).toBe("critical");
  });

  it("is not measured (null) for impossible or missing readings", () => {
    expect(hw.memoryPressure(null, 4096)).toBeNull();
    expect(hw.memoryPressure(NaN, 4096)).toBeNull();
    expect(hw.memoryPressure(100, 0)).toBeNull();
    expect(hw.memoryPressure(-5, 4096)).toBeNull();
    expect(hw.memoryPressure(99999, 4096)).toBeNull();
  });

  it("reads the commit limit and page file from Win32_OperatingSystem kilobytes", () => {
    const m = hw.parseMemoryCounters(
      { totalKb: 16482304, freeKb: 9123456, commitLimitKb: 21102592, commitFreeKb: 12000000 },
      { count: 1, allocatedMb: 4608 },
    );
    expect(m).toMatchObject({
      totalGb: 15.7,
      commitLimitGb: 20.1,
      commitFreeGb: 11.4,
      commitPressure: "ok",
      pagefileGb: 4.5,
      pagefileCount: 1,
    });
    const tight = hw.parseMemoryCounters({
      totalKb: 4194304,
      freeKb: 900000,
      commitLimitKb: 6291456,
      commitFreeKb: 700000,
    });
    expect(tight["commitPressure"]).toBe("critical");
    expect(hw.parseMemoryCounters(undefined)).toMatchObject({
      totalGb: null,
      commitPressure: null,
      pagefileGb: null,
    });
  });

  it("maps Get-PhysicalDisk media and bus (names or numbers) and drops what does not say", () => {
    const rows = hw.parseStorageMedia([
      { letter: "c:", media: "SSD", bus: "NVMe" },
      { letter: "D:", media: "HDD", bus: "SATA" },
      { letter: "E:", media: "Unspecified", bus: "USB" },
      { letter: "F:", media: 4, bus: 17 },
      { letter: "", media: "SSD" },
      "junk",
      null,
    ]);
    expect(rows).toEqual([
      { letter: "C:", media: "ssd", bus: "nvme" },
      { letter: "D:", media: "hdd", bus: "sata" },
      { letter: "E:", media: null, bus: "usb" },
      { letter: "F:", media: "ssd", bus: "nvme" },
    ]);
    expect(hw.parseStorageMedia("nope")).toEqual([]);
  });

  it("names the drive of a path, and none for relative, UNC or non-Windows paths", () => {
    expect(hw.driveOf("d:\\FRIDAY\\models")).toBe("D:");
    expect(hw.driveOf("C:/Users/x")).toBe("C:");
    expect(hw.driveOf("\\\\server\\share\\FRIDAY")).toBeNull();
    expect(hw.driveOf("/home/user/FRIDAY")).toBeNull();
    expect(hw.driveOf("FRIDAY")).toBeNull();
    expect(hw.driveOf(null)).toBeNull();
  });
});

describe("4. GPU extras: driver date, Vulkan and the CUDA files", () => {
  it("parses a driver date from ISO, WMI and JSON /Date()/ forms and rejects junk", () => {
    expect(hw.parseDriverDate("2023-09-12")).toBe("2023-09-12");
    expect(hw.parseDriverDate("20230912000000.000000-000")).toBe("2023-09-12");
    expect(hw.parseDriverDate("/Date(1694476800000)/")).toBe("2023-09-12");
    expect(hw.parseDriverDate("2023-09-12T00:00:00")).toBe("2023-09-12");
    expect(hw.parseDriverDate("not a date")).toBeNull();
    expect(hw.parseDriverDate("1970-01-01")).toBeNull();
    expect(hw.parseDriverDate(null)).toBeNull();
    expect(hw.parseGpuExtras([{ name: "A", driverDate: "2024-05-14" }, { name: "" }, 3])).toEqual([
      { name: "A", driverDate: "2024-05-14" },
    ]);
  });

  it("finds the two CUDA 12 files in the FRIDAY venv packages without loading them", async () => {
    const fsApi = fakeFs([
      "D:\\FRIDAY\\runtime\\.venv\\Lib\\site-packages\\nvidia\\cublas\\bin\\cublas64_12.dll",
      "D:\\FRIDAY\\runtime\\.venv\\Lib\\site-packages\\nvidia\\cudnn\\bin\\cudnn64_9.dll",
    ]);
    const found = await hw.findCudaRuntimeFiles({
      platform: "win32",
      env: WIN_ENV,
      venvRoots: ["D:\\FRIDAY\\runtime\\.venv"],
      fsApi,
    });
    expect(found).toMatchObject({ cublas12: true, cudnn9: true, runtimeFilesFound: true });
    expect(found["dllDirs"]).toEqual([
      "D:\\FRIDAY\\runtime\\.venv\\Lib\\site-packages\\nvidia\\cublas\\bin",
      "D:\\FRIDAY\\runtime\\.venv\\Lib\\site-packages\\nvidia\\cudnn\\bin",
    ]);
    // Only stat: it never reads, opens or loads a DLL.
    expect(fsApi.stats.every((p) => /\.dll$/i.test(p))).toBe(true);
  });

  it("cuBLAS without cuDNN is half a runtime: runtimeFilesFound false; CUDA_PATH, PATH and System32 are searched", async () => {
    const fsApi = fakeFs([
      "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.4\\bin\\cublas64_12.dll",
    ]);
    const found = await hw.findCudaRuntimeFiles({
      platform: "win32",
      env: {
        ...WIN_ENV,
        CUDA_PATH: "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.4",
      },
      fsApi,
    });
    expect(found).toMatchObject({ cublas12: true, cudnn9: false, runtimeFilesFound: false });
    const searched = fsApi.stats.map((p) => p.toLowerCase());
    expect(searched).toContain("c:\\windows\\system32\\cudnn64_9.dll");
    expect(searched).toContain("c:\\program files\\nodejs\\cublas64_12.dll");
    expect(searched).toContain(
      "c:\\program files\\nvidia gpu computing toolkit\\cuda\\v12.4\\bin\\cublas64_12.dll",
    );
  });

  it("nothing found is false (searched), and a stat that never answers cannot stall the answer", async () => {
    const none = await hw.findCudaRuntimeFiles({
      platform: "win32",
      env: WIN_ENV,
      fsApi: fakeFs([]),
    });
    expect(none).toMatchObject({
      cublas12: false,
      cudnn9: false,
      runtimeFilesFound: false,
      dllDirs: [],
    });
    vi.useFakeTimers();
    const hung = fakeFs([], { hang: () => true });
    const job = hw.findCudaRuntimeFiles({
      platform: "win32",
      env: WIN_ENV,
      fsApi: hung,
      totalMs: 6000,
    });
    await vi.advanceTimersByTimeAsync(2000);
    // Each stat gave up after 1.5 s: the search ends with "not found", it does not wait forever.
    expect(await job).toMatchObject({ cublas12: false, cudnn9: false });
    vi.useFakeTimers();
    const wholly = hw.findCudaRuntimeFiles({
      platform: "win32",
      env: WIN_ENV,
      fsApi: fakeFs([], { hang: () => true }),
      totalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(150);
    // The whole search gave up: not measured (null), which is not the same as "searched and found nothing".
    expect(await wholly).toMatchObject({ cublas12: null, cudnn9: null, runtimeFilesFound: null });
  });

  it("looks for the same files, in the same places, as the kernel's cuda_runtime_ready", () => {
    const stt = read("kernel/stt.py");
    expect(stt).toContain('("cublas64_12.dll", "cudnn64_9.dll")');
    expect(stt).toContain('("PATH", "LD_LIBRARY_PATH")');
    expect(stt).toContain('Path(cuda) / "bin"');
    expect(stt).toContain('("nvidia.cublas", "nvidia.cudnn")');
    const ours = read("electron/hardware.cjs");
    expect(ours).toContain('cublas: "cublas64_12.dll"');
    expect(ours).toContain('cudnn: "cudnn64_9.dll"');
    expect(ours).toMatch(/for \(const key of \["PATH", "LD_LIBRARY_PATH"\]\)/);
    expect(ours).toMatch(/\["cublas", "cudnn"\]/);
  });
});

describe("6. power: battery, plan, battery saver", () => {
  it("a laptop on its battery: 54 percent, balanced plan, saver off", () => {
    expect(
      hw.parsePower(
        { present: true, percent: 54, status: 1 },
        { name: "Balanced", id: "Microsoft:PowerPlan\\{381b4222-f694-41f0-9685-ff5bb260df2e}" },
        1,
      ),
    ).toEqual({
      batteryPresent: true,
      batteryPercent: 54,
      onAc: false,
      planName: "Balanced",
      planKind: "balanced",
      batterySaver: false,
      thermal: null,
    });
  });

  it("charging is on mains; no battery means a mains PC; an odd status is not guessed", () => {
    expect(hw.parsePower({ present: true, percent: 80, status: 6 }, null, 2)).toMatchObject({
      onAc: true,
      batterySaver: true,
    });
    expect(
      hw.parsePower(
        { present: false },
        { name: "Hochleistung", id: "Microsoft:PowerPlan\\{8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C}" },
        0,
      ),
    ).toMatchObject({
      batteryPresent: false,
      onAc: true,
      batteryPercent: null,
      planKind: "high-performance",
      planName: "Hochleistung",
    });
    expect(hw.parsePower({ present: true, percent: 50, status: 10 }, null, 7)).toMatchObject({
      onAc: null,
      batterySaver: null,
    });
    expect(hw.parsePower(undefined, undefined, undefined)).toMatchObject({
      batteryPresent: null,
      onAc: null,
      planKind: null,
      batterySaver: null,
    });
    expect(hw.parsePower({ present: true, percent: 400, status: 1 }, null)).toMatchObject({
      batteryPercent: null,
    });
  });
});

describe("detectCapabilities with fake probes", () => {
  it("an integrated-graphics laptop on battery, metered Wi-Fi: every fact read, health tight", async () => {
    const shell = fakeShell({ static: STATIC_IGPU_LAPTOP, dynamic: DYNAMIC_LAPTOP_BATTERY });
    const fsApi = fakeFs(["C:\\Windows\\System32\\vulkan-1.dll"]);
    const caps = await hw.detectCapabilities(winOptions(shell, fsApi, { root: "C:\\FRIDAY" }));
    const facts = hw.hardwareFacts(
      hardwareObject({
        gpus: hw.parseVideoControllers(
          JSON.stringify([
            {
              Name: "Intel(R) Iris(R) Xe Graphics",
              AdapterRAM: 1073741824,
              Qw: 134217728,
              Driver: "31.0.101.4502",
            },
          ]),
        ),
        capabilities: caps,
        drives: [{ letter: "C:", totalGb: 476, freeGb: 120, holdsFridayFolder: true }],
      }),
      { freeRamGb: 9 },
    );
    expect(facts.os).toMatchObject({
      windows11: true,
      build: 22631,
      is64Bit: true,
      webview2: true,
      vcRuntimeX64: true,
    });
    expect(facts.cpu).toMatchObject({
      physicalCores: 6,
      logicalCores: 12,
      baseClockMhz: 1300,
      avx2: true,
      avx512: false,
      fma: null,
    });
    expect(facts.memory).toMatchObject({ pressure: "ok", commitPressure: "ok", pagefileGb: 4.5 });
    expect(facts.drives).toEqual([
      {
        letter: "C:",
        totalGb: 476,
        freeGb: 120,
        media: "ssd",
        bus: "nvme",
        holdsDataRoot: true,
        holdsModelCache: true,
      },
    ]);
    expect(facts.dataRootDrive).toBe("C:");
    expect(facts.vulkan).toBe(true);
    expect(facts.integrated).toBe(true);
    expect(facts.driverDate).toBe("2023-09-12");
    expect(facts.multiGpu).toBe(false);
    expect(facts.cudaReady).toBe(false);
    expect(facts.network).toMatchObject({
      type: "wifi",
      metered: true,
      roaming: false,
      latencyMs: null,
    });
    expect(facts.power).toMatchObject({
      batteryPresent: true,
      batteryPercent: 54,
      onAc: false,
      planKind: "balanced",
      batterySaver: false,
      thermal: null,
    });
    expect(facts.health.level).toBe("tight");
    expect(facts.health.reasons).toEqual(expect.arrayContaining(["on-battery", "metered-network"]));
    expect(facts.sources).toContain("capability-probe");
  });

  it("an NVIDIA desktop with cuBLAS but no cuDNN: CUDA files half there, the driver verdict untouched", async () => {
    const shell = fakeShell({ static: STATIC_NVIDIA_DESKTOP, dynamic: DYNAMIC_DESKTOP });
    const fsApi = fakeFs([
      "C:\\Windows\\System32\\vulkan-1.dll",
      "D:\\FRIDAY\\runtime\\.venv\\Lib\\site-packages\\nvidia\\cublas\\bin\\cublas64_12.dll",
    ]);
    const caps = await hw.detectCapabilities(
      winOptions(shell, fsApi, { os: fakeOs("10.0.19045") }),
    );
    const smi = hw.parseNvidiaSmi(NVIDIA_SMI);
    const facts = hw.hardwareFacts(
      hardwareObject({
        gpus: smi,
        ramGb: 32,
        freeGb: 20,
        capabilities: caps,
        cuda: {
          driverAvailable: true,
          driverCudaVersion: SMI_HEADER.match(/CUDA Version: ([\d.]+)/)?.[1] ?? null,
        },
      }),
      { freeRamGb: 20 },
    );
    expect(facts.cudaReady).toBe(true);
    expect(facts.cuda).toEqual({
      driverCuda: "12.5",
      cublas12: true,
      cudnn9: false,
      dllDirs: ["D:\\FRIDAY\\runtime\\.venv\\Lib\\site-packages\\nvidia\\cublas\\bin"],
      runtimeFilesFound: false,
    });
    expect(facts.cudaRuntimeFilesFound).toBe(false);
    expect(facts.integrated).toBe(false);
    expect(facts.power).toMatchObject({
      batteryPresent: false,
      onAc: true,
      planKind: "high-performance",
      batterySaver: false,
    });
    expect(facts.network).toMatchObject({ type: "ethernet", metered: false });
    expect(facts.drives.map((d) => [d["letter"], d["media"], d["holdsDataRoot"]])).toEqual([
      ["C:", "ssd", false],
      ["D:", "hdd", true],
    ]);
    expect(facts.modelDrive).toEqual({ letter: "D:", freeGb: 300, media: "hdd" });
    expect(facts.health).toEqual({ level: "ok", reasons: [] });
  });

  it("a PC with no GPU and no Vulkan loader: nothing invented, and the others still report", async () => {
    const shell = fakeShell({
      static: STATIC_IGPU_LAPTOP.replace('"vulkanIcds":1', '"vulkanIcds":0'),
      dynamic: DYNAMIC_DESKTOP,
    });
    const caps = await hw.detectCapabilities(winOptions(shell, fakeFs([])));
    const facts = hw.hardwareFacts(hardwareObject({ gpus: [], capabilities: caps }));
    expect(facts.gpus).toEqual([]);
    expect(facts.vulkan).toBe(false);
    expect(facts.integrated).toBeNull();
    expect(facts.driverDate).toBeNull();
    expect(facts.multiGpu).toBe(false);
    expect(facts.cuda.cublas12).toBe(false);
  });

  it("a Vulkan loader with no installed driver is not Vulkan; with the driver list unreadable it is the loader's word", async () => {
    const files = ["C:\\Windows\\System32\\vulkan-1.dll"];
    const noIcd = await hw.detectCapabilities(
      winOptions(
        fakeShell({
          static: STATIC_IGPU_LAPTOP.replace('"vulkanIcds":1', '"vulkanIcds":0'),
          dynamic: DYNAMIC_DESKTOP,
        }),
        fakeFs(files),
      ),
    );
    expect(hw.hardwareFacts(hardwareObject({ capabilities: noIcd })).vulkan).toBe(false);
    const unknown = await hw.detectCapabilities(
      winOptions(
        fakeShell({
          static: STATIC_IGPU_LAPTOP.replace(',"vulkanIcds":1', ""),
          dynamic: DYNAMIC_DESKTOP,
        }),
        fakeFs(files),
      ),
    );
    expect(hw.hardwareFacts(hardwareObject({ capabilities: unknown })).vulkan).toBe(true);
    const absent = await hw.detectCapabilities(
      winOptions(fakeShell({ static: STATIC_IGPU_LAPTOP, dynamic: DYNAMIC_DESKTOP }), fakeFs([])),
    );
    expect(hw.hardwareFacts(hardwareObject({ capabilities: absent })).vulkan).toBe(false);
  });

  it("a 4 GB PC is critical: RAM pressure from the live free memory, small-RAM reason, no crash", async () => {
    const dynamic = JSON.stringify({
      mem: { totalKb: 4062000, freeKb: 700000, commitLimitKb: 5600000, commitFreeKb: 900000 },
      pagefile: { count: 1, allocatedMb: 1536 },
      battery: { present: false },
      net: { none: true },
    });
    const caps = await hw.detectCapabilities(
      winOptions(fakeShell({ static: STATIC_IGPU_LAPTOP, dynamic }), fakeFs([])),
    );
    const facts = hw.hardwareFacts(hardwareObject({ ramGb: 4, freeGb: 1.5, capabilities: caps }), {
      freeRamGb: 0.7,
    });
    expect(facts.memory["pressure"]).toBe("critical");
    expect(facts.health.level).toBe("critical");
    expect(facts.health.reasons).toEqual(expect.arrayContaining(["ram-critical", "ram-small"]));
    expect(facts.network).toMatchObject({ type: null, metered: null });
    // Without a live reading the stored free memory decides: 1.5 GB free of 4 is high pressure, not critical.
    expect(
      hw.hardwareFacts(hardwareObject({ ramGb: 4, freeGb: 1.5, capabilities: caps })).memory[
        "pressure"
      ],
    ).toBe("high");
  });

  it("corrupted outputs leave every fact null and never throw", async () => {
    const garbage = [
      "",
      "not json at all",
      "Get-CimInstance : Access denied\nAt line:1 char:1",
      '{"os": {"ProductName": ',
      "[1,2,3]",
      "null",
      '{"os":"x","cpu":7,"mem":"big","storage":"C","video":9,"battery":3,"plan":[],"net":"wifi","saver":"on"}',
      "\uFEFF{broken",
    ];
    for (const text of garbage) {
      const shell = fakeShell({ static: text, dynamic: text });
      const caps = await hw.detectCapabilities(winOptions(shell, fakeFs([])));
      const facts = hw.hardwareFacts(hardwareObject({ capabilities: caps }));
      // The build still comes from the OS itself (os.release); only what the registry would add is missing.
      expect(facts.os).toMatchObject({
        build: 22631,
        ubr: null,
        displayVersion: null,
        webview2: null,
        vcRuntimeX64: null,
      });
      expect(facts.cpu).toMatchObject({ avx: null, avx2: null, baseClockMhz: null });
      expect(facts.memory).toMatchObject({ commitPressure: null, pagefileGb: null });
      expect(facts.power).toMatchObject({
        batteryPresent: null,
        batteryPercent: null,
        onAc: null,
        batterySaver: null,
      });
      expect(facts.network).toMatchObject({ type: null, metered: null });
      expect(facts.drives.every((d) => d["media"] === null)).toBe(true);
    }
  });

  it("a shell that fails, throws or rejects is a reason, not a crash", async () => {
    for (const answer of [new Error("spawn powershell ENOENT"), undefined]) {
      const shell = fakeShell({ static: answer, dynamic: answer });
      const caps = await hw.detectCapabilities(winOptions(shell, fakeFs([])));
      expect(caps).not.toBeNull();
      expect((caps as { probes: Rec }).probes["static"]).toEqual(expect.any(String));
      expect(hw.hardwareFacts(hardwareObject({ capabilities: caps })).health).toEqual({
        level: "ok",
        reasons: [],
      });
    }
    const syncThrow = await hw.detectCapabilities(
      winOptions(fakeShell({}), fakeFs([]), {
        runPowerShell: () => {
          throw new Error("boom");
        },
      }),
    );
    expect((syncThrow as { probes: Rec }).probes["dynamic"]).toBe("boom");
  });

  it("a shell that never answers times out: the answer arrives, with the reason, and no timer outlives it", async () => {
    vi.useFakeTimers();
    const shell = fakeShell({ static: "hang", dynamic: "hang" });
    const job = hw.detectCapabilities(
      winOptions(shell, fakeFs(["C:\\Windows\\System32\\vulkan-1.dll"])),
    );
    await vi.advanceTimersByTimeAsync(24_000);
    const caps = (await job) as { probes: Rec; vulkan: Rec; cuda: Rec };
    expect(caps.probes["static"]).toMatch(/in time/);
    expect(caps.probes["dynamic"]).toMatch(/in time/);
    expect(caps.vulkan["loaderPresent"]).toBe(true);
    expect(caps.cuda["cublas12"]).toBe(false);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  });

  it("is cheap to call again: static facts are kept 10 minutes, the rest 20 seconds, and callers share one run", async () => {
    let clock = NOW;
    const shell = fakeShell({ static: STATIC_IGPU_LAPTOP, dynamic: DYNAMIC_LAPTOP_BATTERY });
    const options = winOptions(shell, fakeFs([]), { now: () => clock });
    await Promise.all([
      hw.detectCapabilities(options),
      hw.detectCapabilities(options),
      hw.detectCapabilities(options),
    ]);
    expect(shell.calls).toEqual({ static: 1, dynamic: 1 });
    clock += 10_000;
    await hw.detectCapabilities(options);
    expect(shell.calls).toEqual({ static: 1, dynamic: 1 });
    clock += 15_000;
    await hw.detectCapabilities(options);
    expect(shell.calls).toEqual({ static: 1, dynamic: 2 });
    clock += 11 * 60_000;
    await hw.detectCapabilities(options);
    expect(shell.calls).toEqual({ static: 2, dynamic: 3 });
  });

  it("a failed group is retried after a minute at most, not on every call", async () => {
    let clock = NOW;
    const shell = fakeShell({ static: undefined, dynamic: undefined });
    const options = winOptions(shell, fakeFs([]), { now: () => clock });
    await hw.detectCapabilities(options);
    await hw.detectCapabilities(options);
    expect(shell.calls).toEqual({ static: 1, dynamic: 1 });
    clock += 61_000;
    await hw.detectCapabilities(options);
    expect(shell.calls).toEqual({ static: 2, dynamic: 2 });
  });

  it("starts no PowerShell off Windows and reads the CPU flags from /proc/cpuinfo", async () => {
    const shell = fakeShell({ static: STATIC_IGPU_LAPTOP, dynamic: DYNAMIC_LAPTOP_BATTERY });
    const fsApi = fakeFs([], { cpuinfo: "model name\t: Test\nflags\t\t: fpu sse2 avx avx2 fma\n" });
    const caps = (await hw.detectCapabilities({
      platform: "linux",
      os: fakeOs("6.8.0-45-generic"),
      env: { PATH: "/usr/bin" },
      fsApi,
      runPowerShell: shell.run,
      now: () => NOW,
      root: "/home/me/FRIDAY",
      cache: hw.createCapabilityCache(),
    })) as { os: Rec; cpu: Rec; vulkan: Rec; power: Rec; network: Rec };
    expect(shell.calls).toEqual({ static: 0, dynamic: 0 });
    expect(caps.cpu).toMatchObject({
      avx: true,
      avx2: true,
      avx512: false,
      fma: true,
      flagsSource: "cpuinfo",
    });
    expect(caps.os).toMatchObject({ build: null, windows11: null, webview2: null });
    expect(caps.vulkan["loaderPresent"]).toBeNull();
    expect(caps.power["batteryPresent"]).toBeNull();
  });

  it("measures latency only when the owner already allows network, and only against the one existing endpoint", async () => {
    const net = require_("../../electron/net-status.cjs") as { resetNetworkCaches: () => void };
    const asked: Array<Rec> = [];
    const timedProbe = async (target: Rec) => {
      asked.push(target);
      return { ok: true, ms: 37 };
    };
    net.resetNetworkCaches();
    const shell = fakeShell({ static: STATIC_IGPU_LAPTOP, dynamic: DYNAMIC_LAPTOP_BATTERY });
    const off = (await hw.detectCapabilities(winOptions(shell, fakeFs([]), { timedProbe }))) as {
      network: Rec;
    };
    expect(off.network["latencyMs"]).toBeNull();
    expect(asked).toEqual([]);
    const on = (await hw.detectCapabilities(
      winOptions(shell, fakeFs([]), { timedProbe, allowNetwork: true }),
    )) as { network: Rec };
    expect(on.network["latencyMs"]).toBe(37);
    expect(asked).toEqual([{ host: "1.1.1.1", port: 443 }]);
    // A second ask inside the minute is answered from the cache: no second connection.
    await hw.detectCapabilities(winOptions(shell, fakeFs([]), { timedProbe, allowNetwork: true }));
    expect(asked).toHaveLength(1);
    net.resetNetworkCaches();
  });
});

describe("detectHardware does not wait for the capability probes", () => {
  it("returns on time with capabilities null while a probe is still hanging, and keeps the existing facts", async () => {
    const shell = fakeShell({ static: "hang", dynamic: "hang" });
    const started = Date.now();
    const result = await hw.detectHardware({
      root: null,
      capabilityGraceMs: 30,
      capabilityOptions: winOptions(shell, fakeFs([])),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result["capabilities"]).toBeNull();
    expect(result).toHaveProperty("cpu");
    expect(result).toHaveProperty("plan");
    expect(result).toHaveProperty("memory");
  }, 20_000);

  it("attaches the capabilities when they are ready, and the facts read them", async () => {
    const shell = fakeShell({ static: STATIC_NVIDIA_DESKTOP, dynamic: DYNAMIC_DESKTOP });
    const result = await hw.detectHardware({
      root: null,
      capabilityGraceMs: 5_000,
      capabilityOptions: winOptions(shell, fakeFs([])),
    });
    expect(result["capabilities"]).not.toBeNull();
    const facts = hw.hardwareFacts(result);
    expect(facts.os["build"]).toBe(19045); // the registry's build wins over the kernel string
    expect(facts.cpu["avx2"]).toBe(true);
  }, 20_000);
});

describe("hardwareFacts stays additive and never throws", () => {
  it("leaves every original fact unchanged whether or not capabilities exist", () => {
    const smi = hw.parseNvidiaSmi(NVIDIA_SMI);
    const base = hardwareObject({
      gpus: smi,
      cuda: { driverAvailable: true, driverCudaVersion: "12.5" },
    });
    const plain = hw.hardwareFacts(base, { freeRamGb: 9 });
    const caps = hw.hardwareFacts(
      { ...base, capabilities: { os: { build: 22631, windows11: true }, power: { onAc: false } } },
      { freeRamGb: 9 },
    );
    for (const key of [
      "vramGb",
      "vramFreeGb",
      "ramGb",
      "ramFreeGb",
      "diskFreeGb",
      "gpuVendor",
      "gpuName",
      "cudaReady",
      "driverVersion",
      "npu",
      "cpuClass",
    ] as const) {
      expect(caps[key]).toEqual(plain[key]);
    }
    expect(plain.gpus).toEqual(caps.gpus);
    expect(plain.os["windows11"]).toBe(true); // from the platform string alone (win32 10.0.22631)
    expect(plain.network).toEqual({
      online: null,
      type: null,
      metered: null,
      roaming: null,
      latencyMs: null,
    });
  });

  it("takes the unplugged state and the thermal state from the caller, and a bad directx level is dropped", () => {
    const base = hardwareObject({
      capabilities: { power: { batteryPresent: true, batteryPercent: 15, onAc: true } },
    });
    const facts = hw.hardwareFacts(base, {
      power: { onBatteryPower: true, thermalState: "serious" },
      directxLevel: "12_1",
    });
    expect(facts.power).toMatchObject({ onAc: false, thermal: "serious", batteryPercent: 15 });
    expect(facts.directxLevel).toBe("12_1");
    expect(facts.health.reasons).toEqual(
      expect.arrayContaining(["on-battery", "battery-low", "thermal-serious"]),
    );
    expect(hw.hardwareFacts(base, { directxLevel: "DX12; rm -rf" }).directxLevel).toBeNull();
    expect(
      hw.hardwareFacts(base, { power: { thermalState: "unknown" } }).power["thermal"],
    ).toBeNull();
  });

  it("survives capabilities of any wrong shape", () => {
    const shapes: unknown[] = [
      "x",
      5,
      [],
      [1],
      {
        os: "x",
        cpu: [],
        memory: 3,
        storage: "C:",
        network: "up",
        power: [1],
        cuda: "yes",
        vulkan: 1,
        gpuExtras: 7,
      },
      { drives: null },
      {
        os: { build: "abc", webview2: "yes" },
        network: { latencyMs: "fast", type: "carrier pigeon" },
        power: { batteryPercent: 900 },
      },
    ];
    for (const capabilities of shapes) {
      const facts = hw.hardwareFacts(
        { ...hardwareObject({}), capabilities },
        { capabilities: undefined },
      );
      expect(facts.health).toBeTruthy();
      expect(facts.network["type"]).toBeNull();
      expect(facts.power["batteryPercent"]).toBeNull();
      expect(facts.os["webview2"]).toBeNull();
    }
    expect(() => hw.hardwareFacts(null)).not.toThrow();
    expect(() => hw.hardwareFacts(undefined, null as unknown as Rec)).not.toThrow();
    expect(hw.hardwareFacts(null).health).toEqual({ level: "ok", reasons: [] });
    expect(hw.hardwareFacts(null).drives).toEqual([]);
  });

  it("lists every GPU of a hybrid laptop with its driver date, flags the integrated one, and the model drive may differ from the data drive", () => {
    const gpus = [
      ...hw.parseNvidiaSmi(NVIDIA_SMI),
      ...hw.parseVideoControllers(
        JSON.stringify([
          {
            Name: "Intel(R) UHD Graphics 630",
            AdapterRAM: 1073741824,
            Qw: 1073741824,
            Driver: "30.0.101.1",
          },
        ]),
      ),
    ];
    const facts = hw.hardwareFacts(
      hardwareObject({
        gpus,
        capabilities: {
          gpuExtras: [
            { name: "NVIDIA GeForce RTX 2060", driverDate: "2024-05-14" },
            { name: "Intel(R) UHD Graphics 630", driverDate: "2022-01-01" },
          ],
          storage: [
            { letter: "C:", media: "ssd", bus: "nvme" },
            { letter: "D:", media: "hdd", bus: "sata" },
          ],
          dataRootDrive: "D:",
          modelCacheDrive: "C:",
        },
      }),
    );
    expect(facts.multiGpu).toBe(true);
    expect(facts.gpus.map((g) => [g["vendor"], g["integrated"], g["driverDate"]])).toEqual([
      ["nvidia", false, "2024-05-14"],
      ["intel", true, "2022-01-01"],
    ]);
    expect(facts.integrated).toBe(false);
    expect(facts.dataRootDrive).toBe("D:");
    expect(facts.modelCacheDrive).toBe("C:");
    expect(facts.modelDrive).toEqual({ letter: "C:", freeGb: 120, media: "ssd" });
  });

  it("a card whose only figure is the capped 32-bit AdapterRAM is not integrated; one without any figure is unknown", () => {
    const capped = hw.hardwareFacts(
      hardwareObject({
        gpus: hw.parseVideoControllers(
          JSON.stringify([{ Name: "Some Card", AdapterRAM: 4293918720, Driver: "1" }]),
        ),
      }),
    );
    expect(capped.integrated).toBe(false);
    const none = hw.hardwareFacts(
      hardwareObject({
        gpus: hw.parseVideoControllers(JSON.stringify([{ Name: "Some Card", Driver: "1" }])),
      }),
    );
    expect(none.integrated).toBeNull();
  });
});

describe("health summary", () => {
  it("is ok for a comfortable PC and for one that is simply unknown", () => {
    expect(
      hw.healthOf({
        ramGb: 32,
        memory: { pressure: "ok" },
        modelDrive: { freeGb: 400 },
        power: { onAc: true },
        network: { metered: false },
      }),
    ).toEqual({ level: "ok", reasons: [] });
    expect(hw.healthOf({})).toEqual({ level: "ok", reasons: [] });
    expect(hw.healthOf(null)).toEqual({ level: "ok", reasons: [] });
    expect(hw.healthOf("junk")).toEqual({ level: "ok", reasons: [] });
  });

  it("is tight for what works but leaves no headroom, and critical beats tight", () => {
    expect(
      hw.healthOf({
        ramGb: 8,
        memory: { pressure: "high" },
        modelDrive: { freeGb: 6 },
        cpu: { avx2: false },
        os: { vcRuntimeX64: false },
      }),
    ).toEqual({
      level: "tight",
      reasons: ["ram-high", "disk-low", "no-avx2", "vc-runtime-missing"],
    });
    const worst = hw.healthOf({
      ramGb: 4,
      memory: { pressure: "critical", commitPressure: "high" },
      modelDrive: { freeGb: 1 },
      power: { onAc: false, batteryPercent: 4, thermal: "critical" },
    });
    expect(worst.level).toBe("critical");
    expect(worst.reasons).toEqual(
      expect.arrayContaining([
        "ram-small",
        "commit-high",
        "on-battery",
        "ram-critical",
        "disk-critical",
        "thermal-critical",
        "battery-critical",
      ]),
    );
  });

  it("a rule that throws on odd data is skipped, not fatal", () => {
    const evil = {
      get memory(): never {
        throw new Error("no");
      },
      ramGb: 3,
    };
    expect(hw.healthOf(evil).level).toBe("tight");
  });
});

describe("the scripts and the sources stay safe", () => {
  it("both PowerShell scripts are one line, with no double quote, no backtick and no dynamic code", () => {
    for (const script of [
      hw.CAPABILITY_SCRIPTS.STATIC_SCRIPT,
      hw.CAPABILITY_SCRIPTS.dynamicScript(),
    ]) {
      expect(script).not.toMatch(/[\r\n"`]/);
      expect(script).not.toMatch(
        /Invoke-Expression|\biex\b|Invoke-WebRequest|Start-Process|-Verb|Set-|Remove-|New-Item|Out-File/i,
      );
      expect(script.endsWith("ConvertTo-Json -Depth 5 -Compress")).toBe(true);
    }
    expect(hw.CAPABILITY_SCRIPTS.dynamicScript()).toContain("GetInternetConnectionProfile");
  });

  it("every external command in the capability block is asynchronous: no sync spawn, no sync fs on a path that can hang", () => {
    const text = read("electron/hardware.cjs");
    const block = text.slice(
      text.indexOf("// Capability probes:"),
      text.indexOf("// hardwareFacts: what the model router"),
    );
    expect(block.length).toBeGreaterThan(5000);
    expect(block).not.toMatch(
      /execSync|spawnSync|execFileSync|existsSync|statSync|readFileSync|readdirSync/,
    );
    expect(block).not.toMatch(/setInterval/);
  });

  it("the capability block names no graphics card", () => {
    const text = read("electron/hardware.cjs");
    const block = text
      .slice(
        text.indexOf("// Capability probes:"),
        text.indexOf("// hardwareFacts: what the model router"),
      )
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(block).not.toMatch(/\b(rtx|gtx|radeon|geforce|quadro|iris|uhd|arc\s?a\d|titan)\b/i);
  });

  it("a file system call that throws at once is not found, not a crash", async () => {
    const throwing = {
      stat: () => {
        throw new Error("EIO");
      },
      readdir: () => {
        throw new Error("EIO");
      },
      readFile: () => {
        throw new Error("EIO");
      },
    };
    expect(
      await hw.findCudaRuntimeFiles({ platform: "win32", env: WIN_ENV, fsApi: throwing }),
    ).toMatchObject({ cublas12: false, cudnn9: false });
    const shell = fakeShell({ static: STATIC_IGPU_LAPTOP, dynamic: DYNAMIC_DESKTOP });
    const caps = (await hw.detectCapabilities(winOptions(shell, throwing as never))) as {
      vulkan: Rec;
    };
    expect(caps.vulkan["loaderPresent"]).toBeNull();
  });

  it("withDeadline gives the fallback on a timeout or a throw and never rejects", async () => {
    expect(await hw.withDeadline(Promise.reject(new Error("x")), 50, "fb")).toBe("fb");
    expect(await hw.withDeadline(new Promise(() => undefined), 20, "late")).toBe("late");
    expect(await hw.withDeadline(Promise.resolve(7), 50, "fb")).toBe(7);
    expect(
      await hw.withDeadline(
        () => {
          throw new Error("sync");
        },
        50,
        "fb",
      ),
    ).toBe("fb");
  });
});
