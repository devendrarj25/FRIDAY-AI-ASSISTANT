/**
 * The PC status the Hardware and Status pages show (src/lib/friday/pc-status.ts, use-pc-status.ts): what the main
 * process measured, worded in plain rows. Fake machines (a laptop with no GPU on battery, an NVIDIA desktop with cuBLAS
 * but no cuDNN, a 4 GB PC, a PC under critical pressure) and every page state: loading, offline, error, ready,
 * still measuring. A value no probe read says "not measured"; nothing is invented.
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GovernorStatus, HardwareFacts } from "../../src/lib/friday/desktop";
import {
  capabilityPending,
  governorRows,
  gpuMemoryText,
  healthView,
  MEASURING,
  NOT_MEASURED,
  pcSections,
  pcSummaryLine,
  vramHeadline,
} from "../../src/lib/friday/pc-status";
import { readPcStatus } from "../../src/lib/friday/use-pc-status";

const require_ = createRequire(import.meta.url);
const hw = require_("../../electron/hardware.cjs") as {
  hardwareFacts: (hardware: unknown, deps?: Record<string, unknown>) => HardwareFacts;
};

/** A healthy 16 GB desktop with an NVIDIA card; each test changes only what it is about. */
function desktop(over: Partial<HardwareFacts> = {}): HardwareFacts {
  return {
    vramGb: 6,
    vramFreeGb: 5.2,
    ramGb: 16,
    ramFreeGb: 9,
    diskFreeGb: 300,
    gpuVendor: "nvidia",
    gpuName: "NVIDIA GeForce RTX 2060",
    gpus: [
      {
        vendor: "nvidia",
        name: "NVIDIA GeForce RTX 2060",
        vramGb: 6,
        vramCapped: false,
        driver: "556.12",
        driverDate: "2024-05-14",
        integrated: false,
      },
    ],
    cudaReady: true,
    driverVersion: "556.12",
    npu: false,
    cpuClass: "mid",
    sources: ["nvidia-smi", "os-memory-live", "model-drive", "capability-probe"],
    os: {
      platform: "win32",
      build: 22631,
      buildFull: "22631.4037",
      name: "Windows 11 Home",
      displayVersion: "23H2",
      edition: null,
      windows11: true,
      is64Bit: true,
      arch: "x64",
      webview2: true,
      vcRuntimeX64: true,
    },
    cpu: {
      model: "AMD Ryzen 7 5800X 8-Core Processor",
      physicalCores: 8,
      logicalCores: 16,
      baseClockMhz: 3801,
      avx: true,
      avx2: true,
      avx512: false,
      fma: true,
    },
    memory: {
      pressure: "ok",
      commitPressure: "ok",
      commitLimitGb: 36.2,
      commitFreeGb: 28.6,
      pagefileGb: 5,
    },
    drives: [
      {
        letter: "C:",
        totalGb: 476,
        freeGb: 120,
        media: "ssd",
        bus: "NVMe",
        holdsDataRoot: false,
        holdsModelCache: false,
      },
      {
        letter: "D:",
        totalGb: 931,
        freeGb: 300,
        media: "hdd",
        bus: "SATA",
        holdsDataRoot: true,
        holdsModelCache: true,
      },
    ],
    dataRootDrive: "D:",
    modelCacheDrive: "D:",
    vulkan: true,
    cuda: { driverCuda: "12.5", cublas12: true, cudnn9: true, runtimeFilesFound: true },
    network: { online: true, type: "ethernet", metered: false, roaming: false, latencyMs: 23 },
    power: {
      batteryPresent: false,
      batteryPercent: null,
      onAc: true,
      planName: "High performance",
      batterySaver: null,
      thermal: null,
    },
    health: { level: "ok", reasons: [] },
    ...over,
  };
}

const governor = (over: Partial<GovernorStatus> = {}): GovernorStatus => ({
  ok: true,
  level: "ok",
  notice: null,
  memory: { freeMb: 9216, totalMb: 16384, level: "ok" },
  vram: { freeMb: 5324, totalMb: 6144, level: "ok" },
  lag: { p99Ms: 12, maxMs: 40, paused: false },
  power: { stress: "none", preferSmall: false },
  holds: [],
  leases: [],
  queued: [],
  jobs: { modelLoad: { running: 0, queued: 0, cap: 1, maxQueue: 4, saturated: false } },
  actions: [],
  ...over,
});

