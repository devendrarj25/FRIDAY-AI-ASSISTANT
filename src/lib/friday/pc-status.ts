/**
 * The PC status the Hardware page and the Status page show: what the main process measured about this PC
 * (electron/hardware.cjs `hardwareFacts`) and what the resource governor is doing with it
 * (electron/resource-governor.cjs `status`), turned into plain rows. Pure: no timers, no IPC, so every state is
 * tested. A value no probe read says "not measured" (or "measuring…" while the wider probes are still running); a
 * number is never invented, and a video-memory figure that only came from the capped 32-bit reading is marked so.
 */
import type { GovernorStatus, HardwareFacts } from "./desktop";
import { cudaReasonLine, resourceRows } from "./voice-diagnostics-rows";

export type RowState = "ok" | "warn" | "bad" | "unknown";
export type PcRow = { label: string; value: string; state: RowState };
export type PcSection = { id: string; title: string; rows: PcRow[] };

/** What the page knows: still reading, no desktop app, could not read, or the measured facts. */
export type PcStatusView =
  | { phase: "loading" }
  | { phase: "offline" }
  | { phase: "error"; message: string }
  | { phase: "ready"; facts: HardwareFacts; governor: GovernorStatus | null };

export const NOT_MEASURED = "not measured";
export const MEASURING = "measuring…";

/** The wider capability probes have not answered yet (the first ask after launch); the next ask finds them. */
export function capabilityPending(facts: HardwareFacts): boolean {
  return !facts.sources.includes("capability-probe");
}

const HEALTH_LINES: Record<string, string> = {
  "ram-critical": "Memory is almost full, so programs may stall or close.",
  "commit-critical": "Windows is close to running out of memory it can promise to programs.",
  "disk-critical": "The drive that holds the models has under 2 GB free.",
  "thermal-critical": "The PC is overheating and slowing itself down.",
  "battery-critical": "The battery is at 5% or less and the PC is unplugged.",
  "ram-high": "Free memory is low, so large models may be held back.",
  "commit-high": "Windows memory commitment is high.",
  "ram-small": "This PC has under 6 GB of memory, so only small models fit.",
  "disk-low": "The drive that holds the models has under 10 GB free.",
  "on-battery": "The PC is on battery, so FRIDAY prefers smaller models and waits to prefetch.",
  "battery-low": "The battery is under 20% and the PC is unplugged.",
  "battery-saver": "Battery saver is on.",
  "thermal-serious": "The PC is running hot.",
  "metered-network": "The connection is metered, so large downloads should wait.",
  "no-avx2": "This processor has no AVX2, so local models run slowly.",
  "vc-runtime-missing": "The Visual C++ runtime is missing, which some engines need.",
  "os-32bit": "This is a 32-bit Windows, which cannot run the local engines.",
};

export type HealthView = {
  level: "ok" | "tight" | "critical" | "unknown";
  title: string;
  reasons: string[];
};

/** The health level with its reasons in plain language. Facts with no health block are "not assessed", never "ok". */
export function healthView(facts: HardwareFacts | null): HealthView {
  const health = facts?.health;
  if (!facts || !health || (capabilityPending(facts) && health.reasons.length === 0)) {
    return {
      level: "unknown",
      title: facts && capabilityPending(facts) ? "Still measuring this PC" : "Not assessed yet",
      reasons: [],
    };
  }
  const reasons = health.reasons.map(
    (code) => HEALTH_LINES[code] ?? `Note from the check: ${code}.`,
  );
  const title =
    health.level === "critical"
      ? "This PC needs attention"
      : health.level === "tight"
        ? "This PC is running tight"
        : "This PC is healthy";
  return { level: health.level, title, reasons };
}

const gb = (value: number | null | undefined, pending: boolean): string =>
  typeof value === "number"
    ? `${Math.round(value * 10) / 10} GB`
    : pending
      ? MEASURING
      : NOT_MEASURED;

const yesNo = (value: boolean | null | undefined): string | null =>
  value === true ? "yes" : value === false ? "no" : null;

/** `value` when it is a string, else the right "no reading" word. */
const text = (value: string | null | undefined, pending: boolean): string =>
  value ? value : pending ? MEASURING : NOT_MEASURED;

const stateOf = (value: boolean | null | undefined, badWhen: boolean): RowState =>
  value === null || value === undefined ? "unknown" : value === badWhen ? "bad" : "ok";

