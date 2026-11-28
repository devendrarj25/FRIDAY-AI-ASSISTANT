// Hardware detection and the acceleration plan.
// Detection only: nothing here changes system settings or reserves resources.
// The plan deliberately leaves headroom so FRIDAY stays responsive in the
// foreground and never pins the machine at 100%.
const fs = require("fs");
const os = require("os");
const path = require("path");
// Shared, packaged-app-safe execution context: absolute interpreter paths,
// execution-policy bypass, known NVIDIA install folders, and — critically —
// real failure reasons instead of a silent `null`.
const { runProbe, runPowerShell, nvidiaSmiPath, nvccPath } = require(
  path.join(__dirname, "probe-exec.cjs"),
);

/** Thin wrapper kept for the existing call sites: stdout, or null on failure. */
const run = (cmd, args, timeout = 8000) =>
  runProbe(cmd, args, timeout).then((r) => (r.ok ? r.stdout : null));

/** Why the last detection attempt failed, per probe. Surfaced to the UI. */
const probeErrors = { nvidiaSmi: null, cuda: null, videoController: null };

const GB = 1024 * 1024 * 1024;
const toGb = (bytes) => Math.round((bytes / GB) * 10) / 10;
const MIB = 1024 * 1024;

// Win32_VideoController.AdapterRAM is a 32-bit number: any card with 4 GB or more reports 4 GB (or a wrapped,
// negative value), so an 8 or 24 GB AMD or Intel card looked like a 4 GB one. The driver's own 64-bit figure
// (HardwareInformation.qwMemorySize in the display class registry key) is read as well and wins when present.
const UINT32_CAP = 4293918720; // 0xFFF00000: what a 4 GB or larger card reports

// Adapters that are not a graphics card FRIDAY could run a model on.
const VIRTUAL_ADAPTER =
  /basic (render|display)|remote display|virtual|parsec|hyper-v|vmware svga|citrix|indirect display|displaylink|spacedesk/i;

const vendorOf = (name) =>
  /nvidia/i.test(name)
    ? "nvidia"
    : /amd|radeon/i.test(name)
      ? "amd"
      : /intel/i.test(name)
        ? "intel"
        : "other";

const asRows = (text) => {
  try {
    const parsed = JSON.parse(String(text || "").trim());
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
};

/** Graphics cards from `Win32_VideoController` rows as JSON ({Name, AdapterRAM, Qw, Driver}). */
function parseVideoControllers(text) {
  return asRows(text)
    .map((row) => {
      const name = String(row?.Name || "").trim();
      if (!name || VIRTUAL_ADAPTER.test(name)) return null;
      const qw = Number(row.Qw);
      const ram = Number(row.AdapterRAM);
      let bytes = null;
      let vramKnown = false;
      if (qw > 0) {
        bytes = qw;
        vramKnown = true;
      } else if (ram > 0) {
        bytes = ram;
        vramKnown = ram < UINT32_CAP;
      } else if (ram < 0) {
        bytes = ram + 2 ** 32; // a 32-bit value that wrapped
      }
      return {
        vendor: vendorOf(name),
        name,
        vramTotalMb: bytes ? Math.round(bytes / MIB) : null,
        // false: the driver only reported the 32-bit figure, so the card has "at least" this much.
        vramKnown,
        vramUsedMb: null,
        driver: row.Driver ? String(row.Driver) : null,
      };
    })
    .filter(Boolean);
}

/** Fixed drives from `Win32_LogicalDisk` rows as JSON ({DeviceID, Size, FreeSpace, VolumeName, FileSystem}). */
function parseLogicalDisks(text) {
  return asRows(text)
    .map((row) => {
      const total = Number(row?.Size);
      const free = Number(row?.FreeSpace);
      if (!row?.DeviceID || !(total > 0)) return null;
      return {
        letter: String(row.DeviceID),
        label: row.VolumeName ? String(row.VolumeName) : "",
        fileSystem: row.FileSystem ? String(row.FileSystem) : "",
        totalGb: toGb(total),
        freeGb: toGb(Number.isFinite(free) ? free : 0),
        usedPercent: Math.round(((total - (Number.isFinite(free) ? free : 0)) / total) * 100),
      };
    })
    .filter(Boolean);
}

/** Physical and logical cores from `Win32_Processor` rows as JSON. One row per socket. */
function parseCpuTopology(text) {
  let physical = 0;
  let logical = 0;
  for (const row of asRows(text)) {
    physical += Number(row?.NumberOfCores) || 0;
    logical += Number(row?.NumberOfLogicalProcessors) || 0;
  }
  return physical > 0 ? { physical, logical: logical || null } : null;
}

/** Physical cores from /proc/cpuinfo (Linux): distinct (physical id, core id) pairs. */
function physicalCoresFromProcCpuinfo(text) {
  const pairs = new Set();
  let perSocket = 0;
  const sockets = new Set();
  for (const block of String(text || "").split(/\r?\n\s*\r?\n/)) {
    const physical = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    const cores = Number(/^cpu cores\s*:\s*(\d+)/m.exec(block)?.[1]);
    if (physical !== undefined && core !== undefined) pairs.add(`${physical}:${core}`);
    if (physical !== undefined) sockets.add(physical);
    if (cores > 0) perSocket = cores;
  }
  if (pairs.size > 0) return pairs.size;
  return perSocket > 0 ? perSocket * Math.max(1, sockets.size) : null;
}

async function detectCpuTopology() {
  try {
    if (process.platform === "win32") {
      const result = await runPowerShell(
        "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json -Compress",
        10000,
      );
      return result.ok ? parseCpuTopology(result.stdout) : null;
    }
    if (process.platform === "linux") {
      const physical = physicalCoresFromProcCpuinfo(fs.readFileSync("/proc/cpuinfo", "utf8"));
      return physical ? { physical, logical: (os.cpus() || []).length || null } : null;
    }
    if (process.platform === "darwin") {
      const out = await run("sysctl", ["-n", "hw.physicalcpu"], 4000);
      const physical = Number(String(out || "").trim());
      return physical > 0 ? { physical, logical: (os.cpus() || []).length || null } : null;
    }
  } catch {
    /* topology is a refinement; the plan falls back to the logical count */
  }
  return null;
}

/** Every fixed drive (Windows). Elsewhere the drive of the FRIDAY folder is the only one reported. */
async function detectDrives(root) {
  if (process.platform === "win32") {
    const result = await runPowerShell(
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace,VolumeName,FileSystem | ConvertTo-Json -Compress',
      10000,
    );
    const drives = result.ok ? parseLogicalDisks(result.stdout) : [];
    if (drives.length) {
      const home = String(root || "")
        .slice(0, 2)
        .toUpperCase();
      return drives.map((drive) => ({
        ...drive,
        holdsFridayFolder: drive.letter.toUpperCase() === home,
      }));
    }
  }
  const one = diskFor(root);
  return one
    ? [
        {
          letter: one.path,
          label: "",
          fileSystem: "",
          totalGb: one.totalGb,
          freeGb: one.freeGb,
          usedPercent: one.totalGb
            ? Math.round(((one.totalGb - one.freeGb) / one.totalGb) * 100)
            : 0,
          holdsFridayFolder: true,
        },
      ]
    : [];
}

/**
 * A CUDA compute capability as "major.minor" ("7.5", "8.6", "12.0"), or null for anything else: a column an old
 * driver did not print, "[N/A]", garbage. It is a string so the exact text the driver gave is kept.
 */
function parseComputeCap(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return /^\d{1,2}\.\d{1,2}$/.test(String(value).trim()) ? String(value).trim() : null;
}

/**
 * NVIDIA cards from `nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version,utilization.gpu,
 * temperature.gpu,compute_cap`. The last column exists on driver 510 and newer; without it `computeCap` is null.
 */
function parseNvidiaSmi(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.split(",").map((s) => s.trim()))
    .filter((parts) => parts.length >= 4 && parts[0] && !/^\[|nvidia-smi/i.test(parts[0]))
    .map(([name, total, used, driver, utilization, temperature, computeCap]) => ({
      vendor: "nvidia",
      name,
      vramTotalMb: Number(total) > 0 ? Number(total) : null,
      vramKnown: Number(total) > 0,
      vramUsedMb: Number(used) > 0 ? Number(used) : null,
      driver: driver && !/^\[/.test(driver) ? driver : null,
      // "[N/A]" or "[Not Supported]" on cards that do not report these: null, never a made-up zero.
      utilizationPercent: Number.isFinite(parseFloat(utilization)) ? Number(utilization) : null,
      temperatureC: Number.isFinite(parseFloat(temperature)) ? Number(temperature) : null,
      computeCap: parseComputeCap(computeCap),
    }));
}

/** The highest CUDA version the installed driver supports, from the header of plain `nvidia-smi`. */
function parseCudaDriverVersion(text) {
  return /CUDA Version:\s*(\d+(?:\.\d+)?)/i.exec(String(text || ""))?.[1] ?? null;
}

const SMI_FIELDS = "name,memory.total,memory.used,driver_version,utilization.gpu,temperature.gpu";

/**
 * The cards, asking for compute_cap too. A driver older than 510 rejects the field and fails the whole query: then
 * the original six-column query runs once more and every computeCap stays null. Never throws.
 */
async function readNvidiaGpus(exe, probe = runProbe) {
  const query = (fields) =>
    Promise.resolve()
      .then(() => probe(exe, [`--query-gpu=${fields}`, "--format=csv,noheader,nounits"], 8000))
      .catch((err) => ({ ok: false, error: String(err?.message || err) }));
  let result = await query(`${SMI_FIELDS},compute_cap`);
  if (!(result?.ok && result.stdout)) {
    const retry = await query(SMI_FIELDS);
    if (retry?.ok && retry.stdout) result = retry;
    else if (!result?.ok && !retry?.ok) result = retry?.error ? retry : result;
  }
  return {
    gpus: result?.ok && result.stdout ? parseNvidiaSmi(result.stdout) : [],
    error: result?.ok ? null : result?.error || "nvidia-smi gave no answer",
  };
}

async function detectNvidia() {
  const exe = nvidiaSmiPath();
  if (!exe) {
    probeErrors.nvidiaSmi =
      "nvidia-smi not found (checked PATH, System32 and NVIDIA Corporation\\NVSMI)";
    return { gpus: [], cudaDriverVersion: null };
  }
  const [cards, plain] = await Promise.all([readNvidiaGpus(exe), runProbe(exe, [], 8000)]);
  probeErrors.nvidiaSmi = cards.error;
  return {
    gpus: cards.gpus,
    cudaDriverVersion: plain.ok ? parseCudaDriverVersion(plain.stdout) : null,
  };
}

// Every graphics card on Windows, with the driver's own 64-bit video memory figure (see UINT32_CAP above).
const PS_VIDEO =
  "$vram=@{}; Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p -and $p.DriverDesc) { $vram[$p.DriverDesc]=$p.'HardwareInformation.qwMemorySize' } }; " +
  "Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ Name=$_.Name; AdapterRAM=$_.AdapterRAM; Qw=$vram[$_.Name]; Driver=$_.DriverVersion } } | ConvertTo-Json -Compress";

async function detectWindowsGpus() {
  const first = await runPowerShell(PS_VIDEO, 15000);
  probeErrors.videoController = first.ok ? null : first.error;
  if (first.ok && first.stdout) return parseVideoControllers(first.stdout);
  // WMIC is removed from current Windows releases but remains a useful fallback
  // on older installations where PowerShell/CIM is restricted by policy.
  const out = await run("wmic", [
    "path",
    "win32_VideoController",
    "get",
    "name,AdapterRAM",
    "/format:csv",
  ]);
  if (!out) return [];
  probeErrors.videoController = null;
  return parseVideoControllers(
    JSON.stringify(
      out
        .split(/\r?\n/)
        .filter((line) => line.trim() && !/Name.*AdapterRAM|Node/i.test(line))
        .map((line) => line.split(",").map((part) => part.trim()))
        .map((parts) => ({ Name: parts[2] || parts[0], AdapterRAM: Number(parts[1]) || 0 })),
    ),
  );
}

/**
 * Conservative worker plan:
 * - keep at least one physical core free for the UI
 * - never claim more than 70% of system RAM
 * - only offload layers to the GPU when there is real VRAM headroom
 */
function buildPlan({ cpuCount, physicalCores = null, totalMemGb, gpus, gpuAcceleration }) {
  // Math libraries (BLAS, ONNX Runtime, CTranslate2) are fastest with one thread per PHYSICAL core; the second
  // hardware thread of a core only makes them fight. Leave one core free for the interface. Without a physical
  // count the old rule on logical threads applies.
  const threads =
    physicalCores > 0
      ? Math.max(1, physicalCores > 1 ? physicalCores - 1 : 1)
      : Math.max(1, Math.min(cpuCount - 1, Math.floor(cpuCount * 0.75)));
  const gpu = gpus[0] || null;
  const vramGb = gpu?.vramTotalMb ? Math.round((gpu.vramTotalMb / 1024) * 10) / 10 : 0;
  const gpuUsable = Boolean(gpuAcceleration && gpu && vramGb >= 2);
  const otherGpu = gpu && gpu.vendor !== "nvidia";
  return {
    backend: gpuUsable ? "gpu" : "cpu",
    reason: gpuUsable
      ? `NVIDIA driver acceleration available with ${vramGb} GB VRAM`
      : otherGpu
        ? `${gpu.name} found. FRIDAY plans on the CPU; Ollama may still use this card for local models if it supports it, and FRIDAY cannot confirm that from here`
        : gpu
          ? "GPU present but no supported acceleration runtime — running on CPU"
          : "no discrete GPU detected — running on CPU",
    threads,
    maxRamGb: Math.max(1, Math.round(totalMemGb * 0.7 * 10) / 10),
    maxVramGb: gpuUsable ? Math.max(1, Math.round(vramGb * 0.8 * 10) / 10) : 0,
    // Fall back to CPU automatically if a GPU load fails.
    fallback: "cpu",
    // Background throttling keeps the app light when it is not focused.
    backgroundThrottle: true,
  };
}

/**
 * Free space on the drive models are stored on, read straight from the file
 * system. This is what a download needs, and unlike a drive-by-drive WMI query
 * it answers at once, on every platform, and never comes back empty.
 */
function diskFor(root) {
  const target = root && fs.existsSync(root) ? root : os.homedir();
  try {
    const stat = fs.statfsSync(target);
    return {
      path: target,
      freeGb: toGb(Number(stat.bavail) * Number(stat.bsize)),
      totalGb: toGb(Number(stat.blocks) * Number(stat.bsize)),
    };
  } catch {
    return null;
  }
}

/** The GPU that will actually run a model: a discrete NVIDIA card first, then the most video memory. */
function bestGpuFirst(gpus) {
  const rank = (gpu) => (gpu.vendor === "nvidia" ? 2 : gpu.vendor === "amd" ? 1 : 0);
  return [...gpus].sort(
    (a, b) => rank(b) - rank(a) || (Number(b.vramTotalMb) || 0) - (Number(a.vramTotalMb) || 0),
  );
}

async function detectHardware({
  root = null,
  modelCacheRoot = null,
  allowNetwork = false,
  capabilityOptions = null,
  capabilityGraceMs = CAPABILITY_GRACE_MS,
} = {}) {
  const cpus = os.cpus() || [];
  // The wider capability probes (OS build, runtimes, CPU flags, memory pressure, media type, Vulkan, CUDA files,
  // network, power) start now and run beside the probes below. They never hold this answer back for long: when they
  // are not done a moment after the others, the facts leave them null and the next call finds them cached.
  const capabilityJob = detectCapabilities({
    ...(capabilityOptions || {}),
    root,
    modelCacheRoot,
    allowNetwork,
  });
  const [nvidiaProbe, topology] = await Promise.all([detectNvidia(), detectCpuTopology()]);
  const nvidia = nvidiaProbe.gpus;
  // On Windows every card is listed, not only NVIDIA: a laptop with an Intel chip and an NVIDIA card showed
  // only the NVIDIA one. nvidia-smi is the better source for NVIDIA (live memory, load, temperature), so its
  // cards win and only the CIM entries for other vendors are added.
  const cim = process.platform === "win32" ? await detectWindowsGpus() : [];
  const found = [...nvidia, ...cim.filter((gpu) => nvidia.length === 0 || gpu.vendor !== "nvidia")];
  const gpus = bestGpuFirst(found);
  const drives = await detectDrives(root);
  // `nvcc` is resolved through CUDA_PATH and the versioned toolkit folders as
  // well as PATH — an elevated process started before a re-login never sees
  // the user PATH entry the CUDA installer adds.
  const nvcc = nvccPath();
  const cudaResult = nvcc
    ? await runProbe(nvcc, ["--version"], 8000)
    : {
        ok: false,
        stdout: null,
        error: "nvcc not found (checked PATH, CUDA_PATH and the CUDA toolkit install folders)",
      };
  probeErrors.cuda = cudaResult.ok ? null : cudaResult.error;
  const cudaVersion = cudaResult.ok ? cudaResult.stdout : null;
  const cudaToolkit = Boolean(cudaVersion);

  const nvidiaDriver = nvidia.length > 0;

  const capabilities = await withDeadline(capabilityJob, capabilityGraceMs, null);
  const totalMemGb = toGb(os.totalmem());
  const hardware = {
    detectedAt: Date.now(),
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: {
      model: cpus[0]?.model?.trim() || "unknown",
      // `cores` has always been the logical thread count; kept so nothing that reads it changes.
      cores: cpus.length,
      threads: cpus.length,
      physicalCores: topology?.physical ?? null,
      speedMhz: cpus[0]?.speed || null,
    },
    memory: { totalGb: totalMemGb, freeGb: toGb(os.freemem()) },
    disk: diskFor(root),
    drives,
    gpus,
    cuda: {
      // `nvcc` proves the toolkit is installed. An NVIDIA display driver alone
      // can accelerate bundled engines, but must not be labelled CUDA toolkit.
      available: cudaToolkit,
      version: cudaVersion ? (/release ([\d.]+)/.exec(cudaVersion)?.[1] ?? null) : null,
      driverAvailable: nvidiaDriver,
      // The newest CUDA the display driver supports (nvidia-smi header); not the toolkit, never cuDNN.
      driverCudaVersion: nvidiaProbe.cudaDriverVersion,
      toolkitAvailable: cudaToolkit,
      reason: cudaToolkit ? null : probeErrors.cuda,
    },
    // Real reasons for anything that could not be measured, so the UI can say
    // WHY instead of silently rendering a blank value.
    probes: { ...probeErrors },
    // The wider capability probes (see detectCapabilities); null while they are still measuring.
    capabilities,
  };

  hardware.plan = buildPlan({
    cpuCount: cpus.length || 1,
    physicalCores: topology?.physical ?? null,
    totalMemGb,
    gpus,
    gpuAcceleration: nvidiaDriver,
  });
  return hardware;
}

// ---------------------------------------------------------------------------------------------------------------
// Capability probes: the rest of the PC (Windows build, runtimes, CPU instruction sets, memory and disk pressure,
// media type, Vulkan, the CUDA files, the network and the power state). Every probe is a pure parser over text a
// command printed, so the tests feed it real Windows output; every command is asynchronous, has its own timeout and a
// deadline around it, and its answer is cached, so nothing here can hang the main process or run on a UI path.
// Not measured is null, never a guess, and nothing branches on a card's marketing name.
// ---------------------------------------------------------------------------------------------------------------

const CAPABILITY_STATIC_TTL_MS = 10 * 60_000; // Windows build, CPU flags, runtimes, drive media: change on reinstall
const CAPABILITY_DYNAMIC_TTL_MS = 20_000; // memory, power, network: change while FRIDAY runs
const CAPABILITY_CUDA_TTL_MS = 10 * 60_000; // the CUDA files change only when the owner installs a runtime
const CAPABILITY_SCRIPT_TIMEOUT_MS = 20_000;
const CAPABILITY_FS_TIMEOUT_MS = 1_500; // one stat of one folder; a dead network share in PATH must not stall the rest
const CUDA_MAX_DIRS = 40; // folders looked at, however long PATH is
const CUDA_STAT_CONCURRENCY = 4; // libuv has four file threads; a dead share must not hold all of them
const CAPABILITY_GRACE_MS = 2_500; // how long detectHardware waits for the probes after its own are done

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const boolOrNull = (v) => (typeof v === "boolean" ? v : null);
const textOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
// Numbers only: null, booleans and blank text are "not measured" (Number(null) is 0 and Number(true) is 1).
const numberOrNaN = (v) =>
  typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN;
const wholeOrNull = (v) => {
  const n = numberOrNaN(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Resolves with the work's answer, or with `fallback` when it takes longer than `ms` or throws. Never rejects. `work`
 * is a promise or a function returning one: a function is called inside, so even a synchronous throw is caught.
 */
function withDeadline(work, ms, fallback = null) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    Promise.resolve()
      .then(() => (typeof work === "function" ? work() : work))
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(fallback);
        },
      );
  });
}