const row = (facts: HardwareFacts | null, sectionId: string, label: string, g = governor()) => {
  const found = pcSections(facts, g)
    .find((s) => s.id === sectionId)
    ?.rows.find((r) => r.label === label);
  if (!found) throw new Error(`no row ${sectionId}/${label}`);
  return found;
};

describe("a healthy NVIDIA desktop", () => {
  it("shows OS and build, CPU model, cores and AVX flags, RAM, GPU memory and driver, drives and network", () => {
    const f = desktop();
    expect(row(f, "system", "Windows").value).toBe("Windows 11 Home 23H2 (build 22631.4037)");
    expect(row(f, "system", "System type").value).toBe("64-bit · x64");
    expect(row(f, "processor", "Processor").value).toBe("AMD Ryzen 7 5800X 8-Core Processor");
    expect(row(f, "processor", "Cores").value).toBe("8 cores · 16 threads");
    expect(row(f, "processor", "Base clock").value).toBe("3.80 GHz");
    expect(row(f, "processor", "Instruction sets").value).toBe(
      "AVX yes · AVX2 yes · AVX-512 no · FMA yes",
    );
    expect(row(f, "memory", "Memory (total · used · free)").value).toBe("16 GB · 7 GB · 9 GB");
    expect(row(f, "memory", "Memory pressure").value).toBe("ok");
    expect(row(f, "graphics", "Graphics card: video memory").value).toBe(
      "6 GB · 5.2 GB free · driver 556.12 (2024-05-14)",
    );
    expect(row(f, "graphics", "CUDA driver version").value).toBe("CUDA 12.5");
    expect(row(f, "graphics", "cuBLAS 12 file").value).toBe("yes");
    expect(row(f, "graphics", "cuDNN 9 file").value).toBe("yes");
    expect(row(f, "graphics", "Vulkan").value).toBe("yes");
    expect(row(f, "storage", "Drive D:").value).toBe(
      "931 GB · 300 GB free · hard disk · holds FRIDAY data + model cache",
    );
    expect(row(f, "storage", "Drive C:").value).toBe("476 GB · 120 GB free · SSD");
    expect(row(f, "network", "Online").value).toBe("yes");
    expect(row(f, "network", "Connection").value).toBe("Ethernet");
    expect(row(f, "network", "Round trip").value).toBe("23 ms");
    expect(row(f, "power", "Power plan").value).toBe("High performance");
    expect(healthView(f)).toMatchObject({ level: "ok", title: "This PC is healthy", reasons: [] });
  });
});

describe("a laptop with no GPU, on battery", () => {
  const laptop = desktop({
    vramGb: null,
    vramFreeGb: null,
    gpuVendor: null,
    gpuName: null,
    gpus: [],
    cudaReady: false,
    driverVersion: null,
    cuda: { driverCuda: null, cublas12: null, cudnn9: null, runtimeFilesFound: null },
    vulkan: false,
    power: {
      batteryPresent: true,
      batteryPercent: 18,
      onAc: false,
      planName: "Balanced",
      batterySaver: false,
      thermal: null,
    },
    network: { online: true, type: "wifi", metered: true, roaming: false, latencyMs: null },
    health: { level: "tight", reasons: ["on-battery", "battery-low", "metered-network"] },
  });

  it("says there is no graphics card and why CUDA does not apply, never inventing a GPU", () => {
    expect(row(laptop, "graphics", "Graphics card").value).toBe("none found");
    expect(row(laptop, "graphics", "CUDA").value).toBe("no: no GPU was found");
    expect(row(laptop, "graphics", "CUDA driver version").value).toBe(NOT_MEASURED);
    expect(row(laptop, "graphics", "Vulkan").state).toBe("warn");
  });

  it("shows the battery, the plan and a heat reading Windows does not give", () => {
    expect(row(laptop, "power", "Battery").value).toBe("18% · on battery");
    expect(row(laptop, "power", "Battery").state).toBe("warn");
    expect(row(laptop, "power", "Heat").value).toBe("not reported by Windows");
    expect(row(laptop, "network", "Connection").value).toBe("Wi-Fi");
    expect(row(laptop, "network", "Metered").state).toBe("warn");
  });

  it("explains the tight health level in plain sentences", () => {
    const view = healthView(laptop);
    expect(view.level).toBe("tight");
    expect(view.title).toBe("This PC is running tight");
    expect(view.reasons).toEqual([
      "The PC is on battery, so FRIDAY prefers smaller models and waits to prefetch.",
      "The battery is under 20% and the PC is unplugged.",
      "The connection is metered, so large downloads should wait.",
    ]);
  });

  it("leaves the round trip unmeasured when the owner has not allowed network use", () => {
    expect(row(laptop, "network", "Round trip").value).toContain("not measured");
  });
});

