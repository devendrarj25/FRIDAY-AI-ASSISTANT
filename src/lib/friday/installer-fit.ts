/**
 * What the Install Manager and the Models page show about each downloadable row, from the catalogue the main process
 * built (`installer:catalog`, electron/installer-catalog.cjs): three groups by fit for THIS PC, the version and update
 * badges, the buttons a row may have, and the notices above the list. Pure: it only words and orders what the
 * catalogue returned. The fit itself is never worked out here (electron/engine-fit.cjs owns that).
 */
import type {
  EngineFit,
  InstallerCatalog,
  InstallerCatalogRow,
  InstallerDoctorRow,
  InstallerRefreshResult,
  InstallerUpdateResult,
} from "./desktop";
import { ageLabel } from "./page-state";

export type FitState = EngineFit["state"];
export type RowKind = InstallerCatalogRow["kind"];
export type Tone = "primary" | "accent" | "warning" | "magenta" | "destructive" | "muted";

export type FitGroupSpec = {
  state: FitState;
  title: string;
  hint: string;
  /** The "not supported" list is folded until opened; it still lists every row. */
  collapsedByDefault: boolean;
};

export const FIT_GROUPS: readonly FitGroupSpec[] = [
  {
    state: "supported",
    title: "Ready for this PC",
    hint: "This PC meets every need of these.",
    collapsedByDefault: false,
  },
  {
    state: "limited",
    title: "Works with limits",
    hint: "These run, with a caveat. Read the lines before you install.",
    collapsedByDefault: false,
  },
  {
    state: "unsupported",
    title: "Not supported on this PC",
    hint: "Bigger things exist, but this PC cannot run them. Every one is listed, with what it would need.",
    collapsedByDefault: true,
  },
] as const;

/** The group title of a state ("Ready for this PC"), for a chip beside a row or a pack. */
export const fitTitle = (state: FitState): string =>
  FIT_GROUPS.find((group) => group.state === state)?.title ?? "Works with limits";

/** The scopes the two pages ask for. */
export const INSTALLER_SCOPES = {
  installManager: ["tool", "engine", "runtime-pack"],
  models: ["voice-model", "model"],
} as const satisfies Record<string, readonly RowKind[]>;

export type InstallerScope = keyof typeof INSTALLER_SCOPES;

const SOURCE_LABEL: Record<string, string> = {
  "github-api": "GitHub releases",
  "github-atom": "GitHub releases feed",
  "pypi-json": "PyPI",
  "pypi-simple": "PyPI",
  "hf-api": "Hugging Face",
  npm: "npm",
  feed: "vendor feed",
  pinned: "pinned by FRIDAY",
};

export const sourceLabel = (source: string | null | undefined): string =>
  source ? (SOURCE_LABEL[source] ?? source) : "no source yet";

export type Badge = { id: string; label: string; tone: Tone; title?: string };

/** The update badge, and a second "Saved answer" badge when the version is the last cached one. */
export function updateBadges(row: InstallerCatalogRow): Badge[] {
  const out: Badge[] = [];
  switch (row.updateStatus) {
    case "update":
      out.push({
        id: "update",
        label: "Update available",
        tone: "warning",
        title: `${row.installedVersion ?? "installed"} -> ${row.latestVersion ?? "newer"}`,
      });
      break;
    case "current":
      out.push({ id: "current", label: "Up to date", tone: "accent" });
      break;
    case "error":
      out.push({
        id: "error",
        label: "Check failed",
        tone: "destructive",
        title: row.error || "No official source answered",
      });
      break;
    default:
      out.push({
        id: "unknown",
        label: "Unknown",
        tone: "muted",
        title: row.pinnedAnswer
          ? "FRIDAY only knows the version it ships, not what is newest"
          : "Not enough to compare the installed and the latest version",
      });
  }
  if (row.stale)
    out.push({
      id: "stale",
      label: "Stale",
      tone: "muted",
      title: "The last saved answer; the official sources could not be reached",
    });
  return out;
}

/** "checked 3 min ago" or "not checked yet". */
export function checkedText(checkedAt: number | null | undefined, now: number): string {
  return checkedAt == null ? "not checked yet" : `checked ${ageLabel(checkedAt, now)}`;
}

const NEED_ORDER = ["ramGb", "vramGb", "diskGb", "cuda", "driverMin", "vulkan", "avx2"] as const;

