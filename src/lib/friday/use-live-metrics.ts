import { useEffect, useState } from "react";

/**
 * Live system telemetry for the main window.
 *
 * In the desktop app every number here is measured by the main process
 * (`electron/system-monitor.cjs`): CPU from tick deltas, RAM from the OS, GPU
 * and VRAM from nvidia-smi. There is one shared sampler for the whole app, so
 * opening ten screens costs exactly one interval and zero extra process spawns.
 *
 * A reading this machine cannot take (no NVIDIA GPU, for example) reports 0
 * with a "not available" detail — never an invented value. Outside Electron
 * the hook keeps a clearly-marked simulated signal (`live: false`) so the
 * browser preview still renders.
 */

export type LiveMetric = { label: string; value: number; detail: string; available: boolean };

export type LiveMetrics = {
  cpu: LiveMetric;
  gpu: LiveMetric;
  ram: LiveMetric;
  vram: LiveMetric;
  net: { up: string; down: string; series: number[] };
  uptime: string;
  live: boolean;
  at: number;
};

/** Raw sample pushed by the main process. */
export type SystemSample = {
  at: number;
  cpu: { percent: number | null; cores: number; model: string };
  ram: { percent: number | null; usedGb: number; freeGb: number; totalGb: number };
  gpu: {
    available: boolean;
    name: string | null;
    percent: number | null;
    vramUsedMb: number | null;
    vramTotalMb: number | null;
    vramPercent: number | null;
    temperatureC: number | null;
    reason: string | null;
  };
  disks: { id: string; totalGb: number; freeGb: number; percent: number }[];
  network?: {
    available: boolean;
    downMbps: number | null;
    upMbps: number | null;
    addresses: { name: string; address: string; mac: string | null }[];
    reason: string | null;
  };
  uptime: string;
};

type Bridge = {
  systemMetrics?: () => Promise<SystemSample | null>;
  subscribeSystemMetrics?: () => Promise<SystemSample | null>;
  unsubscribeSystemMetrics?: () => Promise<boolean>;
  onSystemMetrics?: (cb: (sample: SystemSample) => void) => () => void;
};

const bridge = (): Bridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: Bridge }).friday ?? null);

const PREVIEW: LiveMetrics = {
  cpu: { label: "CPU", value: 23, detail: "preview (not measured)", available: false },
  gpu: { label: "GPU", value: 41, detail: "preview (not measured)", available: false },
  ram: { label: "RAM", value: 45, detail: "preview (not measured)", available: false },
  vram: { label: "VRAM", value: 38, detail: "preview (not measured)", available: false },
  net: {
    up: "—",
    down: "—",
    series: [8, 14, 9, 22, 16, 11, 28, 19, 24, 13, 31, 17, 26, 12, 20, 15, 29, 18],
  },
  uptime: "—",
  live: false,
  at: 0,
};

const drift = (v: number, spread = 6) =>
  Math.min(98, Math.max(3, Math.round(v + (Math.random() - 0.5) * spread))); // preview only

const mbps = (value: number | null | undefined) =>
  typeof value === "number" && value >= 0 ? `${value.toFixed(value >= 10 ? 0 : 1)} Mbps` : "—";

/** Network panel + sparkline, driven by measured interface throughput. */
function netMetric(sample: SystemSample, previous: LiveMetrics): LiveMetrics["net"] {
  const net = sample.network;
  const down = typeof net?.downMbps === "number" ? net.downMbps : null;
  const series = [...previous.net.series.slice(1), down ?? 0];
  const peak = Math.max(1, ...series);
  return {
    up: mbps(net?.upMbps),
    down: mbps(down),
    // Keep raw Mbps in the series and scale on read, so the shape stays honest
    // as throughput grows.
    series: series.map((v) => Math.round((v / peak) * 100)),
  };
}

const gb = (mb: number | null) => (mb === null ? null : Math.round((mb / 1024) * 10) / 10);

