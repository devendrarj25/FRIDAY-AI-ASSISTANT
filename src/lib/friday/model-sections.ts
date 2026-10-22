/**
 * Models screen sections. Every existing tab stays reachable from one section.
 * The renderer never marks an installer runnable: Windows signature checks
 * stay in electron/local-library.cjs.
 */

export const MODEL_SECTIONS = [
  { key: "local", label: "LOCAL AI" },
  { key: "cloud", label: "CLOUD AI" },
  { key: "routing", label: "ROUTING" },
] as const;

export type ModelSection = (typeof MODEL_SECTIONS)[number]["key"];

export const SECTION_TABS: Record<ModelSection, readonly string[]> = {
  local: ["catalog", "installed", "runtime", "benchmarks", "connect", "activity"],
  cloud: ["providers", "catalog", "connect", "activity"],
  routing: ["routing"],
};

export const LOCAL_ANSWER_STRATEGIES = ["show-all", "first-good", "majority", "judged"] as const;

export type LocalAnswer = (typeof LOCAL_ANSWER_STRATEGIES)[number];

export function isModelSection(value: string): value is ModelSection {
  return MODEL_SECTIONS.some((section) => section.key === value);
}

export function tabsForSection(section: ModelSection) {
  return SECTION_TABS[section];
}

export function sectionCovers(tabKeys: readonly string[]) {
  const covered = new Set(Object.values(SECTION_TABS).flat());
  return tabKeys.filter((key) => !covered.has(key));
}

export function normaliseLocalAnswer(value: string): LocalAnswer {
  return (LOCAL_ANSWER_STRATEGIES as readonly string[]).includes(value)
    ? (value as LocalAnswer)
    : "show-all";
}

type RunnerRelease = {
  url?: string;
  bytes?: number | null;
  sha256?: string | null;
} | null;

/** Days since the pin date in config/local-runners.json. The file is not rewritten. */
export function pinAgeDays(checked: string, now = Date.now()): number | null {
  const start = Date.parse(`${String(checked || "").slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((now - start) / 86_400_000));
}

export function pinAgeLabel(checked: string, now = Date.now()): string {
  const days = pinAgeDays(checked, now);
  return days == null ? "Pin age: unknown" : `Pin age: ${days} days`;
}

export function launcherLines(
  runner: { officialPage?: string; release?: RunnerRelease },
  clicked = false,
) {
  const release = runner.release;
  if (!release?.url) {
    return {
      source: runner.officialPage || "",
      size: "",
      check: "no pinned installer; open the official page",
      canRun: false,
    };
  }
  if (!release.sha256) {
    return {
      source: release.url,
      size: release.bytes ? String(release.bytes) : "",
      check: "the vendor did not publish a sha256 for this asset",
      canRun: false,
    };
  }
  if (!clicked) {
    return {
      source: release.url,
      size: String(release.bytes || ""),
      check: "waiting for an owner click",
      canRun: false,
    };
  }
  return {
    source: release.url,
    size: String(release.bytes || ""),
    check: "Windows signature has not been checked",
    canRun: false,
  };
}

export function selectCloud(
  models: { id: string; type?: string; access?: string }[],
  mode: "free" | "paid" | "both",
  paidEnabled: boolean,
) {
  const cloud = models.filter((model) => model.type === "cloud");
  const free = cloud.filter((model) => model.access === "free").map((model) => model.id);
  const paid = cloud.filter((model) => model.access === "paid").map((model) => model.id);
  if (mode === "free") return { ids: free, refused: "" };
  if (!paidEnabled) {
    return { ids: free, refused: "Paid models stay off until you confirm." };
  }
  if (mode === "paid") return { ids: paid, refused: "" };
  return { ids: [...free, ...paid], refused: "" };
}

export function firstPage<T>(rows: T[], count: number) {
  const take = Math.max(0, count);
  return { rows: rows.slice(0, take), more: rows.length > take };
}

function ageWords(ageMs: number): string {
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * One plain line per pricing source: why its models are called free, when the
 * official page was last read, and whether that copy is fresh or the last good
 * one ("cached"). A cached copy keeps proven-free models free. No proof at all
 * stays unknown.
 */
export function knowledgeLine(row: {
  id: string;
  basis: string;
  ageMs: number | null;
  state: "fresh" | "cached" | "no-proof";
}): string {
  if (row.state === "no-proof" || row.ageMs == null) {
    return `${row.id}: no official evidence yet, models stay unknown (${row.basis})`;
  }
  const when = `read ${ageWords(row.ageMs)} ago`;
  return row.state === "fresh"
    ? `${row.id}: ${row.basis}, ${when}`
    : `${row.id}: ${row.basis}, cached ${ageWords(row.ageMs)}. Refresh is due; proven-free models stay free until it runs.`;
}
