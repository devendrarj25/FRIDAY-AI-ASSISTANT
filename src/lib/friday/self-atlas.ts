/**
 * FRIDAY · Self Atlas (renderer)
 *
 * The desktop builds the atlas from real probes (`electron/self-atlas.cjs`) and the PC reliability
 * report (`electron/hardware.cjs`). This module holds the last answer so Core Brain, the pages and
 * the world model read the same snapshot, and turns a snapshot into plain sentences that cite where
 * each fact came from. It never probes anything itself and never invents a value.
 */

export type AtlasStatus = "ok" | "warn" | "bad" | "unknown";

export type AtlasFact = {
  group: string;
  id: string;
  label: string;
  value: string;
  status: AtlasStatus;
  source: string;
  readAt: number;
  confidence: number;
  note?: string;
};

export type AtlasSnapshot = {
  schema: number;
  readAt: number;
  root: string;
  facts: AtlasFact[];
  groups: Record<string, { total: number; ok: number; warn: number; bad: number; unknown: number }>;
  counts: Record<AtlasStatus, number>;
  summary: string;
};

export type ReliabilityItem = {
  id: string;
  label: string;
  state: AtlasStatus;
  detail: string;
  count?: number;
  /** Crash rows only: which programs crashed, and how often. */
  apps?: { app: string; count: number }[];
};

export type ReliabilityReport = {
  detectedAt: number;
  supported: boolean;
  items: ReliabilityItem[];
};

type Bridge = {
  selfAtlas?: () => Promise<AtlasSnapshot | null>;
  detectReliability?: () => Promise<ReliabilityReport | null>;
};

const bridge = (): Bridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: Bridge }).friday ?? null);

export const ATLAS_GROUP_TITLES: Record<string, string> = {
  location: "Where I am",
  version: "Version",
  processes: "What is running",
  config: "Configuration",
  data: "Data",
  backups: "Backups",
  logs: "Logs",
  inventory: "Tools and models",
};

export const ATLAS_GROUP_ORDER = Object.keys(ATLAS_GROUP_TITLES);

/** How long a read stays good before the brain asks the desktop again. */
export const ATLAS_FRESH_MS = 15_000;
export const RELIABILITY_FRESH_MS = 120_000;

let atlas: AtlasSnapshot | null = null;
let reliability: ReliabilityReport | null = null;
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`: a page re-renders when a new answer arrives. */
export function subscribeSelfAtlas(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function selfAtlasVersion(): number {
  return version;
}

export function latestAtlas(): AtlasSnapshot | null {
  return atlas;
}

export function latestReliability(): ReliabilityReport | null {
  return reliability;
}

export function resetSelfAtlasForTests(): void {
  atlas = null;
  reliability = null;
  version = 0;
}

/** Keep an answer the desktop already produced (a page that polls uses this). */
export function publishAtlas(next: AtlasSnapshot | null): void {
  if (next && Array.isArray(next.facts)) {
    atlas = next;
    changed();
  }
}

export function publishReliability(next: ReliabilityReport | null): void {
  if (next && Array.isArray(next.items)) {
    reliability = next;
    changed();
  }
}

/** True when the desktop app (and so the probes) is present. */
export function selfAtlasAvailable(): boolean {
  return Boolean(bridge()?.selfAtlas);
}

/**
 * Read the atlas. A recent answer is reused unless `force` is set (the Refresh button).
 * With `strict`, a failed read throws so a page can show the error and a Retry.
 */
export async function refreshAtlas(
  now = Date.now(),
  options: { force?: boolean; strict?: boolean } = {},
): Promise<AtlasSnapshot | null> {
  if (!options.force && atlas && now - atlas.readAt < ATLAS_FRESH_MS) return atlas;
  try {
    publishAtlas((await bridge()?.selfAtlas?.()) ?? null);
  } catch (error) {
    if (options.strict) throw error;
    /* keep the last answer; the sentence says how old it is */
  }
  return atlas;
}

export async function refreshReliability(
  now = Date.now(),
  options: { force?: boolean; strict?: boolean } = {},
): Promise<ReliabilityReport | null> {
  if (!options.force && reliability && now - reliability.detectedAt < RELIABILITY_FRESH_MS) {
    return reliability;
  }
  try {
    publishReliability((await bridge()?.detectReliability?.()) ?? null);
  } catch (error) {
    if (options.strict) throw error;
    /* keep the last answer */
  }
  return reliability;
}

export function ageText(readAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - readAt) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 90) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** One fact as a sentence the owner can check: value, then source, age and confidence. */
export function describeFact(fact: AtlasFact, now = Date.now()): string {
  if (fact.status === "unknown") {
    return `${fact.label}: not inspected${fact.note ? ` (${fact.note})` : ""}.`;
  }
  const flag = fact.status === "ok" ? "" : ` [${fact.status}]`;
  const note = fact.note ? ` — ${fact.note}` : "";
  return `${fact.label}: ${fact.value}${flag}${note} (${fact.source}, read ${ageText(fact.readAt, now)}, ${Math.round(fact.confidence * 100)}% sure)`;
}

export function formatAtlas(
  snapshot: AtlasSnapshot,
  options: { groups?: string[]; now?: number } = {},
): string {
  const now = options.now ?? Date.now();
  const wanted = options.groups?.length ? options.groups : ATLAS_GROUP_ORDER;
  const lines = [`Read from live probes ${ageText(snapshot.readAt, now)} — ${snapshot.summary}.`];
  for (const group of wanted) {
    const rows = snapshot.facts.filter((fact) => fact.group === group);
    if (!rows.length) continue;
    lines.push("", `${ATLAS_GROUP_TITLES[group] ?? group}:`);
    for (const fact of rows) lines.push(`• ${describeFact(fact, now)}`);
  }
  if (snapshot.counts.unknown) {
    lines.push(
      "",
      "A line marked 'not inspected' was not read. I will not call it healthy until a probe reads it.",
    );
  }
  return lines.join("\n");
}

export function formatReliability(report: ReliabilityReport, now = Date.now()): string {
  if (!report.supported) {
    const reason = report.items[0]?.detail ?? "not supported here";
    return `The reliability probes read Windows only, and this machine says: ${reason}.`;
  }
  const lines = [`PC reliability, read ${ageText(report.detectedAt, now)}:`];
  for (const item of report.items) {
    const flag = item.state === "ok" ? "" : ` [${item.state}]`;
    lines.push(
      item.state === "unknown"
        ? `• ${item.label}: not inspected (${item.detail})`
        : `• ${item.label}${flag}: ${item.detail}`,
    );
  }
  if (report.items.some((item) => item.state === "unknown")) {
    lines.push("", "A line marked 'not inspected' could not be read; it is not a clean result.");
  }
  return lines.join("\n");
}

/** One line for the world model: counts only, no paths and no names. */
export function atlasWorldLine(snapshot: AtlasSnapshot | null): string {
  if (!snapshot) return "not inspected yet";
  return snapshot.summary;
}

export function reliabilityWorldLine(report: ReliabilityReport | null): string {
  if (!report) return "not inspected yet";
  if (!report.supported) return "not available on this machine";
  const flagged = report.items.filter((item) => item.state === "warn" || item.state === "bad");
  const unknown = report.items.filter((item) => item.state === "unknown").length;
  return `${report.items.length - flagged.length - unknown} ok, ${flagged.length} need a look, ${unknown} not inspected`;
}