describe("an NVIDIA desktop with cuBLAS but no cuDNN", () => {
  const f = desktop({
    cuda: { driverCuda: "12.5", cublas12: true, cudnn9: false, runtimeFilesFound: false },
  });
  it("shows each CUDA file by itself and the verdict from the driver alone", () => {
    expect(row(f, "graphics", "cuBLAS 12 file")).toMatchObject({ value: "yes", state: "ok" });
    expect(row(f, "graphics", "cuDNN 9 file")).toMatchObject({ value: "no", state: "warn" });
    expect(row(f, "graphics", "CUDA").value).toContain("cuDNN is checked separately");
  });
});

describe("a 4 GB RAM PC and critical pressure", () => {
  const small = desktop({
    ramGb: 4,
    ramFreeGb: 0.6,
    vramGb: null,
    gpus: [],
    memory: {
      pressure: "critical",
      commitPressure: "high",
      commitLimitGb: 6,
      commitFreeGb: 0.4,
      pagefileGb: 2,
    },
    health: { level: "critical", reasons: ["ram-small", "ram-critical", "commit-high"] },
  });
  const pressured = governor({
    level: "critical",
    memory: { freeMb: 614, totalMb: 4096, level: "critical" },
    notice: "Memory is very low, so big models are held back.",
    holds: ["pressure"],
    leases: [
      {
        id: "lease-1",
        owner: "speech-worker",
        kind: "speech",
        priority: "voice",
        state: "active",
        vramMb: 0,
        ramMb: 410,
        ageMs: 5000,
      },
    ],
    queued: [{ owner: "chat:big", priority: "chat", reason: "waiting for memory" }],
  });

  it("marks memory and health as critical, with the reasons in words", () => {
    expect(row(small, "memory", "Memory (total · used · free)")).toMatchObject({
      value: "4 GB · 3.4 GB · 0.6 GB",
      state: "warn",
    });
    expect(row(small, "memory", "Memory pressure")).toMatchObject({
      value: "critical",
      state: "bad",
    });
    const view = healthView(small);
    expect(view.level).toBe("critical");
    expect(view.title).toBe("This PC needs attention");
    expect(view.reasons[0]).toBe("This PC has under 6 GB of memory, so only small models fit.");
    expect(view.reasons).toHaveLength(3);
  });

  it("shows the governor's pressure, leases, queue and the notice", () => {
    const rows = governorRows(pressured);
    const by = (label: string) => rows.find((r) => r.label === label);
    expect(by("Pressure")).toMatchObject({
      value: "critical: new heavy loads are refused",
      state: "bad",
    });
    expect(by("Leases held")?.value).toBe("speech-worker (voice, active) · 1 waiting");
    expect(by("Memory (free · level)")).toMatchObject({ state: "bad" });
    expect(by("Last action")?.value).toBe("Memory is very low, so big models are held back.");
    expect(by("Main process lag")?.value).toBe("p99 12 ms, longest 40 ms");
  });

  it("says the governor is not running instead of showing made-up rows", () => {
    expect(governorRows(null)).toEqual([
      { label: "Resource governor", value: "not running", state: "unknown" },
    ]);
  });

  it("puts the pressure into the one-line summary", () => {
    expect(pcSummaryLine(small, pressured)).toBe(
      "This PC needs attention · 0.6 of 4 GB memory free · pressure critical",
    );
    expect(pcSummaryLine(null, null)).toBe("Not read yet");
  });
});

