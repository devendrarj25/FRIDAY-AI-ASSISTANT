/**
 * Brain section live sync — the Updates tab and workspace tiles read the
 * same GitHub / capability / workspace scanners Settings and Folders use.
 * Nothing here invents a version, a count, or a folder that was not returned.
 */

import { APP_VERSION_LABEL } from "../version";
import { githubCheck, type GithubCheck } from "../github-updates";
import {
  checkForUpdates,
  checkPluginUpdates,
  type PluginUpdatesResult,
  type UpdateInfo,
  type WorkspaceFolder,
  type WorkspaceScanResult,
} from "../desktop";
import { listCapabilities, type CapabilityIndex } from "../capability-trees";
import { providers } from "../model-catalog";
import { workspaceTree } from "../brain-catalog";

export type LiveUpdateState = "checking" | "up-to-date" | "available" | "installing" | "installed";

export type LiveUpdateRow = {
  id: string;
  label: string;
  channel: string;
  installed: string;
  latest: string;
  state: LiveUpdateState;
  notes: string;
};

export type UpdateSources = {
  version?: string;
  github?: () => Promise<GithubCheck>;
  electronUpdates?: () => Promise<UpdateInfo[]>;
  plugins?: () => Promise<PluginUpdatesResult>;
  capabilities?: () => Promise<CapabilityIndex | null>;
  providerCount?: number;
};

const DASH = "—";

function countLine(counts: CapabilityIndex["counts"] | undefined, tree: string): string {
  const row = counts?.[tree];
  if (!row) return DASH;
  return `${row.enabled} enabled / ${row.total} packed`;
}

function capabilityNotes(
  counts: CapabilityIndex["counts"] | undefined,
  tree: string,
  extra?: string,
): string {
  const row = counts?.[tree];
  if (!row) return extra || "desktop scan unavailable — open the owning page";
  const base = `${row.total} packed, ${row.enabled} enabled`;
  return extra ? `${base} · ${extra}` : `${base} — install from that page, not here`;
}

/**
 * Fill the Brain Updates table from live scanners. Missing desktop bridges
 * stay "—" with an honest reason — never a made-up version.
 */
export async function collectLiveUpdateRows(
  base: LiveUpdateRow[],
  sources: UpdateSources = {},
): Promise<{ rows: LiveUpdateRow[]; github: GithubCheck | null }> {
  const version = sources.version ?? APP_VERSION_LABEL;
  const github = await (sources.github ?? githubCheck)().catch((): GithubCheck => ({
    ok: false,
    error: "GitHub check failed",
  }));
  const electron = await (sources.electronUpdates ?? checkForUpdates)().catch(() => []);
  const plugins = await (sources.plugins ?? checkPluginUpdates)().catch(
    (): PluginUpdatesResult => ({
      ok: false,
      plugins: [],
      updates: [],
      error: "plugin check failed",
    }),
  );
  const caps = await (sources.capabilities ?? listCapabilities)().catch(() => null);
  const providerCount = sources.providerCount ?? providers.length;
  const appElectron = electron.find(
    (item) => item.kind === "app" || item.id === "app" || item.id === "friday",
  );
  const githubAvailable = Boolean(github.ok && github.updateAvailable);
  const electronAvailable = Boolean(
    appElectron?.available && appElectron.available !== appUpdateCurrent(appElectron, version),
  );
  const appInstalled = String(github.currentVersion || version || DASH);
  const appLatest = githubAvailable
    ? String(github.version || github.label || DASH)
    : appElectron?.available && electronAvailable
      ? String(appElectron.available)
      : appInstalled;
  const appNotes = !github.ok
    ? String(github.error || "GitHub not reachable from this session")
    : githubAvailable
      ? String(
          github.notes ||
            github.title ||
            "GitHub release is newer — install from Settings → Updates",
        )
      : electronAvailable
        ? String(appElectron?.notes || "electron-updater reports a newer build")
        : "application matches the checked channel";

  const pluginUpdates = Array.isArray(plugins.updates) ? plugins.updates : [];
  const pluginInstalled = countLine(caps?.counts, "plugins");
  const pluginLatest = pluginUpdates.length
    ? `${pluginUpdates.length} update${pluginUpdates.length === 1 ? "" : "s"}`
    : pluginInstalled;
  const pluginNotes = !plugins.ok
    ? String(plugins.error || "plugin feed unavailable")
    : pluginUpdates.length
      ? pluginUpdates
          .slice(0, 4)
          .map((item) => `${item.name ?? item.id}${item.latest ? ` → ${item.latest}` : ""}`)
          .join(", ")
      : capabilityNotes(caps?.counts, "plugins", "no plugin feed updates");

  const rows = base.map((row): LiveUpdateRow => {
    if (row.id === "app") {
      return {
        ...row,
        installed: appInstalled,
        latest: appLatest,
        state: githubAvailable || electronAvailable ? "available" : "up-to-date",
        notes: appNotes,
      };
    }
    if (row.id === "plugins") {
      return {
        ...row,
        installed: pluginInstalled,
        latest: pluginLatest,
        state: pluginUpdates.length ? "available" : "up-to-date",
        notes: pluginNotes,
      };
    }
    if (row.id === "modules") {
      return fillPacked(row, caps, "modules");
    }
    if (row.id === "agents") {
      return fillPacked(row, caps, "agents");
    }
    if (row.id === "tools") {
      return fillPacked(row, caps, "tools");
    }
    if (row.id === "workflows") {
      return fillPacked(row, caps, "workflows");
    }
    if (row.id === "providers") {
      const installed = `${providerCount} catalogued`;
      return {
        ...row,
        installed,
        latest: installed,
        state: "up-to-date",
        notes: `${providerCount} provider entries in the one model catalog — connect keys on Models`,
      };
    }
    return {
      ...row,
      installed: DASH,
      latest: DASH,
      state: "up-to-date",
      notes: "no live scanner for this row",
    };
  });

  return { rows, github: github.ok ? github : null };
}

function appUpdateCurrent(item: UpdateInfo | undefined, version: string): string {
  return String(item?.current || version);
}

function fillPacked(row: LiveUpdateRow, caps: CapabilityIndex | null, tree: string): LiveUpdateRow {
  const installed = countLine(caps?.counts, tree);
  return {
    ...row,
    installed,
    latest: installed,
    state: "up-to-date",
    notes: capabilityNotes(caps?.counts, tree),
  };
}

export type WorkspaceTile = { name: string; note: string };

/** Same hud-tile grid as the catalog, with live scan counts when a scan exists. */
export function workspaceTilesFromScan(
  scan: WorkspaceScanResult | null | undefined,
): WorkspaceTile[] {
  const folders = scan?.folders;
  if (folders?.length) {
    return folders.map((folder: WorkspaceFolder) => ({
      name: folder.name,
      note: `${folder.files} files · ${folder.subfolders} sub-folders`,
    }));
  }
  if (scan?.present?.length) {
    const missing = new Set(scan.missing ?? []);
    return scan.present.map((name) => {
      const catalog = workspaceTree.find((item) => item.name.toLowerCase() === name.toLowerCase());
      return {
        name,
        note: missing.has(name) ? "missing from this root" : (catalog?.note ?? "present"),
      };
    });
  }
  return workspaceTree.map((folder) => ({ name: folder.name, note: folder.note }));
}

/** Drop leftover demo timestamps from older Brain schedules. */
export function honestLastRun(value: string | undefined): string {
  const text = String(value || "").trim();
  if (!text || text === "—" || /^today\b/i.test(text)) return "—";
  return text;
}