/** The first JSON object in a command's output (a banner or BOM before it is skipped); null when there is none. */
function parseJsonObject(text) {
  const raw = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
  const start = raw.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(start));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

// ---- 1. Windows ---------------------------------------------------------------------------------------------------

// Windows 11 is the 10.0 line from build 22000 on (Microsoft's build table); the registry still says "Windows 10".
const WINDOWS_11_FIRST_BUILD = 22000;

/**
 * The OS from `os.release()` ("10.0.22631"), the architecture and the registry values of
 * HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion ({ProductName, DisplayVersion, CurrentBuildNumber, UBR, EditionID}).
 */
function parseOsInfo({
  platform = process.platform,
  release = "",
  arch = "",
  env = {},
  registry = null,
} = {}) {
  const reg = isRecord(registry) ? registry : {};
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(String(release || ""));
  const windows = platform === "win32";
  const build = windows
    ? (wholeOrNull(reg.CurrentBuildNumber) ?? (parts ? Number(parts[3]) : null))
    : null;
  const ubr = windows ? wholeOrNull(reg.UBR) : null;
  const major = parts ? Number(parts[1]) : null;
  const windows11 =
    windows && build !== null && major === 10 ? build >= WINDOWS_11_FIRST_BUILD : null;
  let name = windows ? textOrNull(reg.ProductName) : null;
  if (name && windows11) name = name.replace(/Windows 10/i, "Windows 11");
  if (!name && windows11 !== null) name = windows11 ? "Windows 11" : "Windows 10";
  const x86 = /^(ia32|x86)$/i.test(String(arch));
  return {
    platform: textOrNull(platform),
    ntVersion: windows && parts ? `${parts[1]}.${parts[2]}.${parts[3]}` : null,
    build,
    ubr,
    buildFull: build !== null && ubr !== null ? `${build}.${ubr}` : null,
    name,
    displayVersion: windows ? textOrNull(reg.DisplayVersion) : null,
    edition: windows ? textOrNull(reg.EditionID) : null,
    windows11,
    // A 32-bit process on a 64-bit Windows reports PROCESSOR_ARCHITEW6432.
    is64Bit: /^(x64|arm64)$/i.test(String(arch))
      ? true
      : x86
        ? Boolean(env && env["PROCESSOR_ARCHITEW6432"])
        : null,
    arch: textOrNull(arch),
    webview2: null,
    vcRuntimeX64: null,
  };
}

