/**
 * The catalogue store behind the Install Manager, the Models page and the voice pack card
 * (src/lib/friday/use-installer-catalog.ts): one read shared by all, a saved list kept when a later read fails, the
 * Refresh list and Update calls with the exact bridge arguments, and the browser preview reading as offline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InstallerCatalogStore,
  readInstallerCatalog,
} from "../../src/lib/friday/use-installer-catalog";
import { NO_GPU_PC, realCatalog } from "./helpers/installer-catalog-fixtures";

const bridge = (friday: Record<string, unknown> | undefined) =>
  vi.stubGlobal("window", friday ? { friday } : {});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("reading the catalogue through the desktop bridge", () => {
  it("is offline outside the desktop app", async () => {
    bridge(undefined);
    await expect(readInstallerCatalog()).resolves.toEqual({ phase: "offline" });
    bridge({});
    await expect(readInstallerCatalog()).resolves.toEqual({ phase: "offline" });
  });

  it("is an error with a message when the call fails or the answer is not a list", async () => {
    bridge({
      installerCatalog: async () => {
        throw new Error("ipc budget expired");
      },
    });
    await expect(readInstallerCatalog()).resolves.toEqual({
      phase: "error",
      message: "ipc budget expired",
    });
    bridge({ installerCatalog: async () => ({ ok: false }) });
    expect(await readInstallerCatalog()).toMatchObject({ phase: "error" });
    bridge({ installerCatalog: async () => ({ ok: true }) });
    expect(await readInstallerCatalog()).toMatchObject({ phase: "error" });
  });

  it("returns the catalogue as the main process built it", async () => {
    const catalog = realCatalog(NO_GPU_PC);
    bridge({ installerCatalog: async () => catalog });
    expect(await readInstallerCatalog()).toEqual({ phase: "ready", catalog });
  });
});

describe("the shared store", () => {
  it("starts empty, loads once for many readers and tells its subscribers", async () => {
    const catalog = realCatalog(NO_GPU_PC);
    const installerCatalog = vi.fn(async () => catalog);
    bridge({ installerCatalog });
    const store = new InstallerCatalogStore();
    expect(store.getSnapshot()).toMatchObject({ catalog: null, loaded: false, offline: false });
    const seen = vi.fn();
    const off = store.subscribe(seen);
    await Promise.all([store.load(), store.load(), store.load()]);
    expect(installerCatalog).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ catalog, loaded: true, error: null });
    expect(seen).toHaveBeenCalled();
    off();
    const before = seen.mock.calls.length;
    await store.load();
    expect(seen.mock.calls.length).toBe(before);
  });

  it("keeps the saved list when a later read fails, and clears the error on the next good read", async () => {
    const catalog = realCatalog(NO_GPU_PC);
    let fail = false;
    bridge({
      installerCatalog: async () => {
        if (fail) throw new Error("kernel restarting");
        return catalog;
      },
    });
    const store = new InstallerCatalogStore();
    await store.load();
    fail = true;
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ catalog, error: "kernel restarting" });
    fail = false;
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ catalog, error: null });
  });

  it("reads as offline in the browser preview and as an error before any list", async () => {
    bridge(undefined);
    const preview = new InstallerCatalogStore();
    await preview.load();
    expect(preview.getSnapshot()).toMatchObject({ offline: true, loaded: true, catalog: null });
    bridge({ installerCatalog: async () => ({ ok: false }) });
    const broken = new InstallerCatalogStore();
    await broken.load();
    expect(broken.getSnapshot()).toMatchObject({ catalog: null, error: expect.any(String) });
  });

  it("turns a burst of installer events into one read", async () => {
    vi.useFakeTimers();
    const installerCatalog = vi.fn(async () => realCatalog(NO_GPU_PC));
    bridge({ installerCatalog });
    const store = new InstallerCatalogStore();
    store.changed();
    store.changed();
    store.changed();
    expect(installerCatalog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1600);
    expect(installerCatalog).toHaveBeenCalledTimes(1);
  });
});

describe("Refresh list and Update", () => {
  it("asks the main process to refresh, reads the list again, and passes its answer back", async () => {
    const refreshInstallerCatalog = vi.fn(async () => ({ started: true }));
    const installerCatalog = vi.fn(async () => realCatalog(NO_GPU_PC));
    bridge({ installerCatalog, refreshInstallerCatalog });
    const store = new InstallerCatalogStore();
    const states: boolean[] = [];
    store.subscribe(() => states.push(store.getSnapshot().refreshing));
    expect(await store.refreshList()).toEqual({ started: true });
    expect(refreshInstallerCatalog).toHaveBeenCalledTimes(1);
    expect(installerCatalog).toHaveBeenCalledTimes(1);
    expect(states[0]).toBe(true);
    expect(store.getSnapshot().refreshing).toBe(false);
  });

  it("a rate-limited or failed refresh says why and still re-reads the saved list", async () => {
    const limited = { started: false, retryInMs: 31_000, reason: "refreshed a moment ago" };
    bridge({
      installerCatalog: async () => realCatalog(NO_GPU_PC),
      refreshInstallerCatalog: async () => limited,
    });
    const store = new InstallerCatalogStore();
    expect(await store.refreshList()).toEqual(limited);
    bridge({
      installerCatalog: async () => realCatalog(NO_GPU_PC),
      refreshInstallerCatalog: async () => {
        throw new Error("ipc down");
      },
    });
    expect(await store.refreshList()).toEqual({ started: false, reason: "ipc down" });
    expect(store.getSnapshot().refreshing).toBe(false);
    bridge({});
    expect(await store.refreshList()).toBeNull();
  });

  it("sends the dial, and the owner's yes only when there is one", async () => {
    const updateInstallerRow = vi.fn(async (request: { id: string }) => ({
      ok: false,
      needsConsent: true,
      reason: `Balanced asks before updating ${request.id}`,
    }));
    bridge({ installerCatalog: async () => realCatalog(NO_GPU_PC), updateInstallerRow });
    const store = new InstallerCatalogStore();
    await store.update("ripgrep", "balanced");
    expect(updateInstallerRow).toHaveBeenLastCalledWith({ id: "ripgrep", autonomy: "balanced" });
    await store.update("ripgrep", "ask", { granted: true });
    expect(updateInstallerRow).toHaveBeenLastCalledWith({
      id: "ripgrep",
      autonomy: "ask",
      consent: { granted: true },
    });
  });

  it("returns an error result when the update call throws, and null without a bridge", async () => {
    bridge({
      installerCatalog: async () => realCatalog(NO_GPU_PC),
      updateInstallerRow: async () => {
        throw new Error("installer busy");
      },
    });
    const store = new InstallerCatalogStore();
    expect(await store.update("ripgrep", "full")).toEqual({ ok: false, error: "installer busy" });
    bridge({});
    expect(await store.update("ripgrep", "full")).toBeNull();
  });
});