function osRows(f: HardwareFacts, pending: boolean): PcRow[] {
  const os = f.os;
  const name = [
    os?.name,
    os?.edition && !os.name?.includes(os.edition) ? os.edition : null,
    os?.displayVersion,
  ]
    .filter(Boolean)
    .join(" ");
  const build = os?.buildFull ?? (os?.build != null ? String(os.build) : null);
  const bits = os?.is64Bit === true ? "64-bit" : os?.is64Bit === false ? "32-bit" : null;
  return [
    {
      label: "Windows",
      value: name
        ? `${name}${build ? ` (build ${build})` : ""}`
        : build
          ? `build ${build}`
          : text(null, pending),
      state: name || build ? "ok" : "unknown",
    },
    {
      label: "System type",
      value: bits ? `${bits}${os?.arch ? ` · ${os.arch}` : ""}` : text(null, pending),
      state: stateOf(os?.is64Bit, false),
    },
    {
      label: "WebView2 runtime",
      value: yesNo(os?.webview2) ?? text(null, pending),
      state: stateOf(os?.webview2, false),
    },
    {
      label: "Visual C++ runtime",
      value: yesNo(os?.vcRuntimeX64) ?? text(null, pending),
      state: stateOf(os?.vcRuntimeX64, false),
    },
  ];
}

function cpuRows(f: HardwareFacts, pending: boolean): PcRow[] {
  const cpu = f.cpu;
  const cores =
    cpu?.physicalCores != null && cpu.logicalCores != null
      ? `${cpu.physicalCores} cores · ${cpu.logicalCores} threads`
      : cpu?.logicalCores != null
        ? `${cpu.logicalCores} threads`
        : null;
  const flag = (name: string, value: boolean | null | undefined) =>
    `${name} ${yesNo(value) ?? "not measured"}`;
  const flags = cpu
    ? [
        flag("AVX", cpu.avx),
        flag("AVX2", cpu.avx2),
        flag("AVX-512", cpu.avx512),
        flag("FMA", cpu.fma),
      ]
    : null;
  return [
    { label: "Processor", value: text(cpu?.model, pending), state: cpu?.model ? "ok" : "unknown" },
    { label: "Cores", value: text(cores, pending), state: cores ? "ok" : "unknown" },
    {
      label: "Base clock",
      value:
        cpu?.baseClockMhz != null
          ? `${(cpu.baseClockMhz / 1000).toFixed(2)} GHz`
          : text(null, pending),
      state: cpu?.baseClockMhz != null ? "ok" : "unknown",
    },
    {
      label: "Instruction sets",
      value: flags ? flags.join(" · ") : text(null, pending),
      state: cpu?.avx2 === false ? "warn" : flags ? "ok" : "unknown",
    },
    {
      label: "Speed class",
      value: f.cpuClass ?? NOT_MEASURED,
      state: f.cpuClass ? "ok" : "unknown",
    },
  ];
}

function memoryRows(f: HardwareFacts, pending: boolean): PcRow[] {
  const used =
    f.ramGb != null && f.ramFreeGb != null ? Math.round((f.ramGb - f.ramFreeGb) * 10) / 10 : null;
  const pressure = f.memory?.pressure ?? null;
  return [
    {
      label: "Memory (total · used · free)",
      value:
        f.ramGb != null
          ? `${gb(f.ramGb, false)} · ${gb(used, false)} · ${gb(f.ramFreeGb, false)}`
          : text(null, false),
      state: f.ramGb != null && f.ramGb < 6 ? "warn" : f.ramGb != null ? "ok" : "unknown",
    },
    {
      label: "Memory pressure",
      value: pressure ?? (pending ? MEASURING : NOT_MEASURED),
      state:
        pressure === "critical"
          ? "bad"
          : pressure === "high"
            ? "warn"
            : pressure
              ? "ok"
              : "unknown",
    },
    {
      label: "Windows commit (free of limit)",
      value:
        f.memory?.commitLimitGb != null
          ? `${gb(f.memory.commitFreeGb, false)} of ${gb(f.memory.commitLimitGb, false)}${f.memory.commitPressure ? ` · ${f.memory.commitPressure}` : ""}`
          : text(null, pending),
      state:
        f.memory?.commitPressure === "critical"
          ? "bad"
          : f.memory?.commitPressure === "high"
            ? "warn"
            : f.memory?.commitLimitGb != null
              ? "ok"
              : "unknown",
    },
    {
      label: "Page file",
      value: f.memory?.pagefileGb != null ? gb(f.memory.pagefileGb, false) : text(null, pending),
      state: f.memory?.pagefileGb != null ? "ok" : "unknown",
    },
  ];
}