/** WebView2 is installed when a `pv` value other than empty or 0.0.0.0 exists under any of the three client keys. */
function parseWebView2(pvList) {
  if (!Array.isArray(pvList) && typeof pvList !== "string") return null;
  return asList(pvList).some((pv) => {
    const text = String(pv ?? "").trim();
    return text !== "" && !/^0(\.0)*$/.test(text);
  });
}

/** The Visual C++ 14.x x64 runtime: `Installed` is 1 under HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64. */
function parseVcRuntime(vc) {
  if (!isRecord(vc)) return null;
  const installed = numberOrNaN(vc.installed ?? vc.Installed);
  return Number.isFinite(installed) ? installed === 1 : null;
}

// ---- 2. CPU --------------------------------------------------------------------------------------------------------

/** Instruction-set flags from a /proc/cpuinfo "flags" line (Linux). Null for each flag when there is no flags line. */
function parseCpuFlagsFromCpuinfo(text) {
  const line = /^flags\s*:\s*(.+)$/m.exec(String(text ?? ""))?.[1];
  if (!line) return { avx: null, avx2: null, avx512: null, fma: null, source: null };
  const flags = new Set(line.trim().split(/\s+/));
  return {
    avx: flags.has("avx"),
    avx2: flags.has("avx2"),
    avx512: flags.has("avx512f"),
    fma: flags.has("fma"),
    source: "cpuinfo",
  };
}

/** What the static script printed for the CPU: model, cores, base clock and the instruction-set flags. */
function parseCpuInfo(cpu, arch = "") {
  const c = isRecord(cpu) ? cpu : {};
  const feat = isRecord(c.feat) ? c.feat : {};
  // The processor-feature calls describe x86; on an Arm PC they would read "absent", which is not a measurement.
  const x86 = !/^arm/i.test(String(arch));
  const flag = (v) => (x86 ? boolOrNull(v) : null);
  return {
    model: textOrNull(c.name),
    physicalCores: wholeOrNull(c.cores),
    logicalCores: wholeOrNull(c.logical),
    baseClockMhz: wholeOrNull(c.maxMhz),
    avx: flag(feat.avx),
    avx2: flag(feat.avx2),
    avx512: flag(feat.avx512),
    fma: flag(feat.fma),
    flagsSource: x86 ? textOrNull(feat.src) : null,
  };
}

// ---- 3. memory and disks -------------------------------------------------------------------------------------------

// The same lines kernel/stt.py memory_pressure draws: a share of the total, never below a floor or above a ceiling (MB).
const PRESSURE_HIGH_RULE = [0.15, 2048, 3072];
const PRESSURE_CRITICAL_RULE = [0.07, 1024, 1536];
const pressureLine = ([share, floor, ceiling], totalMb) =>
  Math.min(ceiling, Math.max(floor, totalMb * share));

/** ok | high | critical from the memory still available; null when either figure is not measured. */
function memoryPressure(availableMb, totalMb) {
  const available = numberOrNaN(availableMb);
  const total = numberOrNaN(totalMb);
  if (!(total > 0) || !Number.isFinite(available) || available < 0 || available > total * 1.05) {
    return null;
  }
  if (available < pressureLine(PRESSURE_CRITICAL_RULE, total)) return "critical";
  if (available < pressureLine(PRESSURE_HIGH_RULE, total)) return "high";
  return "ok";
}

/** Win32_OperatingSystem's kilobyte counters: physical memory, and the commit limit with what is still free of it. */
function parseMemoryCounters(mem, pagefile) {
  const m = isRecord(mem) ? mem : {};
  const totalKb = positive(m.totalKb);
  const freeKb = numberOrNaN(m.freeKb);
  const limitKb = positive(m.commitLimitKb);
  const commitFreeKb = numberOrNaN(m.commitFreeKb);
  const pf = isRecord(pagefile) ? pagefile : null;
  const kbToGb = (kb) => round1(kb / 1024 / 1024);
  return {
    totalGb: totalKb !== null ? kbToGb(totalKb) : null,
    freeGb: totalKb !== null && Number.isFinite(freeKb) && freeKb >= 0 ? kbToGb(freeKb) : null,
    commitLimitGb: limitKb !== null ? kbToGb(limitKb) : null,
    commitFreeGb:
      limitKb !== null && Number.isFinite(commitFreeKb) && commitFreeKb >= 0
        ? kbToGb(commitFreeKb)
        : null,
    commitPressure:
      limitKb !== null && Number.isFinite(commitFreeKb)
        ? memoryPressure(commitFreeKb / 1024, limitKb / 1024)
        : null,
    pagefileCount: pf ? wholeOrNull(pf.count) : null,
    pagefileGb:
      pf && positive(pf.allocatedMb) !== null ? round1(positive(pf.allocatedMb) / 1024) : null,
  };
}

/** SSD or HDD from Get-PhysicalDisk's MediaType (a name, or the MSFT_PhysicalDisk number 3 HDD, 4 SSD, 5 SCM). */
function mediaOf(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "ssd" || text === "4") return "ssd";
  if (text === "hdd" || text === "3") return "hdd";
  if (text === "scm" || text === "5") return "scm";
  return null; // Unspecified, 0, empty: a virtual disk or a driver that does not say
}

/** The disk bus from Get-PhysicalDisk's BusType (a name, or the number 17 NVMe, 11 SATA, 7 USB, 8 RAID). */
function busOf(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  const byNumber = { 17: "nvme", 11: "sata", 7: "usb", 8: "raid", 3: "ata", 10: "sas" };
  if (byNumber[text]) return byNumber[text];
  return /^(nvme|sata|usb|raid|ata|sas|scsi)$/.test(text) ? text : null;
}

/** [{letter:'C:', media, bus}] from the static script's partition-to-disk join. */
function parseStorageMedia(rows) {
  const out = [];
  for (const row of asList(rows)) {
    if (!isRecord(row)) continue;
    const letter = /^([A-Za-z])/.exec(String(row.letter ?? ""))?.[1];
    if (!letter) continue;
    out.push({
      letter: `${letter.toUpperCase()}:`,
      media: mediaOf(row.media),
      bus: busOf(row.bus),
    });
  }
  return out;
}

/** The drive letter of a path ("D:\\FRIDAY\\models" is "D:"); null for a relative, UNC or non-Windows path. */
function driveOf(target) {
  const letter = /^([A-Za-z]):[\\/]/.exec(String(target ?? ""))?.[1];
  return letter ? `${letter.toUpperCase()}:` : null;
}

// ---- 4. GPU extras and CUDA files ---------------------------------------------------------------------------------

/** A driver date as "YYYY-MM-DD" from an ISO text, a WMI "yyyymmdd..." stamp or a "/Date(ms)/" JSON value; else null. */
function parseDriverDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text) || /^(\d{4})(\d{2})(\d{2})\d{0,6}\./.exec(text);
  const stamp = /\/Date\((-?\d+)/.exec(text);
  const date = iso
    ? new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
    : stamp
      ? new Date(Number(stamp[1]))
      : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < 1995 || year > 2100) return null;
  return date.toISOString().slice(0, 10);
}

/** [{name, driverDate}] for the display adapters the static script listed. */
function parseGpuExtras(rows) {
  const out = [];
  for (const row of asList(rows)) {
    if (!isRecord(row)) continue;
    const name = textOrNull(row.name);
    if (name) out.push({ name, driverDate: parseDriverDate(row.driverDate) });
  }
  return out;
}

/** Vulkan is usable when the loader is installed and no driver list says there are none; null when not measured. */
function vulkanVerdict(loaderPresent, driverCount) {
  if (loaderPresent === null || loaderPresent === undefined) return null;
  if (loaderPresent !== true) return false;
  return driverCount === 0 ? false : true;
}

const CUDA_NAMES = {
  win32: { cublas: "cublas64_12.dll", cudnn: "cudnn64_9.dll" },
  posix: { cublas: "libcublas.so.12", cudnn: "libcudnn.so.9" },
};

/** A Windows folder on a network share (UNC, `\\?\UNC\`, forward-slash form) is never searched: a dead share hangs a file thread. */
function isUncDir(dir) {
  return /^[\\/]{2}/.test(dir);
}

/** The drive letter of a Windows folder ("d:\\x" is "D:"); null when it has none. */
function dirDrive(dir) {
  const letter = /^([A-Za-z]):/.exec(dir)?.[1];
  return letter ? `${letter.toUpperCase()}:` : null;
}

/**
 * Every folder FRIDAY's speech engine looks in (kernel/stt.py cuda_runtime_ready: PATH, LD_LIBRARY_PATH, CUDA_PATH
 * bin and lib64, the pip packages nvidia-cublas-cu12 and nvidia-cudnn-cu12 inside the FRIDAY Python environment) plus
 * System32, in the order they are searched, without duplicates (Windows compares names case-insensitively). On Windows
 * only local drives are searched: UNC shares are skipped, and a drive letter must be one of `localDrives` (the
 * partitions the storage probe listed); when that list is unknown only the Windows drive and the drives of the
 * FRIDAY Python environments are trusted. At most CUDA_MAX_DIRS folders: the specific ones (CUDA_PATH, the
 * environments, System32) are kept and the long PATH is cut.
 */
async function cudaSearchDirs({
  platform,
  env,
  venvRoots = [],
  fsApi,
  pathApi,
  localDrives = null,
}) {
  const win = platform === "win32";
  const delimiter = win ? ";" : ":";
  const pathDirs = [];
  for (const key of ["PATH", "LD_LIBRARY_PATH"]) {
    for (const part of String(env?.[key] ?? env?.[key === "PATH" ? "Path" : key] ?? "").split(
      delimiter,
    )) {
      const dir = part.trim().replace(/^"|"$/g, "");
      if (dir) pathDirs.push(dir);
    }
  }
  const fixedDirs = [];
  const cuda = String(env?.["CUDA_PATH"] ?? "").trim();
  if (cuda) fixedDirs.push(pathApi.join(cuda, "bin"), pathApi.join(cuda, "lib64"));
  for (const venv of venvRoots) {
    if (!venv) continue;
    const sites = [];
    if (win) sites.push(pathApi.join(venv, "Lib", "site-packages"));
    else {
      const lib = pathApi.join(venv, "lib");
      const entries = await withDeadline(() => fsApi.readdir(lib), CAPABILITY_FS_TIMEOUT_MS, []);
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (/^python\d/.test(String(entry)))
          sites.push(pathApi.join(lib, String(entry), "site-packages"));
      }
    }
    for (const site of sites) {
      for (const pkg of ["cublas", "cudnn"]) {
        fixedDirs.push(pathApi.join(site, "nvidia", pkg, win ? "bin" : "lib"));
      }
    }
  }
  const system = String(env?.["SystemRoot"] ?? env?.["windir"] ?? "C:\\Windows");
  if (win) fixedDirs.push(pathApi.join(system, "System32"));

  let allowed = null;
  if (win) {
    const known = Array.isArray(localDrives) && localDrives.length > 0;
    allowed = new Set(
      (known ? localDrives : [dirDrive(system)])
        .map((d) => dirDrive(String(d ?? "")))
        .filter(Boolean),
    );
    for (const venv of venvRoots) {
      const drive = dirDrive(String(venv ?? ""));
      if (drive) allowed.add(drive);
    }
  }
  const keyOf = (dir) => (win ? dir.replace(/[\\/]+$/, "").toLowerCase() : dir);
  const usable = (dir) => {
    if (!win) return true;
    if (isUncDir(dir)) return false;
    const drive = dirDrive(dir);
    return drive === null || allowed.has(drive);
  };
  const seen = new Set();
  const take = (list) => {
    const out = [];
    for (const dir of list) {
      const key = keyOf(dir);
      if (seen.has(key) || !usable(dir)) continue;
      seen.add(key);
      out.push(dir);
    }
    return out;
  };
  const fixed = take(fixedDirs).slice(0, CUDA_MAX_DIRS);
  return [...take(pathDirs).slice(0, CUDA_MAX_DIRS - fixed.length), ...fixed];
}

