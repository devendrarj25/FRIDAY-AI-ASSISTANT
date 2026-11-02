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

async function detectNvidia() {
  const exe = nvidiaSmiPath();
  if (!exe) {
    probeErrors.nvidiaSmi =
      "nvidia-smi not found (checked PATH, System32 and NVIDIA Corporation\\NVSMI)";
    return [];
  }
  const result = await runProbe(
    exe,
    [
      "--query-gpu=name,memory.total,memory.used,driver_version,utilization.gpu,temperature.gpu",
      "--format=csv,noheader,nounits",
    ],
    8000,
  );
  probeErrors.nvidiaSmi = result.ok ? null : result.error;
  const out = result.ok ? result.stdout : null;
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((line) => line.split(",").map((s) => s.trim()))
    .filter((parts) => parts.length >= 4 && parts[0])
    .map(([name, total, used, driver, utilization, temperature]) => ({
      vendor: "nvidia",
      name,
      vramTotalMb: Number(total) || null,
      vramKnown: Number(total) > 0,
      vramUsedMb: Number(used) || null,
      driver,
      // "[N/A]" or "[Not Supported]" on cards that do not report these: null, never a made-up zero.
      utilizationPercent: Number.isFinite(Number(utilization)) ? Number(utilization) : null,
      temperatureC: Number.isFinite(Number(temperature)) ? Number(temperature) : null,
    }));
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

async function detectHardware({ root = null } = {}) {
  const cpus = os.cpus() || [];
  const [nvidia, topology] = await Promise.all([detectNvidia(), detectCpuTopology()]);
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
      toolkitAvailable: cudaToolkit,
      reason: cudaToolkit ? null : probeErrors.cuda,
    },
    // Real reasons for anything that could not be measured, so the UI can say
    // WHY instead of silently rendering a blank value.
    probes: { ...probeErrors },
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