/** What a row would need, one short phrase each, only for needs the catalogue names. */
export function needLines(needs: EngineFit["needs"] | null | undefined): string[] {
  if (!needs) return [];
  const out: string[] = [];
  for (const key of NEED_ORDER) {
    const value = needs[key];
    if (value === null || value === false || value === undefined) continue;
    switch (key) {
      case "ramGb":
        out.push(`${value} GB of memory (RAM)`);
        break;
      case "vramGb":
        out.push(`${value} GB of graphics memory (VRAM)`);
        break;
      case "diskGb":
        out.push(`${value} GB of free disk`);
        break;
      case "cuda":
        out.push("an NVIDIA graphics card with CUDA");
        break;
      case "driverMin":
        out.push(`NVIDIA driver ${value} or newer`);
        break;
      case "vulkan":
        out.push("a Vulkan driver");
        break;
      case "avx2":
        out.push("a processor with AVX2");
        break;
    }
  }
  if (needs.downloadGb != null) out.push(`a ${needs.downloadGb} GB download`);
  return out;
}

const LEVEL_ORDER = { block: 0, limit: 1, info: 2 } as const;

/** The reason lines, blockers first, so the owner reads the cause before the notes. */
export function reasonLines(fit: EngineFit): { level: "block" | "limit" | "info"; text: string }[] {
  return [...(fit.reasons ?? [])]
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    .map(({ level, text }) => ({ level, text }));
}

export type RowAction = {
  label: string;
  disabled: boolean;
  title: string;
  /** A confirm to show before the action runs (the reasons of a limited row). */
  confirm: { title: string; lines: string[] } | null;
};

export type InstallTarget = { via: "installer" | "models"; id: string };

/** Lookups the page injects: what each store can actually install. */
export type TargetLookups = {
  installerHas: (id: string) => boolean;
  /** The Models catalogue id for a voice model id (`hindi-ear`), or null. */
  voiceModelId: (catalogId: string) => string | null;
  /** The Models catalogue id for a chat model tag (`qwen2.5:1.5b`), or null. */
  modelIdForTag: (tag: string) => string | null;
};

/** Which store installs this row, or null when none can from this page. */
export function installTargetOf(
  row: Pick<InstallerCatalogRow, "id" | "kind">,
  lookups: TargetLookups,
): InstallTarget | null {
  if (row.kind === "tool" || row.kind === "engine") {
    return lookups.installerHas(row.id) ? { via: "installer", id: row.id } : null;
  }
  if (row.kind === "voice-model") {
    const id = lookups.voiceModelId(row.id.replace(/^voice:/, ""));
    return id ? { via: "models", id } : null;
  }
  if (row.kind === "model") {
    // model:<runner>:<tag>, and a tag may hold colons (qwen2.5:1.5b)
    const id = lookups.modelIdForTag(row.id.split(":").slice(2).join(":"));
    return id ? { via: "models", id } : null;
  }
  return null;
}

export type RowActions = {
  install: RowAction | null;
  update: RowAction | null;
  /** Why a supported or limited row has no install button here, when that is the case. */
  note: string | null;
};

/**
 * The buttons of one row. Install and Download show only for a row this PC can run (supported or limited) that is not
 * installed and that a store here can install; a limited row confirms with its reasons first. Update shows only when the
 * catalogue says an update exists, this PC can run it and the toolchain installer owns the row.
 */
export function rowActions(
  row: InstallerCatalogRow,
  ctx: { target: InstallTarget | null; busy: boolean },
): RowActions {
  const runnable = row.fit.state !== "unsupported";
  const verb = row.kind === "voice-model" || row.kind === "model" ? "Download" : "Install";
  let install: RowAction | null = null;
  let note: string | null = null;
  if (runnable && row.installed === false && row.needsRelease !== true) {
    if (ctx.target) {
      const limited = row.fit.state === "limited";
      install = {
        label: verb,
        disabled: ctx.busy,
        title: ctx.busy ? "Already running" : `${verb} ${row.name}`,
        confirm: limited
          ? {
              title: `${verb} ${row.name} with limits?`,
              lines: reasonLines(row.fit).map((line) => line.text),
            }
          : null,
      };
    } else if (row.kind === "runtime-pack") {
      note = "Installs together with the tool it belongs to.";
    }
  }
  const update: RowAction | null =
    runnable &&
    row.updateStatus === "update" &&
    (row.kind === "tool" || row.kind === "engine") &&
    ctx.target?.via === "installer"
      ? {
          label: "Update",
          disabled: ctx.busy,
          title: ctx.busy
            ? "Already running"
            : `Update ${row.name} to ${row.latestVersion ?? "the newest version"}`,
          confirm: null,
        }
      : null;
  return { install, update, note };
}

