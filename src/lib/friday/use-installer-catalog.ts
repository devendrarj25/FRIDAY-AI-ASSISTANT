import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  desktopApi,
  type InstallerCatalog,
  type InstallerRefreshResult,
  type InstallerUpdateResult,
} from "./desktop";
import { isJobActive } from "./installer-engine";
import type { AutonomyDial } from "./installer-fit";
import { useInstaller } from "./use-installer";
import { isJobActive as isModelJobActive } from "./models-engine";
import { useLivePoll } from "./use-live-poll";
import { useModels } from "./use-models";

/** While the main process says it is refreshing, ask again this often (the shared poller; nothing runs otherwise). */
export const REFRESHING_POLL_MS = 3000;
/** A burst of installer events (a scan, a job ending) becomes one read. */
const CHANGE_DEBOUNCE_MS = 1500;

export type CatalogRead =
  | { phase: "offline" }
  | { phase: "error"; message: string }
  | { phase: "ready"; catalog: InstallerCatalog };

const message = (error: unknown): string =>
  String((error as Error)?.message || error).slice(0, 160);

/** One read of the catalogue (quick in the main process: memory and the feed cache). Never throws. */
export async function readInstallerCatalog(): Promise<CatalogRead> {
  const api = desktopApi();
  if (!api?.installerCatalog) return { phase: "offline" };
  try {
    const catalog = await api.installerCatalog();
    if (!catalog?.ok || !Array.isArray(catalog.rows))
      return { phase: "error", message: "The list is not available yet" };
    return { phase: "ready", catalog };
  } catch (error) {
    return { phase: "error", message: message(error) };
  }
}

export type CatalogState = {
  /** The last list read; kept while a later read fails, so the page never blanks. */
  catalog: InstallerCatalog | null;
  error: string | null;
  /** The bridge has no catalogue (the browser preview). */
  offline: boolean;
  loaded: boolean;
  /** The owner's Refresh list is in flight. */
  refreshing: boolean;
};

const INITIAL: CatalogState = {
  catalog: null,
  error: null,
  offline: false,
  loaded: false,
  refreshing: false,
};

/**
 * The Install Manager's and the Models page's one catalogue store: both pages and the voice pack card read the same
 * answer, so a refresh is read once. It owns no timer: it reads on mount, on the owner's click and on installer
 * events, and the hook below asks again every few seconds only while the main process reports a refresh running.
 */
export class InstallerCatalogStore {
  private state: CatalogState = INITIAL;
  private listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CatalogState => this.state;

  private set(patch: Partial<CatalogState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Read now; a read already running is shared. */
  load(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const read = await readInstallerCatalog();
      if (read.phase === "ready")
        this.set({ catalog: read.catalog, error: null, offline: false, loaded: true });
      else if (read.phase === "offline") this.set({ offline: true, loaded: true });
      else this.set({ error: read.message, loaded: true });
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Installer events arrive in bursts; read once after they settle. */
  changed(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      void this.load();
    }, CHANGE_DEBOUNCE_MS);
  }

  /** The Refresh list button: the main process rate-limits it; the answer says why when it did not start. */
  async refreshList(): Promise<InstallerRefreshResult | null> {
    const api = desktopApi();
    if (!api?.refreshInstallerCatalog) return null;
    this.set({ refreshing: true });
    try {
      return await api.refreshInstallerCatalog();
    } catch (error) {
      return { started: false, reason: message(error) };
    } finally {
      this.set({ refreshing: false });
      await this.load();
    }
  }

  /** Ask the main process to update one row. Without a consent it answers `needsConsent` unless the dial is Full. */
  async update(
    id: string,
    autonomy: AutonomyDial,
    consent?: { granted: boolean },
  ): Promise<InstallerUpdateResult | null> {
    const api = desktopApi();
    if (!api?.updateInstallerRow) return null;
    try {
      return await api.updateInstallerRow({ id, autonomy, ...(consent ? { consent } : {}) });
    } catch (error) {
      return { ok: false, error: message(error) };
    } finally {
      void this.load();
    }
  }
}

export const installerCatalogStore = new InstallerCatalogStore();

/**
 * The catalogue for a page. It reads on mount, again when the installer store reports a scan or a job finished, and on
 * the shared poller while a refresh is running (every 3 s at most, until it is done).
 */
export function useInstallerCatalog(): CatalogState & {
  load: () => Promise<void>;
  refreshList: () => Promise<InstallerRefreshResult | null>;
  update: InstallerCatalogStore["update"];
} {
  const state = useSyncExternalStore(
    installerCatalogStore.subscribe,
    installerCatalogStore.getSnapshot,
    () => INITIAL,
  );
  const installerState = useInstaller();
  const active = installerState.jobs.filter((job) => isJobActive(job.phase)).length;
  // A model download that ends re-reads the list too, so a "Needs finishing" row goes away by itself.
  const modelsActive = useModels().jobs.filter((job) => isModelJobActive(job.phase)).length;

  useEffect(() => {
    void installerCatalogStore.load();
  }, []);

  const seen = useRef<string | null>(null);
  useEffect(() => {
    const key = `${installerState.lastScanAt ?? ""}|${active}|${modelsActive}`;
    if (seen.current !== null && seen.current !== key) installerCatalogStore.changed();
    seen.current = key;
  }, [installerState.lastScanAt, active, modelsActive]);

  useLivePoll(
    "installer.catalog",
    () => installerCatalogStore.load(),
    REFRESHING_POLL_MS,
    state.catalog?.refreshing === true,
  );

  return {
    ...state,
    load: () => installerCatalogStore.load(),
    refreshList: () => installerCatalogStore.refreshList(),
    update: (id, autonomy, consent) => installerCatalogStore.update(id, autonomy, consent),
  };
}
