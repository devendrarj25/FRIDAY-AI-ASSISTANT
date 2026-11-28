/**
 * FRIDAY · locally built assets are wired into the running app
 *
 * The modules that find a CMD build next to the install (local-sources, staged-assets, install-inventory) were finished
 * but had no caller in electron/main.cjs. These tests pin the production callers, the new channel installer:adopt-local
 * (handler, budget class, preload, page) and run the real main-process functions against fakes: no registry, no
 * network, no clock and nothing of this checkout.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const main = read("electron/main.cjs");
const preload = read("electron/preload.cjs");
const page = read("src/routes/install-manager.tsx");
const table = require(path.join(root, "electron/ipc-budget-table.cjs")) as {
  CHANNEL_CLASS: Record<string, string>;
};

/** The source of one top-level function of main.cjs, found by its name and balanced braces. */
function functionSource(name: string): string {
  const start = main.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  expect(start, `${name} is declared in main.cjs`).toBeGreaterThanOrEqual(0);
  const open = main.indexOf("{", main.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < main.length; i += 1) {
    if (main[i] === "{") depth += 1;
    else if (main[i] === "}") {
      depth -= 1;
      if (depth === 0) return main.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is not closed`);
}

function build<T>(name: string, scope: Record<string, unknown>): T {
  const names = Object.keys(scope);
  const make = new Function(...names, `return (${functionSource(name)});`);
  return make(...names.map((key) => scope[key])) as T;
}

/** The text of one ipcMain.handle(channel, ...) block, up to the next top-level statement. */
function handlerSource(channel: string, closed = false): string {
  const start = main.indexOf(`ipcMain.handle("${channel}"`);
  expect(start, `${channel} is handled in main.cjs`).toBeGreaterThanOrEqual(0);
  if (closed) return main.slice(start, main.indexOf("\n});", start) + 4);
  const next = main.indexOf("\nipcMain.handle(", start + 1);
  return main.slice(start, next < 0 ? undefined : next);
}

describe("workspace:set copies the old folder before the boot steps seed the new one", () => {
  const handler = handlerSource("workspace:set");
  const at = (needle: string) => {
    const index = handler.indexOf(needle);
    expect(index, needle).toBeGreaterThanOrEqual(0);
    return index;
  };

  it("copies first (cp never overwrites), then writes the config and the boot data", () => {
    const copy = at("await migrateWorkspaceData(previousRoot, resolvedRoot)");
    expect(at("ensureCanonicalConfig(resolvedRoot);")).toBeGreaterThan(copy);
    expect(at("ensureRootFiles(resolvedRoot")).toBeGreaterThan(copy);
    expect(at("runDataBootSteps(resolvedRoot);")).toBeGreaterThan(copy);
    expect(at("restartKernel();")).toBeGreaterThan(at("runDataBootSteps(resolvedRoot);"));
  });

  it("creates the folders before the copy, so the copy has somewhere to go", () => {
    expect(at("paths.ensureStructure(resolvedRoot);")).toBeLessThan(
      at("await migrateWorkspaceData(previousRoot, resolvedRoot)"),
    );
  });

  it("adopts staged downloads and local builds into free places only after the copy", () => {
    expect(at("await adoptStagedDownloads(resolvedRoot)")).toBeGreaterThan(
      at("await migrateWorkspaceData(previousRoot, resolvedRoot)"),
    );
  });
});

describe("adoptStagedDownloads logs every item by its result", () => {
  const run = async (report: unknown, off = false) => {
    const lines: string[] = [];
    const adopt = vi.fn(async () => report);
    const fn = build<(root: string) => Promise<unknown>>("adoptStagedDownloads", {
      stagedAssets: { adopt },
      localBuildsOn: () => !off,
      log: (line: string) => lines.push(line),
      process: { env: { PATH: "x" } },
    });
    await fn("/r");
    return { lines: lines.join("\n"), adopt };
  };

  it("names adopted, in-place, skipped with the reason, and failed items", async () => {
    const { lines } = await run({
      moved: [],
      failed: [{ item: "models/c", error: "disk full" }],
      items: [
        { id: "models/a", origin: "/b", result: "adopted", reason: "copied" },
        {
          id: "models/b",
          origin: "/r",
          result: "in-place",
          reason: "build root is the install root",
        },
        { id: "models/d", origin: "/b", result: "skipped", reason: "not verified" },
        { id: "models/c", origin: "/b", result: "skipped", reason: "failed: disk full" },
      ],
    });
    expect(lines).toMatch(/models\/a.*adopted/);
    expect(lines).toMatch(/models\/b.*in place/);
    expect(lines).toMatch(/models\/d.*skipped.*not verified/);
    expect(lines).toMatch(/models\/c.*disk full/);
  });

  it("turns build roots off for this call when install.useLocalBuilds is off", async () => {
    const { adopt } = await run({ moved: [], failed: [], items: [] }, true);
    const options = (adopt.mock.calls[0] as unknown[])[1] as { env: Record<string, string> };
    expect(options.env["FRIDAY_LOCAL_BUNDLES"]).toBe("0");
    expect(options.env["PATH"]).toBe("x");
  });

  it("passes no override when local builds are on", async () => {
    const { adopt } = await run({ moved: [], failed: [], items: [] });
    const options = (adopt.mock.calls[0] as unknown[])[1] as { env?: unknown } | undefined;
    expect(options?.env).toBeUndefined();
  });

  it("never throws", async () => {
    const lines: string[] = [];
    const fn = build<(root: string) => Promise<unknown>>("adoptStagedDownloads", {
      stagedAssets: {
        adopt: async () => {
          throw new Error("boom");
        },
      },
      localBuildsOn: () => true,
      log: (line: string) => lines.push(line),
      process: { env: {} },
    });
    await expect(fn("/r")).resolves.toBeNull();
    expect(lines.join("\n")).toContain("boom");
  });
});

describe("production callers", () => {
  it("main.cjs calls discoverLocalBundles, adopt, and passes localSources to writeInventory", () => {
    expect(main.match(/localSources\.discoverLocalBundles\(/g)?.length ?? 0).toBeGreaterThanOrEqual(
      1,
    );
    expect(main).toMatch(/stagedAssets\.adopt\(/);
    const record = functionSource("recordInventory");
    expect(record).toMatch(/installInventory\.writeInventory\([^;]*localSources:/s);
  });

  it("recordInventory hands the inventory a reader of local builds that honours the setting", () => {
    const written: Array<{ options: { localSources?: () => unknown[] } }> = [];
    const entries = [{ origin: "installers", dir: "/r/installer/installers/1", bundle: {} }];
    const record = build<(scan: unknown) => void>("recordInventory", {
      getWorkspaceRoot: () => "/r",
      installInventory: {
        writeInventory: (_root: string, _scan: unknown, options: never) =>
          written.push({ options }),
      },
      discoverLocalBuilds: () => entries,
      latestSeen: null,
      productVersion: () => "1.0.0.0",
      readinessTrace: { backgroundWorkAllowed: () => false },
      runPostUpdateModelCheck: () => undefined,
    });
    record({ tools: [{ id: "git" }] });
    expect(written).toHaveLength(1);
    expect(written[0]?.options.localSources?.()).toBe(entries);
  });

  it("discoverLocalBuilds reads the stored toggle and the app version, and remembers a short while", () => {
    const calls: unknown[][] = [];
    let now = 1000;
    let toggle = true;
    const memo = { key: "", at: 0, entries: [] as unknown[] };
    const discover = build<(root?: string) => unknown[]>("discoverLocalBuilds", {
      getWorkspaceRoot: () => "/r",
      localSources: {
        discoverLocalBundles: (...args: unknown[]) => {
          calls.push(args);
          return [{ origin: "installers", dir: "/d", bundle: {} }];
        },
      },
      ownerPrefToggle: () => toggle,
      productVersion: () => "1.2.5.8",
      localBuildsMemo: memo,
      LOCAL_BUILDS_MEMO_MS: 30_000,
      Date: { now: () => now },
    });
    expect(discover()).toHaveLength(1);
    expect(discover()).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("/r");
    expect(calls[0]?.[1]).toMatchObject({ useLocalBuilds: true, appVersion: "1.2.5.8" });
    toggle = false;
    discover();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toMatchObject({ useLocalBuilds: false });
    now += 60_000;
    discover();
    expect(calls).toHaveLength(3);
    expect(discover("")).toEqual([]);
  });
});

describe("installer:catalog rows carry localSource, additively", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-local-rows-"));
  fs.mkdirSync(path.join(dir, "models", "friday-ear"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "friday-ear", "model.bin"), "0123456789");
  const entry = {
    origin: "installers",
    dir,
    bundle: {
      models: [
        {
          fridayId: "friday-ear",
          dir: "models/friday-ear",
          files: [{ path: "model.bin", bytes: 10 }],
        },
        {
          fridayId: "friday-gone",
          dir: "models/friday-gone",
          files: [{ path: "m.bin", bytes: 4 }],
        },
        {
          fridayId: "friday-short",
          dir: "models/friday-ear",
          files: [{ path: "model.bin", bytes: 99 }],
        },
      ],
    },
  };
  const rows = [
    { id: "voice:friday-ear", kind: "voice-model", installed: false },
    { id: "voice:friday-gone", kind: "voice-model", installed: false },
    { id: "voice:friday-short", kind: "voice-model", installed: false },
    { id: "git", kind: "tool", installed: true },
  ];
  const withLocal = build<
    (catalog: unknown, entries: unknown[]) => { rows: Array<Record<string, unknown>> }
  >("catalogWithLocalSources", {
    fs,
    path,
    localSources: { baseRootsOf: (e: { dir: string }) => [e.dir, path.dirname(e.dir)] },
  });

  it("adds { origin, dir } only to a row a bundle holds with its files on this PC", () => {
    const out = withLocal({ ok: true, rows }, [entry]);
    expect(out.rows[0]?.["localSource"]).toEqual({ origin: "installers", dir });
    expect("localSource" in (out.rows[1] ?? {})).toBe(false);
    expect("localSource" in (out.rows[2] ?? {})).toBe(false);
    expect("localSource" in (out.rows[3] ?? {})).toBe(false);
  });

  it("returns the catalog as it was when nothing is found or the catalog is not a list", () => {
    const catalog = { ok: true, rows };
    expect(withLocal(catalog, [])).toBe(catalog);
    const broken = { ok: false };
    expect(withLocal(broken, [entry])).toBe(broken);
  });

  it("the handler wraps the existing catalog read and starts no job", () => {
    const handler = handlerSource("installer:catalog");
    expect(handler).toContain("catalogWithLocalSources(");
    expect(handler).toContain("getInstallerCatalog().catalog()");
    expect(handler).not.toMatch(/runJob/);
  });
});

describe("installer:adopt-local: handler, budget class, preload, page", () => {
  it("is a long job with no deadline, in the preload and handled in main", () => {
    expect(table.CHANNEL_CLASS["installer:adopt-local"]).toBe("long-job");
    expect(preload).toMatch(
      /adoptLocalBuilds: \(\) => ipcRenderer\.invoke\("installer:adopt-local"\)/,
    );
    expect(main).toContain('ipcMain.handle("installer:adopt-local"');
  });

  it("the handler adopts for the chosen folder and returns the per-item rows", async () => {
    const adopt = vi.fn(async (_root: string) => ({
      moved: [],
      failed: [],
      sources: ["/b"],
      items: [{ id: "models/a", origin: "/b", result: "adopted", reason: "copied" }],
    }));
    const memo = { key: "k", at: 5, entries: [1] as unknown[] };
    let handle: ((...args: unknown[]) => Promise<Record<string, unknown>>) | null = null;
    const body = handlerSource("installer:adopt-local", true);
    const make = new Function(
      "ipcMain",
      "getWorkspaceRoot",
      "localBuildsOn",
      "adoptStagedDownloads",
      "localBuildsMemo",
      `${body}`,
    );
    make(
      { handle: (_c: string, fn: typeof handle) => (handle = fn) },
      () => "/r",
      () => true,
      async (r: string) => adopt(r),
      memo,
    );
    const out = await handle!();
    expect(out).toMatchObject({
      ok: true,
      off: false,
      items: [{ id: "models/a", result: "adopted" }],
    });
    expect(memo.at).toBe(0);
  });

  it("says so when no folder is chosen or local builds are off, and adopts nothing", async () => {
    const adopt = vi.fn();
    const body = handlerSource("installer:adopt-local", true);
    const make = (root: string | null, on: boolean) => {
      let handle: (() => Promise<Record<string, unknown>>) | null = null;
      new Function(
        "ipcMain",
        "getWorkspaceRoot",
        "localBuildsOn",
        "adoptStagedDownloads",
        "localBuildsMemo",
        body,
      )(
        { handle: (_c: string, fn: () => Promise<Record<string, unknown>>) => (handle = fn) },
        () => root,
        () => on,
        adopt,
        { key: "", at: 0, entries: [] },
      );
      return handle!();
    };
    expect(await make(null, true)).toMatchObject({ ok: false, items: [] });
    expect(await make("/r", false)).toMatchObject({ ok: true, off: true, items: [] });
    expect(adopt).not.toHaveBeenCalled();
  });

  it("the page shows the found line, the toggle and the button, in plain words", () => {
    expect(page).toContain("Found on this PC (from a local build)");
    expect(page).toContain("Use local builds");
    expect(page).toContain("installUseLocalBuilds");
    expect(page).toContain("adoptLocalBuilds");
    const copy = page.slice(page.indexOf("function LocalBuildsPanel"));
    expect(copy).not.toMatch(/bundle/i);
  });
});

describe("a model already in its canonical place is not downloaded again", () => {
  it("models:download asks adoptByHash about the pinned files before any source is tried", () => {
    const handler = handlerSource("models:download");
    const check = handler.indexOf("pinnedModelInPlace(");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(handler.indexOf("modelDownload.downloadModel("));
    expect(main).toMatch(/installInventory\.adoptByHash\(/);
  });

  const pinned = (adoptedAll: boolean, marker: boolean) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-inplace-"));
    const adoptByHash = vi.fn(async (items: Array<{ id: string }>) => ({
      adopted: adoptedAll ? items.map((i) => i.id) : [],
      pending: adoptedAll ? [] : items.map((i) => i.id),
      items: [],
    }));
    const fn = build<
      (modelId: string, folderId: string, dir: string, sources: unknown[]) => Promise<unknown>
    >("pinnedModelInPlace", {
      path,
      installInventory: { adoptByHash },
      voicePins: {
        pinForRepo: (repo: string) =>
          repo === "o/pinned"
            ? { revision: "r1", files: { "a.bin": { bytes: 3, sha256: "aa" } } }
            : null,
        readMarker: () => (marker ? { revision: "r1" } : null),
      },
    });
    return { dir, fn, adoptByHash };
  };

  it("returns the folder when every pinned file is adopted and the folder is certified", async () => {
    const { dir, fn, adoptByHash } = pinned(true, true);
    const out = (await fn("m", "m", dir, [{ kind: "hf-repo", repo: "o/pinned" }])) as {
      ok: boolean;
      via: string;
      path: string;
    };
    expect(out).toMatchObject({ ok: true, via: "in-place", path: path.join(dir, "m") });
    const items = (adoptByHash.mock.calls[0] as unknown[])[0] as Array<{ dest: string }>;
    expect(items[0]?.dest).toBe(path.join(dir, "m", "a.bin"));
  });

  it("falls through to the download chain when a file differs or the folder is not certified", async () => {
    expect(
      await pinned(false, true).fn("m", "m", "/x", [{ kind: "hf-repo", repo: "o/pinned" }]),
    ).toBe(null);
    expect(
      await pinned(true, false).fn("m", "m", "/x", [{ kind: "hf-repo", repo: "o/pinned" }]),
    ).toBe(null);
    expect(
      await pinned(true, true).fn("m", "m", "/x", [{ kind: "hf-repo", repo: "o/other" }]),
    ).toBe(null);
    expect(await pinned(true, true).fn("m", "m", "/x", [])).toBe(null);
  });
});
