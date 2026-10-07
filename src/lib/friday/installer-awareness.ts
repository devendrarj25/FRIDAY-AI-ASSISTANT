/**
 * FRIDAY · live Install Manager session (renderer)
 *
 * One shared snapshot of the Install Manager page so Core Brain, Auto Mode,
 * and Chat see the same catalog, queue and probe the owner is looking at.
 * The store stays `installer-engine.ts` / `electron/toolchain.cjs` — this
 * module never opens a second installer.
 */

import {
  installer,
  isJobActive,
  type HistoryEntry,
  type InstallerState,
  type Job,
  type LogLine,
} from "./installer-engine";
import type { CatalogEntry, CatalogStatus } from "./catalog";

export type InstallerFilter = "all" | "installed" | "updates" | "missing" | "required";

export type InstallerSession = {
  desktop: boolean;
  follow: boolean;
  tab: InstallerFilter;
  category: string;
  query: string;
  selectedPkg: string | null;
  scanning: boolean;
  verifying: boolean;
  lastScanAt: number | null;
  entries: CatalogEntry[];
  jobs: Job[];
  log: LogLine[];
  history: HistoryEntry[];
  installed: number;
  updates: number;
  missing: number;
  requiredMissing: number;
};

const empty = (): InstallerSession => ({
  desktop: false,
  follow: true,
  tab: "all",
  category: "all",
  query: "",
  selectedPkg: null,
  scanning: false,
  verifying: false,
  lastScanAt: null,
  entries: [],
  jobs: [],
  log: [],
  history: [],
  installed: 0,
  updates: 0,
  missing: 0,
  requiredMissing: 0,
});

let session: InstallerSession = empty();
let asker: ((prompt: string) => void) | null = null;

function countsFrom(snap: InstallerState, entries: CatalogEntry[]) {
  let installed = 0;
  let updates = 0;
  let missing = 0;
  let requiredMissing = 0;
  for (const entry of entries) {
    const status: CatalogStatus = installer.statusOf(entry);
    if (status === "Up to date" || status === "Update available") installed += 1;
    if (status === "Update available") updates += 1;
    if (status === "Not installed") missing += 1;
    if (entry.requirement === "required" && !snap.installed[entry.pkg]) requiredMissing += 1;
  }
  return { installed, updates, missing, requiredMissing };
}

export function readLiveInstaller(): InstallerSession {
  const snap = installer.getSnapshot();
  const entries = installer.entries();
  const live = countsFrom(snap, entries);
  return {
    ...session,
    desktop: snap.bridge === "desktop" || session.desktop,
    scanning: snap.scanning,
    verifying: snap.verifying,
    lastScanAt: snap.lastScanAt ?? session.lastScanAt,
    entries: entries.length ? entries : session.entries,
    jobs: snap.jobs.length ? snap.jobs : session.jobs,
    log: snap.log.length ? snap.log : session.log,
    history: snap.history.length ? snap.history : session.history,
    ...live,
  };
}

export function installerSnapshot(): InstallerSession {
  return readLiveInstaller();
}

export function publishInstallerSession(patch: Partial<InstallerSession>): InstallerSession {
  session = {
    ...session,
    ...patch,
    entries: patch.entries ? patch.entries.slice(0, 200) : session.entries,
    jobs: patch.jobs ? patch.jobs.slice(0, 80) : session.jobs,
    log: patch.log ? patch.log.slice(0, 240) : session.log,
    history: patch.history ? patch.history.slice(0, 80) : session.history,
  };
  return session;
}

export function registerInstallerAsk(fn: ((prompt: string) => void) | null): void {
  asker = fn;
}

export function requestInstallerAsk(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text || !asker) return false;
  asker(text);
  return true;
}

export function formatInstallerExtra(maxChars = 4000): string {
  const snap = readLiveInstaller();
  const active = snap.jobs.filter((job) => isJobActive(job.phase));
  const missing = snap.entries
    .filter((entry) => entry.requirement === "required" && !installer.installedVersion(entry.pkg))
    .slice(0, 10)
    .map((entry) => entry.pkg)
    .join(", ");
  const selected = snap.selectedPkg
    ? snap.entries.find((entry) => entry.pkg === snap.selectedPkg)
    : undefined;
  const probe = snap.selectedPkg ? installer.probeOf(snap.selectedPkg) : undefined;
  const queue = active
    .slice(0, 8)
    .map(
      (job) => `${job.pkg} ${job.action} ${job.phase} ${Math.round(job.progress)}% — ${job.detail}`,
    )
    .join("\n")
    .slice(-800);
  const log = snap.log
    .slice(0, 16)
    .map((line) => `${line.at} [${line.level}] ${line.line}`)
    .join("\n")
    .slice(-1200);
  const rows = snap.entries
    .slice(0, 20)
    .map((entry) => {
      const status = installer.statusOf(entry);
      const path = installer.probeOf(entry.pkg)?.path || "—";
      return `${entry.pkg} [${status}] ${installer.installedVersion(entry.pkg) ?? "missing"} → ${installer.latestOf(entry)} · ${entry.source} · ${path}`;
    })
    .join("\n")
    .slice(-maxChars);
  return [
    "INSTALL SESSION (live FRIDAY Install Manager — not invented)",
    `desktop: ${snap.desktop ? "yes" : "no (preview)"}`,
    `scanning: ${snap.scanning ? "yes" : "idle"}`,
    `tab: ${snap.tab}`,
    snap.category !== "all" ? `category: ${snap.category}` : "category: all",
    snap.query ? `query: ${snap.query}` : "query: (none)",
    `follow: ${snap.follow ? "on" : "paused"}`,
    `catalog: ${snap.entries.length}`,
    `installed: ${snap.installed}`,
    `updates: ${snap.updates}`,
    `missing: ${snap.missing}`,
    `required missing: ${snap.requiredMissing}${missing ? ` (${missing})` : ""}`,
    `selected: ${snap.selectedPkg || "none"}`,
    selected ? `selected source: ${selected.source} ${selected.url}` : "selected source: none",
    probe?.path ? `selected path: ${probe.path}` : "selected path: (none probed)",
    "active jobs:",
    queue || "(idle)",
    "recent catalog:",
    rows || "(empty)",
    "recent installer log:",
    log || "(empty)",
  ].join("\n");
}

export function resetInstallerSession(): void {
  session = empty();
}
