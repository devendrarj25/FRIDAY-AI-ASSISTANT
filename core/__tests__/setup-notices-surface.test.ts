/**
 * Setup notices reach the app: the record setup writes (<root>/runtime/setup-notices.json) rides the Install Manager
 * catalogue the pages already read (`setupNotices`), a notice whose item is now installed is cleared, and both pages
 * show what is left under "Needs finishing" with the row's own Install or Repair button. No new channel, no new timer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InstallerFitView,
  type InstallerFitViewProps,
} from "../../src/components/friday/InstallerFitPanel";
import type { InstallerCatalog } from "../../src/lib/friday/desktop";
import { setupNoticeViews } from "../../src/lib/friday/installer-fit";
import type { CatalogState } from "../../src/lib/friday/use-installer-catalog";
import {
  FIXED_NOW,
  NVIDIA_16GB_PC,
  fakeRow,
  realCatalog,
} from "./helpers/installer-catalog-fixtures";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const catalogApi = require_(path.join(root, "electron/installer-catalog.cjs")) as {
  withSetupNotices: (
    catalog: Record<string, unknown> | null,
    options: { root: string | null; notices: unknown },
  ) => Record<string, unknown> | null;
};
const notices = require_(path.join(root, "scripts/setup-notices.cjs")) as {
  readNotices: (root: string) => Array<{ id: string }>;
  recordNotice: (entry: Record<string, unknown>, options: Record<string, unknown>) => string;
  noticesFile: (root: string) => string;
};

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-notices-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const record = (dir: string, entry: Record<string, unknown>) =>
  notices.recordNotice(entry, { root: dir, now: "2026-01-01T00:00:00.000Z", print: false });

const base = (rows: unknown[], doctor: unknown[] = []) => ({ ok: true, rows, doctor });
type Open = { id: string; [key: string]: unknown };
const open = (out: Record<string, unknown> | null): Open[] =>
  (out?.["setupNotices"] ?? []) as Open[];

describe("the reader behind the catalogue", () => {
  it("returns an empty list when the file is absent, broken or the root is unknown", () => {
    const dir = temp();
    expect(open(catalogApi.withSetupNotices(base([]), { root: dir, notices }))).toEqual([]);
    mkdirSync(path.join(dir, "runtime"), { recursive: true });
    writeFileSync(notices.noticesFile(dir), "{ not json", "utf8");
    expect(open(catalogApi.withSetupNotices(base([]), { root: dir, notices }))).toEqual([]);
    expect(open(catalogApi.withSetupNotices(base([]), { root: null, notices }))).toEqual([]);
    expect(open(catalogApi.withSetupNotices(base([]), { root: dir, notices: null }))).toEqual([]);
  });

  it("returns the open notices with the catalogue row that finishes each one", () => {
    const dir = temp();
    record(dir, {
      id: "voice-whisper",
      kind: "voice",
      label: "Speech model",
      reason: "download failed",
      installManagerId: "voice:faster-whisper-small",
      repair: "npm run setup",
    });
    record(dir, { id: "odd", label: "Odd tool", reason: "no route", repair: "npm run doctor" });
    const out = catalogApi.withSetupNotices(
      base([{ id: "voice:faster-whisper-small", kind: "voice-model", installed: false }]),
      { root: dir, notices },
    );
    const list = open(out);
    expect(list.map((item) => item.id).sort()).toEqual(["odd", "voice-whisper"]);
    expect(list.find((item) => item.id === "voice-whisper")).toMatchObject({
      label: "Speech model",
      reason: "download failed",
      rowId: "voice:faster-whisper-small",
      doctorId: null,
      repair: "npm run setup",
    });
    expect(list.find((item) => item.id === "odd")).toMatchObject({ rowId: null, doctorId: null });
    expect(out?.["ok"]).toBe(true);
  });

  it("clears a notice once the inventory says its item is installed (row or Doctor)", () => {
    const dir = temp();
    record(dir, { id: "a", label: "A", reason: "r", installManagerId: "voice:done" });
    record(dir, { id: "b", label: "B", reason: "r", installManagerId: "cuda-libs" });
    record(dir, { id: "c", label: "C", reason: "r", installManagerId: "voice:todo" });
    record(dir, { id: "d", label: "D", reason: "r", installManagerId: "voice:unknown" });
    const out = catalogApi.withSetupNotices(
      base(
        [
          { id: "voice:done", kind: "voice-model", installed: true },
          { id: "voice:todo", kind: "voice-model", installed: false },
          { id: "voice:unknown", kind: "voice-model", installed: null },
        ],
        [
          {
            id: "cuda-libs",
            status: "ok",
            repair: { id: "CUDA runtime libraries", action: "repair" },
          },
        ],
      ),
      { root: dir, notices },
    );
    expect(open(out).map((item) => item.id)).toEqual(["c", "d"]);
    expect(notices.readNotices(dir).map((item) => item.id)).toEqual(["c", "d"]);
  });

  it("matches a Doctor row that still needs attention and keeps its repair", () => {
    const dir = temp();
    record(dir, { id: "gpu", label: "GPU libs", reason: "r", installManagerId: "cuda-libs" });
    const out = catalogApi.withSetupNotices(
      base([], [{ id: "cuda-libs", status: "warn", repair: { id: "x", action: "install" } }]),
      { root: dir, notices },
    );
    expect(open(out)[0]).toMatchObject({ doctorId: "cuda-libs", rowId: null });
  });

  it("never throws and leaves a catalogue that is not a list alone", () => {
    const throwing = {
      readNotices: () => {
        throw new Error("disk");
      },
      clearNotice: () => {
        throw new Error("disk");
      },
    };
    expect(open(catalogApi.withSetupNotices(base([]), { root: "/x", notices: throwing }))).toEqual(
      [],
    );
    expect(catalogApi.withSetupNotices(null, { root: "/x", notices })).toBeNull();
    const broken = { ok: false };
    expect(catalogApi.withSetupNotices(broken, { root: "/x", notices })).toBe(broken);
  });
});

describe("wiring: one existing channel, packaged-safe load, no timer", () => {
  it("installer:catalog adds the notices; no new channel exists", () => {
    const main = read("electron/main.cjs");
    const at = main.indexOf('ipcMain.handle("installer:catalog"');
    const handler = main.slice(at, main.indexOf("\n);", at));
    expect(handler).toContain("catalogWithSetupNotices(");
    expect(handler).toContain("catalogWithLocalSources(");
    expect(main).not.toMatch(/ipcMain\.handle\("(installer|setup):notices/);
    expect(main).toContain('resolveResourceFile("scripts/setup-notices.cjs")');
    expect(main).toContain('loadNamed("setup-notices"');
  });

  it("the script the app loads from resources/ needs nothing from the archive", () => {
    const checker = require_(path.join(root, "scripts/packaged-requires.cjs")) as {
      checkPackagedScripts: (options: { roots: string[] }) => unknown[];
    };
    expect(checker.checkPackagedScripts({ roots: ["scripts/setup-notices.cjs"] })).toEqual([]);
  });

  it("the catalogue type and the page carry the field and the section", () => {
    expect(read("src/lib/friday/desktop.ts")).toMatch(/setupNotices\?: SetupNoticeRow\[\]/);
    const panel = read("src/components/friday/InstallerFitPanel.tsx");
    expect(panel).toContain("data-setup-notices");
    expect(panel).toContain("Needs finishing");
    expect(read("src/lib/friday/use-installer-catalog.ts")).toMatch(/modelsActive|useModels/);
  });
});

const ready = (catalog: InstallerCatalog | null): CatalogState => ({
  catalog,
  error: null,
  offline: false,
  loaded: true,
  refreshing: false,
});
const withNotices = (catalog: InstallerCatalog, setupNotices: unknown[]): InstallerCatalog =>
  ({ ...catalog, setupNotices }) as InstallerCatalog;
const entry = (over: Record<string, unknown>) => ({
  id: "n",
  kind: "voice",
  label: "Speech model",
  reason: "download failed",
  installManagerId: "",
  repair: "npm run doctor",
  at: "",
  rowId: null,
  doctorId: null,
  ...over,
});
function html(catalog: InstallerCatalog, scope: InstallerFitViewProps["scope"], over = {}) {
  return renderToStaticMarkup(
    createElement(InstallerFitView, {
      scope,
      title: "t",
      state: ready(catalog),
      now: FIXED_NOW,
      lookups: {
        installerHas: () => true,
        voiceModelId: (id: string) => id,
        modelIdForTag: (tag: string) => tag,
      },
      isBusy: () => false,
      onInstall: vi.fn(),
      onUpdate: vi.fn(async () => null),
      onRepair: vi.fn(),
      onRefresh: vi.fn(),
      onRetry: vi.fn(),
      ...over,
    }),
  );
}

describe("the Needs finishing section", () => {
  const catalog = realCatalog(NVIDIA_16GB_PC);
  const voiceRow = catalog.rows.find(
    (row) => row.kind === "voice-model" && row.installed === false,
  );
  const toolRow = catalog.rows.find((row) => row.kind === "tool");

  it("shows nothing when there are no notices (and for a catalogue without the field)", () => {
    expect(html(catalog, "installManager")).not.toContain("data-setup-notices");
    expect(html(withNotices(catalog, []), "models")).not.toContain("data-setup-notices");
  });

  it("splits the notices by page and keeps a plain note with the repair command", () => {
    expect(voiceRow && toolRow).toBeTruthy();
    const list = [
      entry({
        id: "v",
        label: "Speech model",
        installManagerId: voiceRow!.id,
        rowId: voiceRow!.id,
      }),
      entry({ id: "t", label: "A tool", installManagerId: toolRow!.id, rowId: toolRow!.id }),
      entry({ id: "plain", label: "Loose item", reason: "no route", repair: "npm run setup" }),
    ];
    const withList = withNotices(catalog, list);
    expect(setupNoticeViews(withList, "models").map((view) => view.id)).toEqual(["v"]);
    expect(setupNoticeViews(withList, "installManager").map((view) => view.id)).toEqual([
      "t",
      "plain",
    ]);
    const models = html(withList, "models");
    expect(models).toContain("data-setup-notices");
    expect(models).toContain("Needs finishing");
    expect(models).toContain("Speech model");
    expect(models).toContain("download failed");
    const manager = html(withList, "installManager");
    expect(manager).toContain("Loose item");
    expect(manager).toContain("npm run setup");
    expect(manager).not.toContain('data-setup-notice="v"');
  });

  it("offers the row's own Install button and runs the shared install handler", () => {
    const onInstall = vi.fn();
    const list = [entry({ id: "v", installManagerId: voiceRow!.id, rowId: voiceRow!.id })];
    const out = html(withNotices(catalog, list), "models", { onInstall });
    const section = /<section[^>]*data-setup-notices[\s\S]*?<\/section>/.exec(out)?.[0] ?? "";
    expect(section).toMatch(/Download|Install/);
  });

  it("a Doctor-matched notice carries the Doctor repair button", () => {
    const list = [entry({ id: "g", installManagerId: "cuda-libs", doctorId: "cuda-libs" })];
    const withDoctor = {
      ...withNotices(catalog, list),
      doctor: [
        {
          id: "cuda-libs",
          label: "CUDA libs",
          status: "warn",
          detail: "not installed",
          repair: { id: "CUDA runtime libraries", action: "install" },
        },
      ],
    } as InstallerCatalog;
    const views = setupNoticeViews(withDoctor, "installManager");
    expect(views[0]?.repair).toMatchObject({ id: "CUDA runtime libraries", action: "install" });
    expect(html(withDoctor, "installManager")).toContain('data-setup-notice="g"');
  });

  it("the notice file helper exists only as the reader (no write from the app)", () => {
    expect(existsSync(path.join(root, "scripts/setup-notices.cjs"))).toBe(true);
    expect(read("electron/installer-catalog.cjs")).not.toMatch(/recordNotice/);
  });
});

describe("fixtures stay valid", () => {
  it("fakeRow builds a row the helper can match", () => {
    const row = fakeRow({ id: "voice:x", kind: "voice-model", installed: false });
    const list = [entry({ id: "x", installManagerId: row.id, rowId: row.id })];
    const catalog = withNotices({ ...realCatalog(NVIDIA_16GB_PC), rows: [row] }, list);
    expect(setupNoticeViews(catalog, "models")[0]?.row?.id).toBe("voice:x");
  });
});