/**
 * Looks for the two CUDA 12 files without loading them: a stat per file with its own deadline, at most
 * CUDA_STAT_CONCURRENCY at once, and once a stat on a drive timed out the rest of that drive is skipped. Returns
 * { cublas12, cudnn9, dllDirs, runtimeFilesFound }; the two booleans are null when the whole search timed out, and the
 * workers stop starting new stats then.
 */
async function findCudaRuntimeFiles({
  platform = process.platform,
  env = process.env,
  venvRoots = [],
  fsApi = fs.promises,
  totalMs = 6_000,
  localDrives = null,
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32" ? CUDA_NAMES.win32 : CUDA_NAMES.posix;
  const state = { stopped: false };
  const search = async () => {
    const dirs = await cudaSearchDirs({ platform, env, venvRoots, fsApi, pathApi, localDrives });
    const hits = dirs.map((dir) => ({ dir, cublas: false, cudnn: false }));
    const tasks = [];
    for (const hit of hits) {
      tasks.push({ hit, field: "cublas", name: names.cublas });
      tasks.push({ hit, field: "cudnn", name: names.cudnn });
    }
    const deadDrives = new Set();
    let next = 0;
    const worker = async () => {
      while (!state.stopped && next < tasks.length) {
        const task = tasks[next++];
        const drive = platform === "win32" ? dirDrive(task.hit.dir) : null;
        if (drive && deadDrives.has(drive)) continue;
        const answer = await withDeadline(
          () =>
            Promise.resolve(fsApi.stat(pathApi.join(task.hit.dir, task.name))).then(
              (s) => Boolean(s && s.isFile()),
              () => false,
            ),
          CAPABILITY_FS_TIMEOUT_MS,
          null,
        );
        if (answer === null && drive) deadDrives.add(drive);
        task.hit[task.field] = answer === true;
      }
    };
    await Promise.all(Array.from({ length: CUDA_STAT_CONCURRENCY }, worker));
    const dllDirs = hits.filter((h) => h.cublas || h.cudnn).map((h) => h.dir);
    const cublas12 = hits.some((h) => h.cublas);
    const cudnn9 = hits.some((h) => h.cudnn);
    return { cublas12, cudnn9, dllDirs, runtimeFilesFound: cublas12 && cudnn9 };
  };
  const result = await withDeadline(search(), totalMs, {
    cublas12: null,
    cudnn9: null,
    dllDirs: [],
    runtimeFilesFound: null,
  });
  state.stopped = true;
  return result;
}

// ---- 6. power ------------------------------------------------------------------------------------------------------

// Power plan ids are fixed by Windows, so the kind never depends on the (translated) plan name.
const POWER_PLAN_KIND = {
  "381b4222-f694-41f0-9685-ff5bb260df2e": "balanced",
  "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c": "high-performance",
  "a1841308-3541-4fab-bc81-f71556f20b4a": "power-saver",
  "e9a42b02-d5df-448d-aa00-03f14749eb61": "ultimate-performance",
};

/** Win32_Battery.BatteryStatus: 1 discharging, 4 low and 5 critical run on the battery; 2, 3 and 6 to 9 are on mains. */
function onAcFromBatteryStatus(status) {
  const n = numberOrNaN(status);
  if ([1, 4, 5].includes(n)) return false;
  if ([2, 3, 6, 7, 8, 9].includes(n)) return true;
  return null;
}

/** The dynamic script's battery, plan and battery-saver values (EnergySaverStatus: 0 Disabled, 1 Off, 2 On). */
function parsePower(battery, plan, saver) {
  const b = isRecord(battery) ? battery : null;
  const present = b ? boolOrNull(b.present) : null;
  const percent = b && present ? positive(b.percent) : null;
  const planId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    String(isRecord(plan) ? (plan.id ?? "") : ""),
  )?.[1];
  const saverCode = numberOrNaN(saver);
  return {
    batteryPresent: present,
    batteryPercent: percent !== null && percent <= 100 ? Math.round(percent) : null,
    onAc: present === false ? true : present ? onAcFromBatteryStatus(b.status) : null,
    planName: isRecord(plan) ? textOrNull(plan.name) : null,
    planKind: planId ? (POWER_PLAN_KIND[planId.toLowerCase()] ?? null) : null,
    batterySaver: saverCode === 2 ? true : saverCode === 0 || saverCode === 1 ? false : null,
    thermal: null,
  };
}

/** Electron's powerMonitor thermal state ("nominal" | "fair" | "serious" | "critical"); "unknown" is not measured. */
function thermalOf(state) {
  const text = String(state ?? "").toLowerCase();
  return ["nominal", "fair", "serious", "critical"].includes(text) ? text : null;
}

// ---- the two scripts -----------------------------------------------------------------------------------------------
// One PowerShell start answers every Windows-only question of its group. Each part sits in its own try block, so a
// part that fails leaves its key out (read as "not measured") instead of ending the whole answer.

const STATIC_SCRIPT = String.raw`$ErrorActionPreference='Stop'; $o=@{}; try { $k=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'; $o.os=@{ProductName=$k.ProductName;DisplayVersion=$k.DisplayVersion;CurrentBuildNumber=$k.CurrentBuildNumber;UBR=$k.UBR;EditionID=$k.EditionID} } catch {}; try { $g='{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'; $pv=@(); foreach($p in @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\','HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\','HKCU:\Software\Microsoft\EdgeUpdate\Clients\')){ $r=Get-ItemProperty ($p+$g) -ErrorAction SilentlyContinue; if($r -and $r.pv){ $pv+=[string]$r.pv } }; $o.webview2=@($pv) } catch {}; try { $v=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue; $o.vc=@{installed=[int]($v.Installed -eq 1);version=[string]$v.Version} } catch {}; try { $c=@(Get-CimInstance Win32_Processor); $f=@{avx=$null;avx2=$null;avx512=$null;fma=$null;src=$null}; try { $f.avx=[bool][System.Runtime.Intrinsics.X86.Avx]::IsSupported; $f.avx2=[bool][System.Runtime.Intrinsics.X86.Avx2]::IsSupported; $f.fma=[bool][System.Runtime.Intrinsics.X86.Fma]::IsSupported; $f.src='intrinsics'; try { $f.avx512=[bool][System.Runtime.Intrinsics.X86.Avx512F]::IsSupported } catch {} } catch { try { Add-Type -Namespace Fr -Name Pf -MemberDefinition ('[DllImport(' + [char]34 + 'kernel32.dll' + [char]34 + ')] public static extern bool IsProcessorFeaturePresent(uint f);'); $f.avx=[bool][Fr.Pf]::IsProcessorFeaturePresent(39); $f.avx2=[bool][Fr.Pf]::IsProcessorFeaturePresent(40); $f.avx512=[bool][Fr.Pf]::IsProcessorFeaturePresent(41); $f.src='IsProcessorFeaturePresent' } catch {} }; $o.cpu=@{name=$c[0].Name;cores=($c|Measure-Object NumberOfCores -Sum).Sum;logical=($c|Measure-Object NumberOfLogicalProcessors -Sum).Sum;maxMhz=$c[0].MaxClockSpeed;feat=$f} } catch {}; try { $pds=@(Get-PhysicalDisk); $s=@(); foreach($p in @(Get-Partition | Where-Object { [string]$_.DriveLetter -match '[A-Za-z]' })){ $d=$pds | Where-Object { [string]$_.DeviceId -eq [string]$p.DiskNumber } | Select-Object -First 1; $s+=@{letter=([string]$p.DriveLetter)+':';media=[string]$d.MediaType;bus=[string]$d.BusType} }; $o.storage=@($s) } catch {}; try { $vk=Get-Item 'HKLM:\SOFTWARE\Khronos\Vulkan\Drivers' -ErrorAction SilentlyContinue; $o.vulkanIcds=if($vk){ @($vk.Property | Where-Object { (Get-ItemPropertyValue -Path $vk.PSPath -Name $_) -eq 0 }).Count } else { 0 } } catch {}; try { $o.video=@(Get-CimInstance Win32_VideoController | ForEach-Object { @{name=$_.Name;driverDate=$(if($_.DriverDate){ $_.DriverDate.ToString('yyyy-MM-dd',[System.Globalization.CultureInfo]::InvariantCulture) } else { $null })} }) } catch {}; $o | ConvertTo-Json -Depth 5 -Compress`;

const DYNAMIC_HEAD = String.raw`$ErrorActionPreference='Stop'; $o=@{}; try { $w=Get-CimInstance Win32_OperatingSystem; $o.mem=@{totalKb=$w.TotalVisibleMemorySize;freeKb=$w.FreePhysicalMemory;commitLimitKb=$w.TotalVirtualMemorySize;commitFreeKb=$w.FreeVirtualMemory} } catch {}; try { $pf=@(Get-CimInstance Win32_PageFileUsage); $o.pagefile=@{count=$pf.Count;allocatedMb=($pf|Measure-Object AllocatedBaseSize -Sum).Sum} } catch {}; try { $b=@(Get-CimInstance Win32_Battery); $o.battery=@{present=($b.Count -gt 0);percent=$b[0].EstimatedChargeRemaining;status=$b[0].BatteryStatus} } catch {}; try { $pp=Get-CimInstance -Namespace root\cimv2\power -ClassName Win32_PowerPlan | Where-Object { $_.IsActive } | Select-Object -First 1; $o.plan=@{name=$pp.ElementName;id=$pp.InstanceID} } catch {}; try { [void][Windows.System.Power.PowerManager,Windows.System.Power,ContentType=WindowsRuntime]; $o.saver=[int][Windows.System.Power.PowerManager]::EnergySaverStatus } catch {};`;

/** The memory, power and network script: the connection fragment lives in net-status.cjs, its one owner. */
const dynamicScript = () =>
  `${DYNAMIC_HEAD} ${require("./net-status.cjs").CONNECTION_SCRIPT} $o | ConvertTo-Json -Depth 5 -Compress`;

// ---- the probe groups, their cache and the public entry point ------------------------------------------------------

function capabilityDeps(options = {}) {
  return {
    platform: options.platform || process.platform,
    os: options.os || os,
    env: options.env || process.env,
    fsApi: options.fsApi || fs.promises,
    runPowerShell: options.runPowerShell || runPowerShell,
    now: typeof options.now === "function" ? options.now : Date.now,
    root: options.root || null,
    modelCacheRoot: options.modelCacheRoot || null,
    venvRoots: Array.isArray(options.venvRoots) ? options.venvRoots : [],
    allowNetwork: options.allowNetwork === true,
    timed: typeof options.timedProbe === "function" ? options.timedProbe : undefined,
    cache: options.cache || capabilityCache,
    connection: options.connectionProbe || null,
  };
}

/** Runs one PowerShell script and parses its JSON. Never throws; a failure carries the reason the owner can read. */
async function runCapabilityScript(d, script) {
  try {
    const result = await withDeadline(
      d.runPowerShell(script, CAPABILITY_SCRIPT_TIMEOUT_MS),
      CAPABILITY_SCRIPT_TIMEOUT_MS + 3_000,
      { ok: false, stdout: null, error: "the probe did not answer in time" },
    );
    if (!result || result.ok !== true) {
      return { value: null, error: textOrNull(result?.error) ?? "the probe failed" };
    }
    const value = parseJsonObject(result.stdout);
    return value
      ? { value, error: null }
      : { value: null, error: "the probe printed no usable JSON" };
  } catch (error) {
    return { value: null, error: textOrNull(error?.message) ?? "the probe failed" };
  }
}

