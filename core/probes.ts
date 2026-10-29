/**
 * FRIDAY · core/probes
 *
 * Read-only machine probes shared by the `system/` modules. Every value comes
 * from Node built-ins or, on Windows only, a read-only PowerShell/WMI query.
 * Nothing here mutates the machine and nothing is simulated: when a value
 * cannot be read the probe reports `available: false` instead of a number.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const isWindows = process.platform === "win32";

export interface Probe<T> {
  available: boolean;
  value: T | null;
  reason?: string;
}

const unavailable = <T>(reason: string): Probe<T> => ({ available: false, value: null, reason });
const ok = <T>(value: T): Probe<T> => ({ available: true, value });

/** Runs a read-only PowerShell expression and parses its JSON output. */
export function powershellJson<T = unknown>(expression: string, timeout = 6000): Probe<T> {
  if (!isWindows) return unavailable("windows only");
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `${expression} | ConvertTo-Json -Compress`],
      { encoding: "utf8", timeout, windowsHide: true },
    );
    const text = out.trim();
    if (!text) return unavailable("no data");
    return ok(JSON.parse(text) as T);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "powershell failed");
  }
}

/* ----------------------------------------------------------------- processes */

export interface ProcessInfo {
  pid: number;
  name: string;
  memoryMb: number;
}

export function currentProcess() {
  const usage = process.memoryUsage();
  return {
    pid: process.pid,
    node: process.versions.node,
    electron: process.versions["electron"] ?? null,
    uptimeSeconds: Math.round(process.uptime()),
    rssMb: Math.round((usage.rss / 1024 / 1024) * 10) / 10,
    heapMb: Math.round((usage.heapUsed / 1024 / 1024) * 10) / 10,
  };
}

export function topProcesses(limit = 10): Probe<ProcessInfo[]> {
  const probe = powershellJson<
    | { Id: number; ProcessName: string; WorkingSet: number }[]
    | { Id: number; ProcessName: string; WorkingSet: number }
  >(
    `Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First ${limit} Id,ProcessName,WorkingSet`,
  );
  if (!probe.available || !probe.value) return unavailable(probe.reason ?? "unavailable");
  const rows = Array.isArray(probe.value) ? probe.value : [probe.value];
  return ok(
    rows.map((row) => ({
      pid: Number(row.Id),
      name: String(row.ProcessName),
      memoryMb: Math.round((Number(row.WorkingSet) / 1024 / 1024) * 10) / 10,
    })),
  );
}

/* ------------------------------------------------------------------ services */

export interface ServiceInfo {
  name: string;
  displayName: string;
  status: string;
}

export function services(limit = 40): Probe<ServiceInfo[]> {
  const probe = powershellJson<{ Name: string; DisplayName: string; Status: number | string }[]>(
    `Get-Service | Select-Object -First ${limit} Name,DisplayName,Status`,
  );
  if (!probe.available || !probe.value) return unavailable(probe.reason ?? "unavailable");
  const rows = Array.isArray(probe.value) ? probe.value : [probe.value];
  return ok(
    rows.map((row) => ({
      name: String(row.Name),
      displayName: String(row.DisplayName ?? row.Name),
      status: String(row.Status),
    })),
  );
}

/* ------------------------------------------------------------------ registry */

export function registryValue(keyPath: string, name: string): Probe<string> {
  if (!isWindows) return unavailable("windows only");
  try {
    const out = execFileSync("reg.exe", ["query", keyPath, "/v", name], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      // A missing key is a normal answer ("not installed"), not a failure:
      // keep reg.exe's error text out of FRIDAY's own logs.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`, "i"));
    return match?.[1] ? ok(match[1].trim()) : unavailable("value not found");
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "reg query failed");
  }
}

/* --------------------------------------------------------------- environment */

export function environment(root: string) {
  const pkg = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
        version?: string;
      };
    } catch {
      return {};
    }
  })();
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    hostname: os.hostname(),
    user: os.userInfo().username,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    root,
    appVersion: pkg.version ?? null,
    node: process.versions.node,
    uptimeSeconds: Math.round(os.uptime()),
    totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMb: Math.round(os.freemem() / 1024 / 1024),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
  };
}