/** One card's memory the way it was measured: exact, "at least" for the capped 32-bit figure, or not measured. */
export function gpuMemoryText(gpu: HardwareFacts["gpus"][number], pending = false): string {
  if (gpu.vramGb != null) return `${gpu.vramGb} GB`;
  if (gpu.vramCapped) return "at least 4 GB (capped 32-bit reading; the real size is not measured)";
  return pending ? MEASURING : NOT_MEASURED;
}

/** Total video memory of the best card for a headline: exact, "at least" for the capped reading, or the fallback. */
export function vramHeadline(
  facts: HardwareFacts | null,
  fallbackMb: number | null,
): string | null {
  const gpu = facts?.gpus[0];
  if (gpu) {
    if (gpu.vramGb != null) return `${gpu.vramGb} GB total`;
    if (gpu.vramCapped) return "at least 4 GB (capped reading)";
    return null;
  }
  return fallbackMb ? `${Math.round(fallbackMb / 1024)} GB total` : null;
}

function graphicsRows(f: HardwareFacts, pending: boolean): PcRow[] {
  const rows: PcRow[] = [];
  if (f.gpus.length === 0) {
    rows.push({
      label: "Graphics card",
      value: pending ? MEASURING : "none found",
      state: pending ? "unknown" : "warn",
    });
  }
  f.gpus.forEach((gpu, index) => {
    const label = f.gpus.length > 1 ? `Graphics card ${index + 1}` : "Graphics card";
    const kind = gpu.integrated === true ? " (integrated)" : "";
    const free = index === 0 && f.vramFreeGb != null ? ` · ${f.vramFreeGb} GB free` : "";
    const driver = gpu.driver
      ? ` · driver ${gpu.driver}${gpu.driverDate ? ` (${gpu.driverDate})` : ""}`
      : "";
    rows.push({
      label,
      value: `${gpu.name ?? `${gpu.vendor} graphics`}${kind}`,
      state: "ok",
    });
    rows.push({
      label: `${label}: video memory`,
      value: `${gpuMemoryText(gpu, pending)}${free}${driver}`,
      state: gpu.vramGb != null ? "ok" : "unknown",
    });
  });
  const cuda = f.cuda;
  rows.push(
    { label: "CUDA", value: cudaReasonLine(f), state: f.cudaReady ? "ok" : "unknown" },
    {
      label: "CUDA driver version",
      value: cuda?.driverCuda ? `CUDA ${cuda.driverCuda}` : text(null, false),
      state: cuda?.driverCuda ? "ok" : "unknown",
    },
    {
      label: "cuBLAS 12 file",
      value: yesNo(cuda?.cublas12) ?? text(null, pending),
      state: cuda?.cublas12 === false ? "warn" : cuda?.cublas12 === true ? "ok" : "unknown",
    },
    {
      label: "cuDNN 9 file",
      value: yesNo(cuda?.cudnn9) ?? text(null, pending),
      state: cuda?.cudnn9 === false ? "warn" : cuda?.cudnn9 === true ? "ok" : "unknown",
    },
    {
      label: "Vulkan",
      value: yesNo(f.vulkan) ?? text(null, pending),
      state: f.vulkan === false ? "warn" : f.vulkan === true ? "ok" : "unknown",
    },
  );
  return rows;
}

const MEDIA = { ssd: "SSD", hdd: "hard disk", scm: "storage-class memory" } as const;

function storageRows(f: HardwareFacts, pending: boolean): PcRow[] {
  const drives = f.drives ?? [];
  if (drives.length === 0) {
    return [{ label: "Drives", value: pending ? MEASURING : NOT_MEASURED, state: "unknown" }];
  }
  return drives.map((d) => {
    const holds = [d.holdsDataRoot ? "FRIDAY data" : null, d.holdsModelCache ? "model cache" : null]
      .filter(Boolean)
      .join(" + ");
    const parts = [
      d.totalGb != null ? `${Math.round(d.totalGb)} GB` : null,
      d.freeGb != null ? `${Math.round(d.freeGb * 10) / 10} GB free` : "free space not measured",
      d.media ? MEDIA[d.media] : null,
      holds ? `holds ${holds}` : null,
    ].filter(Boolean);
    const low = d.freeGb != null && d.holdsModelCache && d.freeGb < 10;
    return {
      label: d.letter ? `Drive ${d.letter}` : "Drive",
      value: parts.join(" · "),
      state: low
        ? d.freeGb != null && d.freeGb < 2
          ? "bad"
          : "warn"
        : d.freeGb != null
          ? "ok"
          : "unknown",
    };
  });
}