/** Stats one file: true or false when the system answered, null when it did not answer in time or refused. */
function fileExists(fsApi, target) {
  return withDeadline(
    () =>
      Promise.resolve(fsApi.stat(target)).then(
        (stat) => Boolean(stat && (typeof stat.isFile !== "function" || stat.isFile())),
        (error) => (error && error.code === "ENOENT" ? false : null),
      ),
    CAPABILITY_FS_TIMEOUT_MS,
    null,
  );
}

async function probeStaticCapabilities(d) {
  const win = d.platform === "win32";
  const script = win ? await runCapabilityScript(d, STATIC_SCRIPT) : { value: null, error: null };
  const sv = script.value || {};
  const arch = String(d.os.arch?.() ?? "");
  const osInfo = parseOsInfo({
    platform: d.platform,
    release: String(d.os.release?.() ?? ""),
    arch,
    env: d.env,
    registry: sv.os,
  });
  osInfo.webview2 = win ? parseWebView2(sv.webview2) : null;
  osInfo.vcRuntimeX64 = win ? parseVcRuntime(sv.vc) : null;

  let cpu = parseCpuInfo(sv.cpu, arch);
  if (d.platform === "linux") {
    const text = await withDeadline(
      () => d.fsApi.readFile("/proc/cpuinfo", "utf8"),
      CAPABILITY_FS_TIMEOUT_MS,
      "",
    );
    const flags = parseCpuFlagsFromCpuinfo(text);
    cpu = { ...cpu, ...flags, flagsSource: flags.source };
  }

  let loaderPresent = null;
  if (win) {
    const system = String(d.env["SystemRoot"] ?? d.env["windir"] ?? "C:\\Windows");
    loaderPresent = await fileExists(d.fsApi, path.win32.join(system, "System32", "vulkan-1.dll"));
  }
  const icds = numberOrNaN(sv.vulkanIcds);
  return {
    os: osInfo,
    cpu,
    storage: parseStorageMedia(sv.storage),
    gpuExtras: parseGpuExtras(sv.video),
    vulkan: {
      loaderPresent,
      driverCount: Number.isInteger(icds) && icds >= 0 ? icds : null,
    },
    error: script.error,
  };
}

/**
 * The CUDA files are searched at most once in CUDA_TTL (a search that timed out is retried after a minute), and again
 * at once only when what it depends on changed (PATH, CUDA_PATH, the environments, the local drives). The local drives
 * come from the static group (partitions), which is already cached; if it has none the search trusts fewer drives.
 */
async function cachedCudaFiles(d, venvs) {
  const st = await cachedGroup(
    d.cache.static,
    CAPABILITY_STATIC_TTL_MS,
    d,
    probeStaticCapabilities,
  );
  const localDrives = d.platform === "win32" ? (st?.storage ?? []).map((row) => row.letter) : null;
  const slot = d.cache.cuda;
  const key = JSON.stringify([
    d.platform,
    d.env?.["PATH"] ?? d.env?.["Path"] ?? "",
    d.env?.["LD_LIBRARY_PATH"] ?? "",
    d.env?.["CUDA_PATH"] ?? "",
    venvs,
    localDrives,
  ]);
  if (!slot.job && slot.key !== key) {
    slot.value = null;
    slot.key = key;
  }
  const group = await cachedGroup(slot, CAPABILITY_CUDA_TTL_MS, d, async () => {
    const cuda = await findCudaRuntimeFiles({
      platform: d.platform,
      env: d.env,
      venvRoots: venvs,
      fsApi: d.fsApi,
      localDrives,
    });
    return { cuda, error: cuda.runtimeFilesFound === null ? "the CUDA search timed out" : null };
  });
  return group.cuda;
}

async function probeDynamicCapabilities(d) {
  const win = d.platform === "win32";
  const venvs = d.venvRoots.length
    ? d.venvRoots
    : d.root
      ? [path.join(d.root, "runtime", ".venv"), path.join(d.root, ".venv")]
      : [];
  const [script, cuda] = await Promise.all([
    win ? runCapabilityScript(d, dynamicScript()) : { value: null, error: null },
    cachedCudaFiles(d, venvs),
  ]);
  const sv = script.value || {};
  return {
    memory: parseMemoryCounters(win ? sv.mem : null, win ? sv.pagefile : null),
    power: parsePower(win ? sv.battery : null, win ? sv.plan : null, win ? sv.saver : null),
    connection: win ? require("./net-status.cjs").parseConnection(sv.net, sv.netAdapter) : null,
    cuda,
    error: script.error,
  };
}

function createCapabilityCache() {
  return {
    static: { at: 0, value: null, job: null },
    dynamic: { at: 0, value: null, job: null },
    cuda: { at: 0, value: null, job: null, key: null },
  };
}
const capabilityCache = createCapabilityCache();

// A failed group is tried again after a minute at most, so a slow or blocked probe is not re-run on every call.
async function cachedGroup(slot, ttlMs, d, produce) {
  const now = d.now();
  if (slot.value) {
    const ttl = slot.value.error ? Math.min(ttlMs, 60_000) : ttlMs;
    if (now - slot.at >= 0 && now - slot.at < ttl) return slot.value;
  }
  slot.job ??= produce(d)
    .then((value) => {
      slot.value = value;
      slot.at = d.now();
      return value;
    })
    .finally(() => {
      slot.job = null;
    });
  return slot.job;
}

/**
 * Everything beyond the graphics card that decides what FRIDAY can run: OS build and runtimes, CPU flags, memory and
 * disk, Vulkan, CUDA files, network and power. Cheap to call again (static facts are kept 10 minutes, the rest 20
 * seconds, the CUDA files 10 minutes), asynchronous, bounded by deadlines, and never throws: a probe that fails leaves its facts null and says why
 * in `probes`. Returns null only if the whole thing could not run.
 */
async function detectCapabilities(options = {}) {
  const d = capabilityDeps(options);
  const work = (async () => {
    const [st, dy] = await Promise.all([
      cachedGroup(d.cache.static, CAPABILITY_STATIC_TTL_MS, d, probeStaticCapabilities),
      cachedGroup(d.cache.dynamic, CAPABILITY_DYNAMIC_TTL_MS, d, probeDynamicCapabilities),
    ]);
    let network = null;
    try {
      network = await require("./net-status.cjs").networkFacts({
        connection: dy.connection,
        allowNetwork: d.allowNetwork,
        now: d.now(),
        timed: d.timed,
      });
    } catch {
      network = null;
    }
    return {
      detectedAt: d.now(),
      os: st.os,
      cpu: st.cpu,
      memory: dy.memory,
      storage: st.storage,
      dataRootDrive: driveOf(d.root),
      modelCacheDrive: driveOf(d.modelCacheRoot || d.root),
      vulkan: st.vulkan,
      gpuExtras: st.gpuExtras,
      cuda: dy.cuda,
      network,
      power: dy.power,
      probes: { static: st.error, dynamic: dy.error },
    };
  })();
  return withDeadline(work, CAPABILITY_SCRIPT_TIMEOUT_MS * 2, null);
}

// ---------------------------------------------------------------------------------------------------------------
// hardwareFacts: what the model router may know about this PC. Pure and injectable: it reads the object
// detectHardware() returned (plus optional live values and Electron's gpuInfo) and never probes, never throws.
// Nothing here branches on a card's marketing name: only vendor, driver number and measured sizes count.
// ---------------------------------------------------------------------------------------------------------------