describe("a graphics card measured only by the capped 32-bit reading", () => {
  const capped = desktop({
    vramGb: null,
    vramFreeGb: null,
    gpus: [
      {
        vendor: "amd",
        name: "AMD Radeon RX 6800",
        vramGb: null,
        vramCapped: true,
        driver: "24.1.1",
        integrated: null,
      },
    ],
    cudaReady: false,
  });
  it("says at least 4 GB and that the real size is not measured, never a plain 4 GB", () => {
    expect(row(capped, "graphics", "Graphics card: video memory").value).toContain(
      "at least 4 GB (capped 32-bit reading; the real size is not measured)",
    );
    expect(gpuMemoryText(capped.gpus[0]!)).not.toMatch(/^4 GB/);
    expect(vramHeadline(capped, 4096)).toBe("at least 4 GB (capped reading)");
    expect(vramHeadline(desktop(), null)).toBe("6 GB total");
    expect(vramHeadline(null, 8192)).toBe("8 GB total");
    expect(vramHeadline(null, null)).toBeNull();
  });
});

describe("still measuring versus not measured", () => {
  // The first answer after launch: the wider probes are not in yet, so those blocks are absent.
  const early: HardwareFacts = {
    ...desktop({
      sources: ["nvidia-smi", "os-memory-live"],
      drives: [],
      vulkan: null,
      health: { level: "ok", reasons: [] },
    }),
  };
  for (const key of ["os", "cpu", "memory", "network", "power", "cuda"] as const) delete early[key];

  it("says measuring while the wider probes have not answered, and does not call the PC healthy yet", () => {
    expect(capabilityPending(early)).toBe(true);
    expect(row(early, "processor", "Processor").value).toBe(MEASURING);
    expect(row(early, "storage", "Drives").value).toBe(MEASURING);
    expect(row(early, "graphics", "Vulkan").value).toBe(MEASURING);
    expect(healthView(early)).toMatchObject({ level: "unknown", title: "Still measuring this PC" });
  });

  it("says not measured for a value the finished probes could not read", () => {
    const done = desktop({
      cpu: {
        model: null,
        physicalCores: null,
        logicalCores: null,
        baseClockMhz: null,
        avx: null,
        avx2: null,
        avx512: null,
        fma: null,
      },
      vulkan: null,
    });
    expect(capabilityPending(done)).toBe(false);
    expect(row(done, "processor", "Processor").value).toBe(NOT_MEASURED);
    expect(row(done, "processor", "Cores").value).toBe(NOT_MEASURED);
    expect(row(done, "processor", "Instruction sets").value).toContain("AVX not measured");
    expect(row(done, "graphics", "Vulkan").value).toBe(NOT_MEASURED);
  });

  it("never prints NaN, undefined, null or a zero it did not measure", () => {
    const empty = hw.hardwareFacts(null);
    const text = pcSections(empty, null)
      .flatMap((s) => s.rows.map((r) => r.value))
      .join("\n");
    expect(text).not.toMatch(/NaN|undefined|null|\b0 GB/);
    expect(pcSections(null, null)).toEqual([]);
  });

  it("keeps a code it does not know readable", () => {
    const view = healthView(desktop({ health: { level: "tight", reasons: ["brand-new-code"] } }));
    expect(view.reasons).toEqual(["Note from the check: brand-new-code."]);
  });
});

