/**
 * FRIDAY · PC awareness
 *
 * What FRIDAY can say about this machine WITHOUT any AI model.
 *
 * Every number here is a real measurement taken by the main process
 * (`electron/system-monitor.cjs`) or by the live network meter — nothing is
 * estimated and nothing is cached from a previous session. When a reading
 * genuinely cannot be taken on this hardware, the sentence says so instead of
 * inventing a plausible value.
 *
 * The wording is conversational on purpose: these answers are spoken as often
 * as they are read, so they read like a person reporting, not a dashboard.
 */

import type { SystemSample } from "../use-live-metrics";
import { networkMeter } from "../network";
import { readSystemContext } from "../system-context";

type Bridge = {
  systemMetrics?: () => Promise<SystemSample | null>;
};

const bridge = (): Bridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: Bridge }).friday ?? null);

const OFFLINE_DESKTOP =
  "I can only read this machine's hardware from the desktop app — the browser preview doesn't expose it.";

async function sample(): Promise<SystemSample | null> {
  try {
    return (await bridge()?.systemMetrics?.()) ?? null;
  } catch {
    return null;
  }
}

const gb = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)} GB`;

/* ------------------------------------------------------------------ disks */

export async function describeDisks(): Promise<string> {
  const data = await sample();
  if (!data) return OFFLINE_DESKTOP;
  const disks = data.disks ?? [];
  if (!disks.length) return "I couldn't read any drive from this machine right now.";
  const lines = disks.map((disk) => {
    const used = disk.totalGb - disk.freeGb;
    return `${disk.id} — ${gb(disk.freeGb)} free of ${gb(disk.totalGb)} (${Math.round(disk.percent)}% used, ${gb(used)} in use)`;
  });
  const tight = disks.filter((disk) => disk.percent >= 90 || disk.freeGb < 10);
  return [
    disks.length === 1 ? "Here's your drive:" : "Here are your drives:",
    ...lines.map((line) => `• ${line}`),
    tight.length
      ? `${tight.map((d) => d.id).join(", ")} is getting tight — worth clearing something before the next big model download.`
      : "Plenty of room everywhere.",
  ].join("\n");
}

/* -------------------------------------------------------------- cpu / ram */

export async function describeLoad(): Promise<string> {
  const data = await sample();
  if (!data) return OFFLINE_DESKTOP;
  const parts: string[] = [];
  if (data.cpu?.percent !== null && data.cpu?.percent !== undefined) {
    parts.push(
      `CPU is at ${Math.round(data.cpu.percent)}% across ${data.cpu.cores} cores (${data.cpu.model}).`,
    );
  }
  if (data.ram) {
    parts.push(
      `RAM: ${gb(data.ram.usedGb)} of ${gb(data.ram.totalGb)} in use, ${gb(data.ram.freeGb)} free.`,
    );
  }
  if (data.gpu?.available) {
    const vram =
      data.gpu.vramUsedMb !== null && data.gpu.vramTotalMb !== null
        ? `, VRAM ${Math.round(data.gpu.vramUsedMb / 1024)} / ${Math.round(data.gpu.vramTotalMb / 1024)} GB`
        : "";
    parts.push(
      `GPU ${data.gpu.name ?? "detected"} at ${data.gpu.percent ?? 0}%${vram}${
        data.gpu.temperatureC ? ` at ${data.gpu.temperatureC}°C` : ""
      }.`,
    );
  } else if (data.gpu?.reason) {
    parts.push(`No GPU reading — ${data.gpu.reason}.`);
  }
  if (data.uptime) parts.push(`This machine has been up ${data.uptime}.`);
  return parts.join(" ");
}

/* ---------------------------------------------------------------- network */

export async function describeNetwork(): Promise<string> {
  const net = networkMeter.getSnapshot();
  const ctx = readSystemContext();
  if (!net.online || !ctx.online)
    return "You're offline right now — nothing is reaching the network.";
  const bits: string[] = ["You're online."];
  if (net.latencyMs >= 0) bits.push(`Latency ${Math.round(net.latencyMs)} ms.`);
  if (net.downMbps >= 0) bits.push(`Measured download ${net.downMbps.toFixed(1)} Mbps.`);
  const data = await sample();
  const addresses = data?.network?.addresses ?? [];
  if (addresses.length) {
    bits.push(
      `On ${addresses
        .slice(0, 2)
        .map((entry) => `${entry.name} (${entry.address})`)
        .join(" and ")}.`,
    );
  }
  if (net.source === "navigator") bits.push("That's the browser's own estimate, not a live probe.");
  return bits.join(" ");
}

/* ---------------------------------------------------------------- battery */

type BatteryLike = { level: number; charging: boolean; dischargingTime: number };

export async function describeBattery(): Promise<string> {
  const nav =
    typeof navigator === "undefined"
      ? null
      : (navigator as Navigator & {
          getBattery?: () => Promise<BatteryLike>;
        });
  if (!nav?.getBattery) return "This machine doesn't report a battery — it looks like a desktop.";
  try {
    const battery = await nav.getBattery();
    const percent = Math.round(battery.level * 100);
    if (battery.charging) return `Battery is at ${percent}% and charging.`;
    const minutes =
      Number.isFinite(battery.dischargingTime) && battery.dischargingTime > 0
        ? Math.round(battery.dischargingTime / 60)
        : null;
    const left = minutes ? ` — roughly ${Math.floor(minutes / 60)}h ${minutes % 60}m left` : "";
    return `Battery is at ${percent}%, running on battery${left}.${
      percent <= 20 ? " Worth plugging in before anything heavy." : ""
    }`;
  } catch {
    return "This machine doesn't report a battery — it looks like a desktop.";
  }
}

/* --------------------------------------------------------------- overview */

export async function describeMachine(): Promise<string> {
  const [load, disks, net, battery] = await Promise.all([
    describeLoad(),
    describeDisks(),
    describeNetwork(),
    describeBattery(),
  ]);
  return [load, "", disks, "", net, battery].filter(Boolean).join("\n");
}
