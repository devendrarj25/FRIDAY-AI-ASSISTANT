// Hardware detection and the acceleration plan.
// Detection only: nothing here changes system settings or reserves resources.
// The plan deliberately leaves headroom so FRIDAY stays responsive in the
// foreground and never pins the machine at 100%.
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

async function detectNvidia() {
  const exe = nvidiaSmiPath();
  if (!exe) {
    probeErrors.nvidiaSmi =
      "nvidia-smi not found (checked PATH, System32 and NVIDIA Corporation\\NVSMI)";
    return [];
  }
  const result = await runProbe(
    exe,
    ["--query-gpu=name,memory.total,memory.used,driver_version", "--format=csv,noheader,nounits"],
    8000,
  );
  probeErrors.nvidiaSmi = result.ok ? null : result.error;
  const out = result.ok ? result.stdout : null;
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((line) => line.split(",").map((s) => s.trim()))
    .filter((parts) => parts.length >= 4 && parts[0])
    .map(([name, total, used, driver]) => ({
      vendor: "nvidia",
      name,
      vramTotalMb: Number(total) || null,
      vramUsedMb: Number(used) || null,
      driver,
    }));
}

// Fallback for AMD/Intel/other GPUs on Windows.
async function detectWindowsGpus() {
  const first = await runPowerShell(
    "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Csv -NoTypeInformation",
    12000,
  );
  probeErrors.videoController = first.ok ? null : first.error;
  let out = first.ok ? first.stdout : null;
  // WMIC is removed from current Windows releases but remains a useful fallback
  // on older installations where PowerShell/CIM is restricted by policy.
  if (!out) {
    out = await run("wmic", [
      "path",
      "win32_VideoController",
      "get",
      "name,AdapterRAM",
      "/format:csv",
    ]);
    if (out) probeErrors.videoController = null;
  }

  if (!out) return [];
  return out
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/Name.*AdapterRAM|Node/i.test(line))
    .map((line) => line.split(",").map((part) => part.replace(/^"|"$/g, "").trim()))
    .map((parts) => {
      const name = parts.length >= 3 ? parts[2] : parts[0];
      const ram = parts.length >= 3 ? parts[1] : parts[1];
      return { name, ram };
    })
    .filter((entry) => entry.name)
    .map((entry) => ({
      vendor: /nvidia/i.test(entry.name)
        ? "nvidia"
        : /amd|radeon/i.test(entry.name)
          ? "amd"
          : /intel/i.test(entry.name)
            ? "intel"
            : "other",
      name: entry.name,
      vramTotalMb: Number(entry.ram) ? Math.round(Number(entry.ram) / (1024 * 1024)) : null,
      vramUsedMb: null,
      driver: null,
    }));
}

/**
 * Conservative worker plan:
 * - keep at least one physical core free for the UI
 * - never claim more than 70% of system RAM
 * - only offload layers to the GPU when there is real VRAM headroom
 */
function buildPlan({ cpuCount, totalMemGb, gpus, gpuAcceleration }) {
  const threads = Math.max(1, Math.min(cpuCount - 1, Math.floor(cpuCount * 0.75)));
  const gpu = gpus[0] || null;
  const vramGb = gpu?.vramTotalMb ? Math.round((gpu.vramTotalMb / 1024) * 10) / 10 : 0;
  const gpuUsable = Boolean(gpuAcceleration && gpu && vramGb >= 2);
  return {
    backend: gpuUsable ? "gpu" : "cpu",
    reason: gpuUsable
      ? `NVIDIA driver acceleration available with ${vramGb} GB VRAM`
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

async function detectHardware() {
  const cpus = os.cpus() || [];
  const nvidia = await detectNvidia();
  const gpus = nvidia.length || process.platform !== "win32" ? nvidia : await detectWindowsGpus();
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
      cores: cpus.length,
      speedMhz: cpus[0]?.speed || null,
    },
    memory: { totalGb: totalMemGb, freeGb: toGb(os.freemem()) },
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

/** Opens the Windows Security app. Returns false when the shell refuses. */
function openWindowsSecurity() {
  if (process.platform !== "win32") return false;
  const { shell } = require("electron");
  void shell.openExternal("windowsdefender://");
  return true;
}

module.exports = { detectHardware, detectSensors, detectSecurity, openWindowsSecurity };