export type AutonomyDial = "ask" | "balanced" | "full";

/** The approval level of the autonomy store, as the dial the backend knows. Stop-everything reads as Ask. */
export function dialOf(level: string | null | undefined, halted = false): AutonomyDial {
  if (halted) return "ask";
  if (level === "full") return "full";
  if (level === "balanced" || level === "trusted") return "balanced";
  return "ask";
}

/** The consent dialog's words: what the dial says and what would change. */
export function consentWording(
  row: Pick<InstallerCatalogRow, "name" | "installedVersion" | "latestVersion" | "source">,
  dial: AutonomyDial,
): { title: string; lines: string[] } {
  const lead =
    dial === "balanced"
      ? "Balanced asks before updating a tool."
      : "Ask every time is on, so updating needs your OK.";
  return {
    title: `Update ${row.name}?`,
    lines: [
      lead,
      `Installed ${row.installedVersion ?? "unknown"}, newest ${row.latestVersion ?? "unknown"} (${sourceLabel(row.source)}).`,
      "The installer builds the new copy next to the old one. Nothing changes until you agree.",
    ],
  };
}

export type UpdateOutcome =
  | { kind: "started"; text: string }
  | { kind: "consent"; text: string }
  | { kind: "refused"; text: string }
  | { kind: "failed"; text: string };

/** What an `installer:update` answer means for the page. */
export function updateOutcome(
  result: InstallerUpdateResult | null | undefined,
  name: string,
): UpdateOutcome {
  if (!result) return { kind: "failed", text: `${name} could not be updated: no answer` };
  if (result.needsConsent) return { kind: "consent", text: result.reason || "Your OK is needed" };
  if (result.ok) {
    return {
      kind: "started",
      text: result.via === "full-autonomy" ? `${name} updated (Full autonomy)` : `${name} updated`,
    };
  }
  if (result.allowed === false)
    return { kind: "refused", text: result.reason || `${name} was not updated` };
  return { kind: "failed", text: result.error || result.reason || `${name} could not be updated` };
}

/** One Doctor row of the catalogue with the label of its Repair button, when it has one. */
export function doctorView(row: InstallerDoctorRow): {
  id: string;
  label: string;
  detail: string;
  tone: Tone;
  statusLabel: string;
  repair: { id: string; action: "install" | "repair"; label: string } | null;
} {
  const tone: Tone =
    row.status === "ok"
      ? "accent"
      : row.status === "warn"
        ? "warning"
        : row.status === "fail"
          ? "destructive"
          : "muted";
  const statusLabel =
    row.status === "ok"
      ? "OK"
      : row.status === "warn"
        ? "Needs attention"
        : row.status === "fail"
          ? "Failed"
          : "Skipped";
  return {
    id: row.id,
    label: row.label,
    detail: row.detail,
    tone,
    statusLabel,
    repair: row.repair
      ? {
          ...row.repair,
          label: row.repair.action === "install" ? "Install" : "Repair",
        }
      : null,
  };
}

/** The CUDA runtime row's own hint: the card is there, the libraries are not. */
export const CUDA_ROW_ID = "CUDA runtime libraries";
export const CUDA_HINT = "GPU found; install the CUDA runtime libraries";

export function cudaHint(row: InstallerCatalogRow): string | null {
  if (row.id !== CUDA_ROW_ID) return null;
  if (row.fit.state === "unsupported" || row.installed === true) return null;
  return CUDA_HINT;
}

export function servedLine(row: Pick<InstallerCatalogRow, "kind" | "servedFrom">): string | null {
  if (row.kind !== "voice-model") return null;
  if (row.servedFrom === "FRIDAY release") return "from the FRIDAY release";
  if (row.servedFrom === "official source") return "from the official source";
  return null;
}