describe("the real facts object, end to end", () => {
  it("carries power from the main process and the probes' answers into the rows", () => {
    const facts = hw.hardwareFacts(
      {
        platform: "win32 10.0.22631",
        arch: "x64",
        cpu: { model: "Test CPU", cores: 12, threads: 12, physicalCores: 6 },
        memory: { totalGb: 8, freeGb: 3 },
        disk: { freeGb: 50, totalGb: 200 },
        drives: [{ letter: "C:", totalGb: 200, freeGb: 50, holdsFridayFolder: true }],
        gpus: [],
        cuda: { driverAvailable: false, driverCudaVersion: null },
        capabilities: {
          os: { build: 22631, name: "Windows 11 Home", windows11: true, is64Bit: true },
          cpu: { avx: true, avx2: true, avx512: false, fma: true },
          memory: {},
          storage: [{ letter: "C:", media: "ssd", bus: "NVMe" }],
          dataRootDrive: "C:",
          modelCacheDrive: "C:",
          vulkan: { loaderPresent: true, driverCount: 1 },
          cuda: { cublas12: false, cudnn9: false, runtimeFilesFound: false },
          network: { online: true, type: "wifi", metered: false, roaming: false, latencyMs: null },
          power: { batteryPresent: true, batteryPercent: 64, onAc: true, planName: "Balanced" },
        },
      },
      { power: { onBatteryPower: true, thermalState: null }, freeRamGb: 3 },
    );
    expect(capabilityPending(facts)).toBe(false);
    expect(row(facts, "system", "Windows").value).toBe("Windows 11 Home (build 22631)");
    expect(row(facts, "power", "Battery").value).toBe("64% · on battery");
    expect(row(facts, "power", "Heat").value).toBe("not reported by Windows");
    expect(row(facts, "processor", "Cores").value).toBe("6 cores · 12 threads");
    expect(row(facts, "storage", "Drive C:").value).toContain("holds FRIDAY data + model cache");
    expect(row(facts, "memory", "Memory (total · used · free)").value).toBe("8 GB · 5 GB · 3 GB");
    expect(healthView(facts).reasons).toContain(
      "The PC is on battery, so FRIDAY prefers smaller models and waits to prefetch.",
    );
  });
});

describe("reading the facts through the desktop bridge", () => {
  afterEach(() => vi.unstubAllGlobals());
  const bridge = (friday: Record<string, unknown> | undefined) =>
    vi.stubGlobal("window", friday ? { friday } : {});

  it("is offline outside the desktop app", async () => {
    bridge(undefined);
    await expect(readPcStatus()).resolves.toEqual({ phase: "offline" });
    bridge({});
    await expect(readPcStatus()).resolves.toEqual({ phase: "offline" });
  });

  it("is an error with a message when the facts cannot be read (the page offers Retry)", async () => {
    bridge({ hardwareFacts: async () => ({ ok: false, error: "probe failed" }) });
    await expect(readPcStatus(true)).resolves.toEqual({ phase: "error", message: "probe failed" });
    bridge({
      hardwareFacts: async () => {
        throw new Error("ipc budget expired");
      },
    });
    await expect(readPcStatus()).resolves.toEqual({
      phase: "error",
      message: "ipc budget expired",
    });
    bridge({ hardwareFacts: async () => ({ ok: true }) });
    expect(await readPcStatus()).toMatchObject({ phase: "error" });
  });

  it("passes force through, and reads the governor beside the facts", async () => {
    const hardwareFacts = vi.fn(async () => ({ ok: true, facts: desktop() }));
    bridge({ hardwareFacts, governorStatus: async () => governor({ level: "high" }) });
    const view = await readPcStatus(true);
    expect(hardwareFacts).toHaveBeenCalledWith(true);
    expect(view).toMatchObject({ phase: "ready", governor: { level: "high" } });
  });

  it("still shows the facts when the governor is missing, failed or not running", async () => {
    const facts = { hardwareFacts: async () => ({ ok: true, facts: desktop() }) };
    bridge(facts);
    expect(await readPcStatus()).toMatchObject({ phase: "ready", governor: null });
    bridge({ ...facts, governorStatus: async () => ({ ok: false, error: "not running" }) });
    expect(await readPcStatus()).toMatchObject({ phase: "ready", governor: null });
    bridge({
      ...facts,
      governorStatus: async () => {
        throw new Error("gone");
      },
    });
    expect(await readPcStatus()).toMatchObject({ phase: "ready", governor: null });
  });
});