/** A finite positive number, or null. Strings, NaN, negatives and zero are "not measured". */
const positive = (value) => {
  const n = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

// PCI vendor ids (a fact of the bus, not a card name) for Electron's gpuInfo.
const PCI_VENDOR = { 0x10de: "nvidia", 0x1002: "amd", 0x1022: "amd", 0x8086: "intel" };

// NVIDIA's display driver 527 (Windows) is the first that runs CUDA 12 applications.
const CUDA12_MIN_DRIVER_MAJOR = 527;

function cpuClassOf(cpu) {
  const physical = positive(cpu?.physicalCores);
  const threads = positive(cpu?.threads) ?? positive(cpu?.cores);
  const cores = physical ?? (threads ? Math.max(1, Math.ceil(threads / 2)) : null);
  // No CPU reading is "not measured", never "weak": a guessed class would demote models on an unknown PC.
  if (cores === null) return null;
  return cores <= 4 ? "low" : cores <= 8 ? "mid" : "high";
}

// Graphics parts that borrow system memory: their "dedicated memory" is a carve-out of RAM, not video memory. Read
// from structure, never from a card's name: an integrated part always shares; an AMD or Intel part beside a larger
// card (the integrated part next to a discrete one) shares; so does one whose figure is more than half the RAM. An
// NVIDIA card never does. Not measured, or a vendor FRIDAY has no rule for, is null. A carve-out of 6 GB or more
// that is under half the RAM cannot be told from a small card by facts alone; the plan marks such a card's speed
// as estimated and keeps extra headroom.
function markUnifiedMemory(rows, ramGb) {
  const primary = rows
    .filter((g) => g.integrated !== true && g.vendor !== "nvidia" && g.rankGb >= 0)
    .reduce((best, g) => (!best || g.rankGb > best.rankGb ? g : best), null);
  const nvidiaBeside = rows.some((g) => g.vendor === "nvidia" && g.integrated !== true);
  for (const g of rows) {
    if (g.integrated === true) g.unifiedMemory = true;
    else if (g.vendor === "nvidia") g.unifiedMemory = false;
    else if (g.vendor !== "amd" && g.vendor !== "intel") g.unifiedMemory = null;
    else if (g.rankGb < 0) g.unifiedMemory = null;
    else if (nvidiaBeside || (primary && g !== primary)) g.unifiedMemory = true;
    else g.unifiedMemory = ramGb !== null && g.rankGb > ramGb / 2;
  }
}

function hardwareFacts(hw, deps = {}) {
  const sources = [];
  try {
    const src = hw && typeof hw === "object" ? hw : {};
    const gpuRows = [];
    for (const raw of Array.isArray(src.gpus) ? src.gpus : []) {
      if (!raw || typeof raw !== "object") continue;
      const total = positive(raw.vramTotalMb);
      const used = positive(raw.vramUsedMb);
      const vendor = typeof raw.vendor === "string" && raw.vendor ? raw.vendor : "other";
      const known = raw.vramKnown === true && total !== null;
      gpuRows.push({
        vendor,
        name: typeof raw.name === "string" && raw.name ? raw.name : null,
        // A 32-bit AdapterRAM caps at 4 GB: such a figure ranks the card but is never reported as its memory.
        vramGb: known ? round1(total / 1024) : null,
        rankGb: total !== null ? total / 1024 : -1,
        freeGb: known && used !== null && used <= total ? round1((total - used) / 1024) : null,
        // The figure exists but only from the capped 32-bit AdapterRAM reading: a lower bound, not the card's memory.
        capped: total !== null && !known,
        driver: typeof raw.driver === "string" && raw.driver ? raw.driver : null,
        // CUDA compute capability ("7.5"), NVIDIA only, from nvidia-smi on driver 510 and newer; null when unknown.
        computeCap: vendor === "nvidia" ? parseComputeCap(raw.computeCap) : null,
        fromSmi: vendor === "nvidia" && raw.vramKnown === true,
        driverDate: null,
        // Dedicated memory of 1 GB or less is an integrated part that borrows system memory; a card nvidia-smi
        // lists, or one with a larger or at-least-4-GB figure, is not. No memory figure at all is "not measured".
        integrated:
          vendor === "nvidia" && raw.vramKnown === true
            ? false
            : known
              ? total <= 1024
              : total !== null
                ? false
                : null,
        unifiedMemory: null,
      });
      sources.push(
        vendor === "nvidia" && raw.vramKnown === true ? "nvidia-smi" : "Win32_VideoController",
      );
    }
    // Electron's own GPU list: no memory figure, but it names devices and drivers no other probe found.
    const infoDevices = Array.isArray(deps?.gpuInfo?.gpuDevice) ? deps.gpuInfo.gpuDevice : [];
    let usedInfo = false;
    for (const dev of infoDevices) {
      if (!dev || typeof dev !== "object") continue;
      const vendor = PCI_VENDOR[Number(dev.vendorId)] || null;
      if (!vendor) continue;
      const driver =
        typeof dev.driverVersion === "string" && dev.driverVersion ? dev.driverVersion : null;
      const same = gpuRows.find((g) => g.vendor === vendor);
      if (same) {
        if (!same.driver && driver) {
          same.driver = driver;
          usedInfo = true;
        }
        continue;
      }
      const label =
        typeof dev.deviceString === "string" && dev.deviceString ? dev.deviceString : null;
      gpuRows.push({
        vendor,
        name: label,
        vramGb: null,
        rankGb: -1,
        freeGb: null,
        capped: false,
        driver,
        computeCap: null,
        fromSmi: false,
        driverDate: null,
        integrated: null,
        unifiedMemory: null,
      });
      usedInfo = true;
    }
    if (usedInfo) sources.push("electron-gpuInfo");
    markUnifiedMemory(gpuRows, positive(src.memory?.totalGb));

    const caps = isRecord(deps?.capabilities)
      ? deps.capabilities
      : isRecord(src.capabilities)
        ? src.capabilities
        : null;
    for (const extra of Array.isArray(caps?.gpuExtras) ? caps.gpuExtras : []) {
      const row = isRecord(extra) ? gpuRows.find((g) => g.name === extra.name) : null;
      if (row && row.driverDate === null) row.driverDate = parseDriverDate(extra.driverDate);
    }
    if (caps) sources.push("capability-probe");

    // The card a model would run on: the most dedicated memory (a capped figure still ranks), then NVIDIA, which
    // is the vendor the bundled engines can offload to.
    const ranked = [...gpuRows].sort(
      (a, b) =>
        b.rankGb - a.rankGb ||
        Number(b.vendor === "nvidia") - Number(a.vendor === "nvidia") ||
        String(a.name).localeCompare(String(b.name)),
    );
    const best = ranked[0] || null;

    const smiDriver = gpuRows.find((g) => g.fromSmi)?.driver ?? null;
    const cudaText = src.cuda && typeof src.cuda === "object" ? src.cuda.driverCudaVersion : null;
    const cudaMajor = positive(String(cudaText ?? "").split(".")[0]);
    const driverMajor = positive(String(smiDriver ?? "").split(".")[0]);
    const driverPresent =
      gpuRows.some((g) => g.vendor === "nvidia") && src.cuda?.driverAvailable === true;
    // "Ready" means the NVIDIA display driver can run CUDA 12 applications. It never says cuDNN is installed.
    const cudaReady =
      driverPresent &&
      (cudaMajor !== null
        ? cudaMajor >= 12
        : driverMajor !== null && driverMajor >= CUDA12_MIN_DRIVER_MAJOR);

    const ramGb = round1(positive(src.memory?.totalGb));
    // Free memory only means something next to a measured total: with no memory probe there is no number at all
    // (a live os.freemem() figure alone would make the router call any model too large).
    const liveFree = ramGb !== null ? positive(deps?.freeRamGb) : null;
    const ramFreeGb = ramGb !== null ? round1(liveFree ?? positive(src.memory?.freeGb)) : null;
    if (ramGb !== null) sources.push(liveFree !== null ? "os-memory-live" : "os-memory");

    const diskFreeGb = round1(positive(src.disk?.freeGb));
    if (diskFreeGb !== null) sources.push("model-drive");

    const facts = {
      vramGb: best ? best.vramGb : null,
      vramFreeGb: best ? best.freeGb : null,
      ramGb,
      ramFreeGb,
      diskFreeGb,
      gpuVendor: best ? best.vendor : null,
      gpuName: best ? best.name : null,
      gpus: ranked.map((g) => ({
        vendor: g.vendor,
        name: g.name,
        vramGb: g.vramGb,
        // True when vramGb is null only because the sole figure was the capped 32-bit one (a card of at least this size).
        vramCapped: g.capped,
        driver: g.driver,
        driverDate: g.driverDate,
        integrated: g.integrated,
        // True when the part shares system memory (integrated or APU): its vramGb is a carve-out of RAM.
        unifiedMemory: g.unifiedMemory,
        computeCap: g.computeCap,
      })),
      cudaReady,
      driverVersion: best ? best.driver : null,
      npu: src.npu === true,
      cpuClass: cpuClassOf(src.cpu),
      sources: [...new Set(sources)],
    };
    try {
      Object.assign(
        facts,
        capabilityFacts({ src, deps, caps, best, gpuCount: gpuRows.length, facts }),
      );
    } catch {
      Object.assign(facts, emptyCapabilityFacts());
    }
    facts.health = healthOf(facts);
    return facts;
  } catch {
    return {
      vramGb: null,
      vramFreeGb: null,
      ramGb: null,
      ramFreeGb: null,
      diskFreeGb: null,
      gpuVendor: null,
      gpuName: null,
      gpus: [],
      cudaReady: false,
      driverVersion: null,
      npu: false,
      cpuClass: null,
      sources: [],
      ...emptyCapabilityFacts(),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The capability half of hardwareFacts (all optional additions to the facts above): what the probes above measured,
// cleaned to a fixed shape. A missing or corrupted probe answer leaves null, never a default that looks measured.
// ---------------------------------------------------------------------------------------------------------------

const nonNegative = (value) => {
  const n = numberOrNaN(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const LEVELS = new Set(["ok", "high", "critical"]);
const levelOrNull = (v) => (LEVELS.has(v) ? v : null);

function emptyCapabilityFacts() {
  return {
    arch: null,
    os: {
      platform: null,
      ntVersion: null,
      build: null,
      ubr: null,
      buildFull: null,
      name: null,
      displayVersion: null,
      edition: null,
      windows11: null,
      is64Bit: null,
      arch: null,
      webview2: null,
      vcRuntimeX64: null,
    },
    cpu: {
      model: null,
      physicalCores: null,
      logicalCores: null,
      baseClockMhz: null,
      avx: null,
      avx2: null,
      avx512: null,
      fma: null,
      flagsSource: null,
    },
    memory: {
      pressure: null,
      commitPressure: null,
      commitLimitGb: null,
      commitFreeGb: null,
      pagefileGb: null,
    },
    drives: [],
    dataRootDrive: null,
    modelCacheDrive: null,
    modelDrive: null,
    vulkan: null,
    directxLevel: null,
    driverDate: null,
    integrated: null,
    multiGpu: false,
    cuda: { driverCuda: null, cublas12: null, cudnn9: null, dllDirs: [], runtimeFilesFound: null },
    cudaRuntimeFilesFound: null,
    network: { online: null, type: null, metered: null, roaming: null, latencyMs: null },
    power: {
      batteryPresent: null,
      batteryPercent: null,
      onAc: null,
      planName: null,
      planKind: null,
      batterySaver: null,
      thermal: null,
    },
    health: { level: "ok", reasons: [] },
  };
}

/** Picks only the known keys of a record, each through its own cleaner; anything else is dropped. */
function pick(record, cleaners) {
  const source = isRecord(record) ? record : {};
  const out = {};
  for (const [key, clean] of Object.entries(cleaners)) out[key] = clean(source[key]);
  return out;
}

function capabilityFacts({ src, deps, caps, best, gpuCount, facts }) {
  const empty = emptyCapabilityFacts();
  const c = isRecord(caps) ? caps : {};

  // OS: the probe's answer, or what the platform string of the hardware object ("win32 10.0.22631") already says.
  let os_ = pick(c.os, {
    platform: textOrNull,
    ntVersion: textOrNull,
    build: wholeOrNull,
    ubr: nonNegative,
    buildFull: textOrNull,
    name: textOrNull,
    displayVersion: textOrNull,
    edition: textOrNull,
    windows11: boolOrNull,
    is64Bit: boolOrNull,
    arch: textOrNull,
    webview2: boolOrNull,
    vcRuntimeX64: boolOrNull,
  });
  if (!isRecord(c.os) && typeof src.platform === "string") {
    const [platform, ...rest] = src.platform.trim().split(/\s+/);
    os_ = {
      ...os_,
      ...parseOsInfo({ platform, release: rest.join(" "), arch: String(src.arch ?? "") }),
    };
  }

  const cpuSrc = isRecord(src.cpu) ? src.cpu : {};
  const probed = pick(c.cpu, {
    model: textOrNull,
    physicalCores: wholeOrNull,
    logicalCores: wholeOrNull,
    baseClockMhz: wholeOrNull,
    avx: boolOrNull,
    avx2: boolOrNull,
    avx512: boolOrNull,
    fma: boolOrNull,
    flagsSource: textOrNull,
  });
  const cpu = {
    ...probed,
    model: cpuSrc.model && cpuSrc.model !== "unknown" ? textOrNull(cpuSrc.model) : probed.model,
    physicalCores: wholeOrNull(cpuSrc.physicalCores) ?? probed.physicalCores,
    logicalCores: wholeOrNull(cpuSrc.threads) ?? wholeOrNull(cpuSrc.cores) ?? probed.logicalCores,
  };

  // Memory: RAM pressure from the free memory the facts already carry (live when the caller passed it); the commit
  // figures are Windows' own.
  const m = isRecord(c.memory) ? c.memory : {};
  const memory = {
    pressure:
      facts.ramGb !== null && facts.ramFreeGb !== null
        ? memoryPressure(facts.ramFreeGb * 1024, facts.ramGb * 1024)
        : null,
    commitPressure: levelOrNull(m.commitPressure),
    commitLimitGb: positive(m.commitLimitGb),
    commitFreeGb: nonNegative(m.commitFreeGb),
    pagefileGb: nonNegative(m.pagefileGb),
  };

  // Drives: free space per drive, which holds the FRIDAY folder and the model cache, and SSD or HDD when Windows says.
  const media = new Map(
    (Array.isArray(c.storage) ? c.storage : [])
      .filter(isRecord)
      .map((row) => [textOrNull(row.letter)?.toUpperCase(), row]),
  );
  const dataLetter = textOrNull(c.dataRootDrive)?.toUpperCase() ?? null;
  const modelLetter = textOrNull(c.modelCacheDrive)?.toUpperCase() ?? dataLetter;
  const drives = (Array.isArray(src.drives) ? src.drives : []).filter(isRecord).map((row) => {
    const letter = textOrNull(row.letter);
    const key = letter?.toUpperCase() ?? null;
    const holdsDataRoot = dataLetter ? key === dataLetter : row.holdsFridayFolder === true;
    const kind = key ? media.get(key) : null;
    return {
      letter,
      totalGb: positive(row.totalGb),
      freeGb: nonNegative(row.freeGb),
      media: kind ? (["ssd", "hdd", "scm"].includes(kind.media) ? kind.media : null) : null,
      bus: kind ? textOrNull(kind.bus) : null,
      holdsDataRoot,
      holdsModelCache: modelLetter ? key === modelLetter : holdsDataRoot,
    };
  });
  const modelDrive = drives.find((d) => d.holdsModelCache) || null;

  const v = isRecord(c.vulkan) ? c.vulkan : {};
  const cudaProbe = pick(c.cuda, {
    cublas12: boolOrNull,
    cudnn9: boolOrNull,
    runtimeFilesFound: boolOrNull,
  });
  const driverCuda = textOrNull(
    isRecord(src.cuda) && /^\d+(\.\d+)?$/.test(String(src.cuda.driverCudaVersion ?? ""))
      ? src.cuda.driverCudaVersion
      : null,
  );
  const cuda = {
    driverCuda,
    ...cudaProbe,
    dllDirs: (isRecord(c.cuda) && Array.isArray(c.cuda.dllDirs) ? c.cuda.dllDirs : [])
      .filter((d) => typeof d === "string" && d)
      .slice(0, 20),
  };

  const net = pick(c.network, {
    online: boolOrNull,
    type: (t) => (["wifi", "ethernet", "cellular", "unknown"].includes(t) ? t : null),
    metered: boolOrNull,
    roaming: boolOrNull,
    latencyMs: (n) => {
      const ms = nonNegative(n);
      return ms !== null && ms < 120_000 ? Math.round(ms) : null;
    },
  });

  const power = {
    ...pick(c.power, {
      batteryPresent: boolOrNull,
      batteryPercent: (n) => {
        const pct = nonNegative(n);
        return pct !== null && pct <= 100 ? Math.round(pct) : null;
      },
      onAc: boolOrNull,
      planName: textOrNull,
      planKind: textOrNull,
      batterySaver: boolOrNull,
    }),
    thermal: null,
  };
  // Electron's powerMonitor knows better than a battery-status code whether the PC is unplugged, and is the only
  // thermal source; both come in through deps and are never read here.
  const live = isRecord(deps?.power) ? deps.power : {};
  if (typeof live.onBatteryPower === "boolean") power.onAc = !live.onBatteryPower;
  power.thermal = thermalOf(live.thermalState);
  const level = typeof deps?.directxLevel === "string" ? deps.directxLevel.trim() : "";

  return {
    ...empty,
    os: os_,
    arch: os_.arch ?? textOrNull(src.arch),
    cpu,
    memory,
    drives,
    dataRootDrive: dataLetter ?? drives.find((d) => d.holdsDataRoot)?.letter ?? null,
    modelCacheDrive: modelLetter ?? modelDrive?.letter ?? null,
    modelDrive: modelDrive
      ? { letter: modelDrive.letter, freeGb: modelDrive.freeGb, media: modelDrive.media }
      : null,
    vulkan: vulkanVerdict(boolOrNull(v.loaderPresent), nonNegative(v.driverCount)),
    // DirectX feature levels are not cheap to read on Windows (dxdiag takes seconds), so only a caller that already
    // knows one (for example from the graphics process) can supply it.
    directxLevel: /^\d{1,2}(?:[._]\d)?$/.test(level) ? level : null,
    driverDate: best ? best.driverDate : null,
    integrated: best ? best.integrated : null,
    multiGpu: gpuCount > 1,
    cuda,
    cudaRuntimeFilesFound: cuda.runtimeFilesFound,
    network: net,
    power,
  };
}

// Reasons are stable codes (the UI words them); level is the worst reason: critical > tight > ok.
const HEALTH_CRITICAL = [
  ["ram-critical", (f) => f.memory?.pressure === "critical"],
  ["commit-critical", (f) => f.memory?.commitPressure === "critical"],
  ["disk-critical", (f) => f.modelDrive?.freeGb != null && f.modelDrive.freeGb < 2],
  ["thermal-critical", (f) => f.power?.thermal === "critical"],
  [
    "battery-critical",
    (f) =>
      f.power?.onAc === false && f.power?.batteryPercent != null && f.power.batteryPercent <= 5,
  ],
];
const HEALTH_TIGHT = [
  ["ram-high", (f) => f.memory?.pressure === "high"],
  ["commit-high", (f) => f.memory?.commitPressure === "high"],
  ["ram-small", (f) => f.ramGb != null && f.ramGb < 6],
  [
    "disk-low",
    (f) => {
      const free = f.modelDrive?.freeGb ?? f.diskFreeGb;
      return free != null && free >= 2 && free < 10;
    },
  ],
  ["on-battery", (f) => f.power?.onAc === false],
  [
    "battery-low",
    (f) =>
      f.power?.onAc === false && f.power?.batteryPercent != null && f.power.batteryPercent < 20,
  ],
  ["battery-saver", (f) => f.power?.batterySaver === true],
  ["thermal-serious", (f) => f.power?.thermal === "serious"],
  ["metered-network", (f) => f.network?.metered === true],
  ["no-avx2", (f) => f.cpu?.avx2 === false],
  ["vc-runtime-missing", (f) => f.os?.vcRuntimeX64 === false],
  ["os-32bit", (f) => f.os?.is64Bit === false],
];

/** A summary computed only from the facts: ok, tight (works, but leave headroom) or critical (act now). */
function healthOf(facts) {
  const reasons = [];
  let level = "ok";
  const f = isRecord(facts) ? facts : {};
  const run = (rules, rank) => {
    for (const [code, test] of rules) {
      let hit = false;
      try {
        hit = test(f) === true;
      } catch {
        hit = false;
      }
      if (hit) {
        reasons.push(code);
        level = rank;
      }
    }
  };
  run(HEALTH_TIGHT, "tight");
  run(HEALTH_CRITICAL, "critical");
  return { level, reasons };
}

/**
 * Windows-only sensor strip (motherboard, BIOS, battery, temperature).
 * These come from WMI/CIM through PowerShell. On non-Windows machines — or
 * when the sensor simply is not present — the field reports
 * { available: false, reason } and the UI renders a dash, never a made-up
 * reading and never an error.
 */
const unavailable = (reason) => ({ available: false, value: null, reason });
const value = (v) => ({ available: true, value: v, reason: null });

async function cim(expression) {
  if (process.platform !== "win32") return null;
  const { ok, stdout } = await runPowerShell(`${expression} | ConvertTo-Json -Compress`, 12000);
  const out = ok ? stdout : null;

  if (!out) return null;
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed;
  } catch {
    return null;
  }
}

async function detectSensors() {
  const notWindows = process.platform !== "win32";
  if (notWindows) {
    const reason = `not available on ${process.platform}`;
    return {
      detectedAt: Date.now(),
      motherboard: unavailable(reason),
      bios: unavailable(reason),
      battery: unavailable(reason),
      temperature: unavailable(reason),
      uptime: value(formatUptime(os.uptime())),
    };
  }

  const [board, bios, battery, thermal] = await Promise.all([
    cim("Get-CimInstance Win32_BaseBoard | Select-Object -First 1 Manufacturer,Product"),
    cim("Get-CimInstance Win32_BIOS | Select-Object -First 1 SMBIOSBIOSVersion"),
    cim(
      "Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus",
    ),
    cim(
      "Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1 CurrentTemperature",
    ),
  ]);

  const celsius =
    thermal && Number(thermal.CurrentTemperature)
      ? Math.round(Number(thermal.CurrentTemperature) / 10 - 273.15)
      : null;
  const percent = battery ? Number(battery.EstimatedChargeRemaining) : NaN;

  return {
    detectedAt: Date.now(),
    motherboard: board
      ? value(`${board.Manufacturer ?? ""} ${board.Product ?? ""}`.trim() || "unknown")
      : unavailable("WMI did not report a baseboard"),
    bios: bios?.SMBIOSBIOSVersion
      ? value(String(bios.SMBIOSBIOSVersion))
      : unavailable("WMI did not report BIOS data"),
    battery: Number.isFinite(percent)
      ? value(`${percent}% · ${Number(battery.BatteryStatus) === 2 ? "charging" : "on battery"}`)
      : unavailable("no battery on this machine"),
    temperature:
      celsius === null
        ? unavailable("thermal sensor not exposed by this firmware")
        : value(`${celsius}°C`),
    uptime: value(formatUptime(os.uptime())),
  };
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

/**
 * Windows Security posture — read-only. Every entry is measured through
 * Defender/Firewall/BitLocker/Hello providers; anything that cannot be read
 * reports state "unknown" with a reason so the UI can render a dash instead of
 * inventing an "Enabled" badge.
 */
const secure = (state, detail) => ({ state, detail: detail ?? null });

async function detectSecurity() {
  if (process.platform !== "win32") {
    const reason = `not available on ${process.platform}`;
    const unknown = secure("unknown", reason);
    return {
      detectedAt: Date.now(),
      supported: false,
      items: [
        { id: "defender", label: "Windows Defender", ...unknown },
        { id: "firewall", label: "Firewall", ...unknown },
        { id: "smartscreen", label: "SmartScreen", ...unknown },
        { id: "bitlocker", label: "Drive Encryption (BitLocker)", ...unknown },
        { id: "hello", label: "Biometric Authentication (Hello)", ...unknown },
      ],
    };
  }

  const [defender, firewall, smartscreen, bitlocker, hello] = await Promise.all([
    cim(
      "Get-MpComputerStatus -ErrorAction SilentlyContinue | Select-Object AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureLastUpdated",
    ),
    cim("Get-NetFirewallProfile -ErrorAction SilentlyContinue | Select-Object Name,Enabled"),
    cim(
      "Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' -ErrorAction SilentlyContinue | Select-Object EnableSmartScreen",
    ),
    cim(
      "Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction SilentlyContinue | Select-Object ProtectionStatus,VolumeStatus",
    ),
    cim(
      "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI\\UserSwitch' -ErrorAction SilentlyContinue | Select-Object Enabled",
    ),
  ]);

  const firewallRaw = await run("netsh", ["advfirewall", "show", "allprofiles", "state"], 6000);
  const firewallStates = firewallRaw
    ? firewallRaw
        .split(/\r?\n/)
        .filter((line) => /^\s*State\s+/i.test(line))
        .map((line) => /ON/i.test(line))
    : [];

  const firewallOn = firewall
    ? Boolean(firewall.Enabled)
    : firewallStates.length
      ? firewallStates.every(Boolean)
      : null;

  const items = [
    {
      id: "defender",
      label: "Windows Defender",
      ...(defender
        ? secure(
            defender.RealTimeProtectionEnabled
              ? "on"
              : defender.AntivirusEnabled
                ? "partial"
                : "off",
            defender.RealTimeProtectionEnabled
              ? "real-time protection active"
              : defender.AntivirusEnabled
                ? "antivirus on, real-time protection off"
                : "antivirus disabled",
          )
        : secure("unknown", "Defender status not exposed (third-party AV or policy)")),
    },
    {
      id: "firewall",
      label: "Firewall",
      ...(firewallOn === null
        ? secure("unknown", "firewall profiles could not be read")
        : secure(
            firewallOn ? "on" : "off",
            firewallOn ? "all profiles enabled" : "a profile is off",
          )),
    },
    {
      id: "smartscreen",
      label: "SmartScreen",
      ...(smartscreen &&
      smartscreen.EnableSmartScreen !== undefined &&
      smartscreen.EnableSmartScreen !== null
        ? secure(Number(smartscreen.EnableSmartScreen) > 0 ? "on" : "off", "system policy")
        : secure("unknown", "no SmartScreen policy set (Windows default applies)")),
    },
    {
      id: "bitlocker",
      label: "Drive Encryption (BitLocker)",
      ...(bitlocker
        ? secure(
            Number(bitlocker.ProtectionStatus) === 1 ? "on" : "off",
            String(bitlocker.VolumeStatus ?? ""),
          )
        : secure("unknown", "BitLocker not available or needs elevation")),
    },
    {
      id: "hello",
      label: "Biometric Authentication (Hello)",
      ...(hello && hello.Enabled !== undefined && hello.Enabled !== null
        ? secure(Number(hello.Enabled) > 0 ? "on" : "off", "Windows Hello sign-in")
        : secure("unknown", "Hello enrolment state not readable")),
    },
  ];

  return { detectedAt: Date.now(), supported: true, items };
}

/* --------------------------------------------------------------- reliability */

/**
 * Reliability and host state — read-only.
 *
 * What went wrong on this PC lately and what is waiting on it: application crashes and hangs from
 * the Application event log, Windows Error Reporting report folders, a pending restart, startup
 * entries, services that should be running and are not, the newest installed updates and the
 * heaviest processes. Only names, counts and times are kept. A message body, a command line and a
 * path (which carry user names) are never stored. Every row that cannot be read says why.
 */
const RELIABILITY_DAYS = 7;
const CRASH_WARN = 1;
const CRASH_BAD = 10;
const STOPPED_SERVICES_WARN = 10;

const row = (id, label, state, detail, extra = {}) => ({ id, label, state, detail, ...extra });

/** ConvertTo-Json gives one object for one row and an array for many; both become an array. */
function jsonRows(text) {
  if (!text || !String(text).trim()) return [];
  try {
    const parsed = JSON.parse(String(text));
    if (Array.isArray(parsed)) return parsed.filter((item) => item && typeof item === "object");
    return parsed && typeof parsed === "object" ? [parsed] : [];
  } catch {
    return [];
  }
}

/** The program a crash or hang event names, from the first line of its message only. */
function crashApp(provider, message) {
  const line = String(message || "").split(/\r?\n/)[0];
  const faulting = /Faulting application name:\s*([^,\s]+)/i.exec(line);
  if (faulting) return faulting[1];
  const hung = /program\s+(\S+?)\s+version/i.exec(line);
  if (hung) return hung[1];
  const bucket = /\bP1:\s*(\S+)/i.exec(line);
  if (bucket) return bucket[1];
  return provider === "Windows Error Reporting" ? "unnamed (Windows Error Reporting)" : "unknown";
}

function parseCrashEvents(text) {
  return jsonRows(text).map((event) => ({
    at: String(event.t || ""),
    provider: String(event.p || ""),
    id: Number(event.id) || 0,
    app: crashApp(String(event.p || ""), event.m),
  }));
}

/** "AppCrash_FRIDAY.exe_8e1f..." -> { kind: "AppCrash", app: "FRIDAY.exe" }. Names only. */
function parseWerFolder(name) {
  const parts = String(name || "").split("_");
  return { kind: parts[0] || "report", app: parts[1] || "unknown" };
}

function readWerFolders(fsApi, env) {
  const base = path.join(env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "WER");
  const result = { queue: 0, archive: 0, newest: [], readable: false };
  for (const kind of ["ReportQueue", "ReportArchive"]) {
    let names = [];
    try {
      names = fsApi.readdirSync(path.join(base, kind), { withFileTypes: true });
      result.readable = true;
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      if (kind === "ReportQueue") result.queue += 1;
      else result.archive += 1;
      let mtime = 0;
      try {
        mtime = fsApi.statSync(path.join(base, kind, entry.name)).mtimeMs;
      } catch {
        /* a folder WER removed meanwhile */
      }
      result.newest.push({ ...parseWerFolder(entry.name), mtime });
    }
  }
  result.newest.sort((a, b) => b.mtime - a.mtime);
  result.newest = result.newest.slice(0, 5);
  return result;
}

const tally = (names) => {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

const PS_CRASHES =
  "$ErrorActionPreference='SilentlyContinue'; " +
  `Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error','Application Hang','Windows Error Reporting'; StartTime=(Get-Date).AddDays(-${RELIABILITY_DAYS})} -MaxEvents 60 | ` +
  "ForEach-Object { [pscustomobject]@{ t=$_.TimeCreated.ToUniversalTime().ToString('o'); p=$_.ProviderName; id=$_.Id; m=[regex]::Split([string]$_.Message,'\\r?\\n')[0] } } | ConvertTo-Json -Compress";
const PS_REBOOT =
  "$ErrorActionPreference='SilentlyContinue'; " +
  "@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') | Where-Object { Test-Path $_ } | Measure-Object | Select-Object -ExpandProperty Count";
const PS_STARTUP =
  "Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | Select-Object Name | ConvertTo-Json -Compress";
const PS_STOPPED =
  "Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' } | Select-Object DisplayName | ConvertTo-Json -Compress";
const PS_UPDATES =
  "Get-HotFix -ErrorAction SilentlyContinue | Sort-Object InstalledOn -Descending | Select-Object -First 3 HotFixID,@{n='on';e={ if ($_.InstalledOn) { $_.InstalledOn.ToString('yyyy-MM-dd') } }} | ConvertTo-Json -Compress";
const PS_PROCESSES =
  "Get-Process -ErrorAction SilentlyContinue | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 @{n='n';e={$_.ProcessName}},@{n='mb';e={[int]($_.WorkingSet64/1MB)}} | ConvertTo-Json -Compress";

/**
 * deps (all optional, for tests): { platform, runPowerShell, fs, env }
 */
async function detectReliability(deps = {}) {
  const platform = deps.platform || process.platform;
  const detectedAt = Date.now();
  const labels = [
    ["crashes", `Application crashes (${RELIABILITY_DAYS} days)`],
    ["wer-reports", "Windows Error Reporting"],
    ["reboot-pending", "Restart pending"],
    ["startup", "Startup entries"],
    ["stopped-services", "Automatic services not running"],
    ["updates", "Newest installed updates"],
    ["processes", "Heaviest processes"],
  ];
  if (platform !== "win32") {
    const reason = `not available on ${platform}`;
    return {
      detectedAt,
      supported: false,
      items: labels.map(([id, label]) => row(id, label, "unknown", reason)),
    };
  }

  const ps = deps.runPowerShell || runPowerShell;
  const fsApi = deps.fs || fs;
  const env = deps.env || process.env;
  const [crashes, reboot, startup, stopped, updates, processes] = await Promise.all([
    ps(PS_CRASHES, 20000),
    ps(PS_REBOOT, 8000),
    ps(PS_STARTUP, 12000),
    ps(PS_STOPPED, 12000),
    ps(PS_UPDATES, 20000),
    ps(PS_PROCESSES, 8000),
  ]);
  const why = (got, fallback) => (got && got.error) || fallback;
  const items = [];

  if (crashes && crashes.ok) {
    const events = parseCrashEvents(crashes.stdout);
    const top = tally(events.map((event) => event.app)).slice(0, 4);
    const state = events.length >= CRASH_BAD ? "bad" : events.length >= CRASH_WARN ? "warn" : "ok";
    items.push(
      row(
        "crashes",
        labels[0][1],
        state,
        events.length
          ? `${events.length} event(s): ${top.map(([app, n]) => `${app} x${n}`).join(", ")}`
          : "none recorded",
        { count: events.length, apps: top.map(([app, n]) => ({ app, count: n })) },
      ),
    );
  } else {
    items.push(
      row(
        "crashes",
        labels[0][1],
        "unknown",
        why(crashes, "the Application log could not be read"),
      ),
    );
  }

  const wer = readWerFolders(fsApi, env);
  items.push(
    wer.readable
      ? row(
          "wer-reports",
          labels[1][1],
          wer.queue ? "warn" : "ok",
          `${wer.queue} waiting, ${wer.archive} archived${
            wer.newest.length
              ? `; newest ${wer.newest
                  .map((r) => `${r.kind} ${r.app}`)
                  .slice(0, 3)
                  .join(", ")}`
              : ""
          }`,
          { queue: wer.queue, archive: wer.archive },
        )
      : row("wer-reports", labels[1][1], "unknown", "the WER report folders could not be read"),
  );

  if (reboot && reboot.ok) {
    const pending = Number(String(reboot.stdout).trim()) > 0;
    items.push(
      row(
        "reboot-pending",
        labels[2][1],
        pending ? "warn" : "ok",
        pending ? "Windows is waiting for a restart" : "no restart pending",
      ),
    );
  } else {
    items.push(
      row(
        "reboot-pending",
        labels[2][1],
        "unknown",
        why(reboot, "the restart flags could not be read"),
      ),
    );
  }

  if (startup && startup.ok) {
    const names = jsonRows(startup.stdout)
      .map((entry) => String(entry.Name || ""))
      .filter(Boolean);
    items.push(
      row(
        "startup",
        labels[3][1],
        "ok",
        names.length ? `${names.length}: ${names.slice(0, 8).join(", ")}` : "none listed",
        { count: names.length },
      ),
    );
  } else {
    items.push(
      row("startup", labels[3][1], "unknown", why(startup, "the startup list could not be read")),
    );
  }

  if (stopped && stopped.ok) {
    const names = jsonRows(stopped.stdout)
      .map((entry) => String(entry.DisplayName || ""))
      .filter(Boolean);
    items.push(
      row(
        "stopped-services",
        labels[4][1],
        names.length > STOPPED_SERVICES_WARN ? "warn" : "ok",
        names.length
          ? `${names.length}: ${names.slice(0, 5).join(", ")} (some are start-on-demand and normally idle)`
          : "all running",
        { count: names.length },
      ),
    );
  } else {
    items.push(
      row(
        "stopped-services",
        labels[4][1],
        "unknown",
        why(stopped, "the service list could not be read"),
      ),
    );
  }

  if (updates && updates.ok) {
    const list = jsonRows(updates.stdout);
    items.push(
      row(
        "updates",
        labels[5][1],
        list.length ? "ok" : "unknown",
        list.length
          ? list.map((u) => `${u.HotFixID}${u.on ? ` (${u.on})` : ""}`).join(", ")
          : "Windows did not list any",
      ),
    );
  } else {
    items.push(
      row("updates", labels[5][1], "unknown", why(updates, "the update list could not be read")),
    );
  }

  if (processes && processes.ok) {
    const list = jsonRows(processes.stdout);
    items.push(
      row(
        "processes",
        labels[6][1],
        list.length ? "ok" : "unknown",
        list.map((p) => `${p.n} ${p.mb} MB`).join(", ") || "none listed",
      ),
    );
  } else {
    items.push(
      row(
        "processes",
        labels[6][1],
        "unknown",
        why(processes, "the process list could not be read"),
      ),
    );
  }

  return { detectedAt, supported: true, items };
}

/** Opens the Windows Security app. Returns false when the shell refuses. */
/** The compute capability (7.5) of the NVIDIA card the facts rank first, or null when it was not measured. */
function computeCapOf(facts) {
  const gpus = Array.isArray(facts?.gpus) ? facts.gpus : [];
  const card = gpus.find((g) => g && g.vendor === "nvidia");
  const cap = parseComputeCap(card?.computeCap);
  return cap === null ? null : Number(cap);
}

function openWindowsSecurity() {
  if (process.platform !== "win32") return false;
  const { shell } = require("electron");
  void shell.openExternal("windowsdefender://");
  return true;
}

module.exports = {
  detectHardware,
  buildPlan,
  parseVideoControllers,
  parseNvidiaSmi,
  parseComputeCap,
  readNvidiaGpus,
  computeCapOf,
  parseCudaDriverVersion,
  hardwareFacts,
  healthOf,
  detectCapabilities,
  createCapabilityCache,
  findCudaRuntimeFiles,
  withDeadline,
  parseOsInfo,
  parseWebView2,
  parseVcRuntime,
  parseCpuInfo,
  parseCpuFlagsFromCpuinfo,
  memoryPressure,
  parseMemoryCounters,
  parseStorageMedia,
  parseDriverDate,
  parseGpuExtras,
  parsePower,
  driveOf,
  CAPABILITY_SCRIPTS: { STATIC_SCRIPT, dynamicScript },
  parseLogicalDisks,
  parseCpuTopology,
  physicalCoresFromProcCpuinfo,
  diskFor,
  bestGpuFirst,
  detectSensors,
  detectSecurity,
  detectReliability,
  parseCrashEvents,
  parseWerFolder,
  jsonRows,
  RELIABILITY_SCRIPTS: { PS_CRASHES, PS_REBOOT, PS_STARTUP, PS_STOPPED, PS_UPDATES, PS_PROCESSES },
  openWindowsSecurity,
};