export type RowView = {
  id: string;
  name: string;
  kind: RowKind;
  category: string;
  fitState: FitState;
  recommended: boolean;
  installedText: string;
  latestText: string;
  sourceText: string;
  checkedText: string;
  badges: Badge[];
  reasons: { level: "block" | "limit" | "info"; text: string }[];
  /** Only for a row this PC cannot run: what it would need. */
  needs: string[];
  /** The row to use instead, by name. */
  alternative: { id: string; name: string } | null;
  hint: string | null;
  /** The builds this PC would use, best first (llama.cpp and stable-diffusion.cpp). */
  engineLine: string | null;
  /** Voice rows only: "from the FRIDAY release" or "from the official source"; null when unknown. */
  servedLine: string | null;
  /** The catalogue's note for a row whose release asset is not published yet; null otherwise. */
  noteLine: string | null;
  upstreamVersion: string | null;
  row: InstallerCatalogRow;
};

export function rowView(
  row: InstallerCatalogRow,
  byId: ReadonlyMap<string, InstallerCatalogRow>,
  now: number,
): RowView {
  const alt = row.fit.alternative ? byId.get(row.fit.alternative) : undefined;
  const chain = row.engine?.chain?.length ? row.engine.chain.join(", ") : "";
  const active = row.engine?.active?.installed
    ? ` (installed: ${row.engine.active.backend ?? "unknown"} build)`
    : "";
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    category: row.category,
    fitState: row.fit.state,
    recommended: row.fit.recommended,
    installedText:
      row.installed === true
        ? `Installed ${row.installedVersion ?? "(version unknown)"}`
        : row.installed === false
          ? "Not installed"
          : "Not scanned yet",
    latestText: row.latestVersion ? `Latest ${row.latestVersion}` : "Latest unknown",
    sourceText: sourceLabel(row.source),
    checkedText: checkedText(row.checkedAt, now),
    badges: updateBadges(row),
    reasons: reasonLines(row.fit),
    needs: row.fit.state === "unsupported" ? needLines(row.fit.needs) : [],
    alternative: row.fit.alternative
      ? { id: row.fit.alternative, name: alt?.name ?? row.fit.alternative }
      : null,
    hint: cudaHint(row),
    engineLine: chain ? `Builds for this PC, best first: ${chain}${active}` : null,
    servedLine: servedLine(row),
    noteLine: row.needsRelease === true && row.note ? row.note : null,
    upstreamVersion: row.upstreamVersion ?? null,
    row,
  };
}

const updateRank = (row: InstallerCatalogRow) => (row.updateStatus === "update" ? 0 : 1);
const installRank = (row: InstallerCatalogRow) => (row.installed === true ? 1 : 0);