function networkRows(f: HardwareFacts, pending: boolean): PcRow[] {
  const n = f.network;
  const kind = n?.type
    ? { wifi: "Wi-Fi", ethernet: "Ethernet", cellular: "Cellular", unknown: "unknown type" }[n.type]
    : null;
  return [
    {
      label: "Online",
      value: yesNo(n?.online) ?? text(null, pending),
      state: n?.online === false ? "warn" : n?.online === true ? "ok" : "unknown",
    },
    { label: "Connection", value: text(kind, pending), state: kind ? "ok" : "unknown" },
    {
      label: "Metered",
      value: yesNo(n?.metered) ?? text(null, pending),
      state: n?.metered === true ? "warn" : n?.metered === false ? "ok" : "unknown",
    },
    {
      label: "Round trip",
      // Measured only when the owner allows network use; otherwise it stays unmeasured by design.
      value:
        n?.latencyMs != null
          ? `${n.latencyMs} ms`
          : "not measured (needs network use to be allowed)",
      state: n?.latencyMs != null ? "ok" : "unknown",
    },
  ];
}

function powerRows(f: HardwareFacts, pending: boolean): PcRow[] {
  const p = f.power;
  const battery =
    p?.batteryPresent === false
      ? "no battery (desktop)"
      : p?.batteryPercent != null
        ? `${p.batteryPercent}%${p.onAc === true ? " · plugged in" : p.onAc === false ? " · on battery" : ""}`
        : null;
  return [
    {
      label: "Battery",
      value: text(battery, pending),
      state:
        p?.onAc === false && p.batteryPercent != null && p.batteryPercent < 20
          ? "warn"
          : battery
            ? "ok"
            : "unknown",
    },
    {
      label: "Power plan",
      value: text(p?.planName, pending),
      state: p?.planName ? "ok" : "unknown",
    },
    {
      label: "Battery saver",
      value: yesNo(p?.batterySaver) ?? text(null, pending),
      state: p?.batterySaver === true ? "warn" : p?.batterySaver === false ? "ok" : "unknown",
    },
    {
      label: "Heat",
      value: p?.thermal ?? "not reported by Windows",
      state:
        p?.thermal === "critical"
          ? "bad"
          : p?.thermal === "serious"
            ? "warn"
            : p?.thermal
              ? "ok"
              : "unknown",
    },
  ];
}

/** The governor's own rows (leases, queue, pressure, lag), reused from the voice diagnostics so there is one wording. */
export function governorRows(governor: GovernorStatus | null): PcRow[] {
  if (!governor) {
    return [{ label: "Resource governor", value: "not running", state: "unknown" }];
  }
  const level: PcRow = {
    label: "Pressure",
    value:
      governor.level === "critical"
        ? "critical: new heavy loads are refused"
        : governor.level === "high"
          ? "high: idle models are being unloaded and background work waits"
          : "ok",
    state: governor.level === "critical" ? "bad" : governor.level === "high" ? "warn" : "ok",
  };
  const rows = resourceRows({ phase: "ready", status: governor }).map((row) => ({
    label: row.label.replace(/^resources: /, "").replace(/^./, (c) => c.toUpperCase()),
    value: row.value,
    state: (row.bad ? "bad" : "ok") as RowState,
  }));
  return [level, ...rows];
}

/** Every section of the page, in reading order. `facts` null gives no sections (the page shows its own state). */
export function pcSections(
  facts: HardwareFacts | null,
  governor: GovernorStatus | null,
): PcSection[] {
  if (!facts) return [];
  const pending = capabilityPending(facts);
  return [
    { id: "system", title: "System", rows: osRows(facts, pending) },
    { id: "processor", title: "Processor", rows: cpuRows(facts, pending) },
    { id: "memory", title: "Memory", rows: memoryRows(facts, pending) },
    { id: "graphics", title: "Graphics and acceleration", rows: graphicsRows(facts, pending) },
    { id: "storage", title: "Disks", rows: storageRows(facts, pending) },
    { id: "network", title: "Network", rows: networkRows(facts, pending) },
    { id: "power", title: "Power", rows: powerRows(facts, pending) },
    { id: "governor", title: "Resource governor", rows: governorRows(governor) },
  ];
}

/** One line for the Status page: the health, the memory pressure and the drive that holds the data. */
export function pcSummaryLine(
  facts: HardwareFacts | null,
  governor: GovernorStatus | null,
): string {
  if (!facts) return "Not read yet";
  const health = healthView(facts);
  const parts = [health.title];
  if (facts.ramGb != null && facts.ramFreeGb != null) {
    parts.push(`${facts.ramFreeGb} of ${facts.ramGb} GB memory free`);
  }
  if (governor && governor.level !== "ok") parts.push(`pressure ${governor.level}`);
  return parts.join(" · ");
}