function toMetrics(sample: SystemSample, previous: LiveMetrics): LiveMetrics {
  const gpu = sample.gpu;
  const vramDetail =
    gpu.vramTotalMb !== null
      ? `${gb(gpu.vramUsedMb) ?? 0} / ${gb(gpu.vramTotalMb)} GB`
      : (gpu.reason ?? "not available");
  return {
    cpu: {
      label: "CPU",
      value: sample.cpu.percent ?? 0,
      detail: `${sample.cpu.model} · ${sample.cpu.cores} cores`,
      available: sample.cpu.percent !== null,
    },
    gpu: {
      label: "GPU",
      value: gpu.percent ?? 0,
      detail: gpu.available
        ? `${gpu.name}${gpu.temperatureC !== null ? ` · ${gpu.temperatureC}°C` : ""}`
        : (gpu.reason ?? "not available"),
      available: gpu.percent !== null,
    },
    ram: {
      label: "RAM",
      value: sample.ram.percent ?? 0,
      detail: `${sample.ram.usedGb} / ${sample.ram.totalGb} GB`,
      available: sample.ram.percent !== null,
    },
    vram: {
      label: "VRAM",
      value: gpu.vramPercent ?? 0,
      detail: vramDetail,
      available: gpu.vramPercent !== null,
    },
    // Real throughput from the OS interface counters. The sparkline plots the
    // measured download rate (normalised to 0-100 against the rolling peak) —
    // never the CPU signal, and never a random walk.
    net: netMetric(sample, previous),
    uptime: sample.uptime,
    live: true,
    at: sample.at,
  };
}

export function useLiveMetrics(): LiveMetrics {
  const [state, setState] = useState<LiveMetrics>(PREVIEW);

  useEffect(() => {
    const api = bridge();

    // Browser preview: no bridge, no measurements. Keep an obviously-simulated
    // signal so the HUD still animates, flagged with live: false.
    if (!api?.onSystemMetrics) {
      const id = setInterval(() => {
        setState((prev) => ({
          ...prev,
          cpu: { ...prev.cpu, value: drift(prev.cpu.value) },
          gpu: { ...prev.gpu, value: drift(prev.gpu.value, 10) },
          ram: { ...prev.ram, value: drift(prev.ram.value, 4) },
          vram: { ...prev.vram, value: drift(prev.vram.value, 5) },
          net: {
            ...prev.net,
            series: [...prev.net.series.slice(1), drift(prev.net.series.at(-1) ?? 18, 18)],
          },
        }));
      }, 2000);
      return () => clearInterval(id);
    }

    let active = true;
    const apply = (sample: SystemSample | null) => {
      if (!active || !sample) return;
      publishSample(sample);
      setState((prev) => toMetrics(sample, prev));
    };

    const off = api.onSystemMetrics(apply);
    void api.subscribeSystemMetrics?.().then(apply);

    return () => {
      active = false;
      off?.();
      void api.unsubscribeSystemMetrics?.();
    };
  }, []);

  return state;
}

/* ------------------------------------------------------------ raw sample --
 * The status board needs fields the HUD metrics do not carry (disks, network
 * interfaces, per-core counts). They come from the SAME shared sampler in the
 * main process — this store just keeps the last raw sample so no extra
 * interval or process spawn is created anywhere in the app.
 */
let lastSample: SystemSample | null = null;
const sampleListeners = new Set<() => void>();

function publishSample(sample: SystemSample) {
  lastSample = sample;
  for (const fn of sampleListeners) fn();
}

/** Last raw measurement from the main process (null in the browser preview). */
export function useSystemSample(): SystemSample | null {
  const [sample, setSample] = useState<SystemSample | null>(lastSample);

  useEffect(() => {
    const api = bridge();
    let active = true;
    const bump = () => {
      if (active) setSample(lastSample);
    };
    sampleListeners.add(bump);

    // Ask once immediately so the panel is filled the moment the page opens,
    // then ride the shared subscription owned by useLiveMetrics.
    void api?.systemMetrics?.().then((value) => {
      if (value) publishSample(value);
    });
    const off = api?.onSystemMetrics?.((value) => publishSample(value));
    void api?.subscribeSystemMetrics?.().then((value) => value && publishSample(value));

    return () => {
      active = false;
      sampleListeners.delete(bump);
      off?.();
      void api?.unsubscribeSystemMetrics?.();
    };
  }, []);

  return sample;
}