/** Recommended first, then updates, then what is not installed, then by name: the same order on every read. */
export function compareRows(a: InstallerCatalogRow, b: InstallerCatalogRow): number {
  return (
    Number(b.fit.recommended) - Number(a.fit.recommended) ||
    updateRank(a) - updateRank(b) ||
    installRank(a) - installRank(b) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

export type FitGroup = FitGroupSpec & { rows: RowView[] };

/**
 * The three groups for a page. A row sits in the group of its own fit state (the catalogue's `split` agrees); a row
 * with no readable state is shown under "Works with limits" rather than dropped. Nothing is filtered but the scope
 * (kinds) and the owner's search text, and the unsupported group keeps every row of that scope.
 */
export function groupRows(
  catalog: InstallerCatalog,
  opts: { kinds?: readonly RowKind[]; query?: string; now: number },
): FitGroup[] {
  const byId = new Map(catalog.rows.map((row) => [row.id, row] as const));
  const q = (opts.query ?? "").trim().toLowerCase();
  const inScope = catalog.rows.filter(
    (row) =>
      (!opts.kinds || opts.kinds.includes(row.kind)) &&
      (!q || `${row.name} ${row.id} ${row.category}`.toLowerCase().includes(q)),
  );
  return FIT_GROUPS.map((spec) => ({
    ...spec,
    rows: inScope
      .filter((row) => {
        const state = row.fit?.state;
        const known = state === "supported" || state === "limited" || state === "unsupported";
        return (known ? state : "limited") === spec.state;
      })
      .sort(compareRows)
      .map((row) => rowView(row, byId, opts.now)),
  }));
}

/** A long ready list shows this many rows first; "Show all" adds the rest. The unsupported list is never cut. */
export const GROUP_WINDOW = 12;

export function windowRows<T>(
  state: FitState,
  rows: readonly T[],
  expanded: boolean,
): { shown: T[]; hidden: number } {
  if (state === "unsupported" || expanded || rows.length <= GROUP_WINDOW)
    return { shown: [...rows], hidden: 0 };
  return { shown: rows.slice(0, GROUP_WINDOW), hidden: rows.length - GROUP_WINDOW };
}

/** Rows in scope, for the "empty" state. */
export function rowsInScope(catalog: InstallerCatalog, kinds?: readonly RowKind[]): number {
  return kinds
    ? catalog.rows.filter((row) => kinds.includes(row.kind)).length
    : catalog.rows.length;
}

export type Notice = { id: string; tone: "info" | "warning"; text: string };

/** The lines above the list: offline and privacy ("using saved list"), measuring, a failed refresh, a refresh running. */
export function catalogNotices(catalog: InstallerCatalog): Notice[] {
  const out: Notice[] = [];
  if (catalog.privacy)
    out.push({
      id: "privacy",
      tone: "info",
      text: "Privacy mode is on: using the saved list. Nothing is looked up online.",
    });
  else if (catalog.online === false)
    out.push({
      id: "offline",
      tone: "warning",
      text: "This PC is offline: using the saved list. Versions are marked stale until the connection returns.",
    });
  if (!catalog.hardwareKnown)
    out.push({
      id: "measuring",
      tone: "info",
      text: "This PC is still being measured, so every row reads as limited until the check finishes.",
    });
  if (catalog.lastError && !catalog.privacy && catalog.online !== false)
    out.push({
      id: "last-error",
      tone: "warning",
      text: `The last check failed: ${catalog.lastError}. The saved list is shown.`,
    });
  if (catalog.refreshing)
    out.push({ id: "refreshing", tone: "info", text: "Checking the official sources…" });
  return out;
}

/** "Last checked 5 min ago" from the last refresh, else the oldest saved answer. */
export function lastCheckedLine(catalog: InstallerCatalog, now: number): string {
  const at = catalog.lastRefreshAt ?? catalog.oldestCheckedAt;
  return at == null ? "Last checked: not yet" : `Last checked ${ageLabel(at, now)}`;
}

/** Milliseconds until a manual refresh is allowed, counted down from when the catalogue was read. */
export function refreshWaitMs(catalog: InstallerCatalog | null, now: number): number {
  if (!catalog) return 0;
  return Math.max(0, catalog.nextManualRefreshInMs - Math.max(0, now - catalog.generatedAt));
}

export function refreshLabel(waitMs: number, refreshing: boolean): string {
  if (refreshing) return "Refreshing…";
  return waitMs > 0 ? `Refresh list (${Math.ceil(waitMs / 1000)} s)` : "Refresh list";
}

/** One line for the toast after the Refresh list button. */
export function refreshOutcomeText(result: InstallerRefreshResult | null | undefined): string {
  if (!result) return "The list could not be refreshed: no answer";
  if (result.started) return "Checking the official sources…";
  if (result.running) return "A refresh is already running.";
  if (result.retryInMs != null)
    return `Refreshed a moment ago. Try again in ${Math.ceil(result.retryInMs / 1000)} s.`;
  return result.reason ? `Using the saved list: ${result.reason}` : "Using the saved list.";
}

export type CatalogPhase = "loading" | "offline" | "error" | "empty" | "ready";

/** Which of the page states shows. An error with a saved list in hand stays "ready" (the list is the answer). */
export function catalogPhase(input: {
  desktop: boolean;
  catalog: InstallerCatalog | null;
  error: string | null;
  inScope: number;
}): CatalogPhase {
  if (!input.desktop) return "offline";
  if (!input.catalog) return input.error ? "error" : "loading";
  return input.inScope === 0 ? "empty" : "ready";
}

/** The worst fit among the rows a bundle (a voice pack) holds, and its caveat lines. */
export function bundleFit(
  catalog: InstallerCatalog | null,
  rowIds: readonly string[],
): { state: FitState; lines: string[] } | null {
  if (!catalog) return null;
  const found = rowIds
    .map((id) => catalog.rows.find((row) => row.id === id))
    .filter((row): row is InstallerCatalogRow => Boolean(row));
  if (found.length === 0) return null;
  const rank = { supported: 0, limited: 1, unsupported: 2 } as const;
  let worst: FitState = "supported";
  for (const row of found) if (rank[row.fit.state] > rank[worst]) worst = row.fit.state;
  const lines = new Set<string>();
  for (const row of found)
    for (const line of reasonLines(row.fit))
      if (line.level !== "info") lines.add(`${row.name}: ${line.text}`);
  return { state: worst, lines: [...lines] };
}