/* --------------------------------------------------------------------- power */

export interface PowerInfo {
  hasBattery: boolean;
  percent: number | null;
  charging: boolean | null;
}

export function power(): Probe<PowerInfo> {
  const probe = powershellJson<{ EstimatedChargeRemaining?: number; BatteryStatus?: number }>(
    "Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus",
  );
  if (!probe.available) return unavailable(probe.reason ?? "unavailable");
  if (!probe.value) return ok({ hasBattery: false, percent: null, charging: null });
  const percent = Number(probe.value.EstimatedChargeRemaining);
  const status = Number(probe.value.BatteryStatus);
  return ok({
    hasBattery: Number.isFinite(percent),
    percent: Number.isFinite(percent) ? percent : null,
    charging: Number.isFinite(status) ? status === 2 : null,
  });
}

/* ------------------------------------------------------------------- network */

export interface InterfaceInfo {
  name: string;
  address: string;
  family: string;
  internal: boolean;
  mac: string;
}

export function interfaces(): InterfaceInfo[] {
  const out: InterfaceInfo[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list ?? []) {
      out.push({
        name,
        address: item.address,
        family: String(item.family),
        internal: item.internal,
        mac: item.mac,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------- devices */

export interface DeviceInfo {
  name: string;
  className: string;
  status: string;
}

export function devices(limit = 60): Probe<DeviceInfo[]> {
  const probe = powershellJson<{ Name: string; Class: string; Status: string }[]>(
    `Get-PnpDevice -PresentOnly | Select-Object -First ${limit} Name,Class,Status`,
  );
  if (!probe.available || !probe.value) return unavailable(probe.reason ?? "unavailable");
  const rows = Array.isArray(probe.value) ? probe.value : [probe.value];
  return ok(
    rows.map((row) => ({
      name: String(row.Name),
      className: String(row.Class ?? ""),
      status: String(row.Status ?? ""),
    })),
  );
}

/** Motherboard / OS caption strip shown on the System page. */
export function machine(): Probe<{ board: string; system: string; bios: string }> {
  const board = powershellJson<{ Manufacturer: string; Product: string }>(
    "Get-CimInstance Win32_BaseBoard | Select-Object -First 1 Manufacturer,Product",
  );
  const system = powershellJson<{ Caption: string; Version: string }>(
    "Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 Caption,Version",
  );
  const bios = powershellJson<{ SMBIOSBIOSVersion: string }>(
    "Get-CimInstance Win32_BIOS | Select-Object -First 1 SMBIOSBIOSVersion",
  );
  if (!board.available && !system.available) return unavailable(board.reason ?? "unavailable");
  return ok({
    board: board.value ? `${board.value.Manufacturer} ${board.value.Product}`.trim() : "unknown",
    system: system.value ? `${system.value.Caption} ${system.value.Version}`.trim() : os.release(),
    bios: bios.value ? String(bios.value.SMBIOSBIOSVersion) : "unknown",
  });
}

/* -------------------------------------------------------------- applications */

export interface InstalledApp {
  name: string;
  version: string | null;
  publisher: string | null;
}

export function installedApps(limit = 200): Probe<InstalledApp[]> {
  const probe = powershellJson<
    { DisplayName: string; DisplayVersion: string; Publisher: string }[]
  >(
    "Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' " +
      "| Where-Object DisplayName | Select-Object DisplayName,DisplayVersion,Publisher",
    10_000,
  );
  if (!probe.available || !probe.value) return unavailable(probe.reason ?? "unavailable");
  const rows = Array.isArray(probe.value) ? probe.value : [probe.value];
  return ok(
    rows.slice(0, limit).map((row) => ({
      name: String(row.DisplayName),
      version: row.DisplayVersion ? String(row.DisplayVersion) : null,
      publisher: row.Publisher ? String(row.Publisher) : null,
    })),
  );
}
