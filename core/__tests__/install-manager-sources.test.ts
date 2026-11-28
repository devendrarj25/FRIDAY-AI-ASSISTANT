/**
 * Install Manager rows say where a tool lives, where its newest version was read from, that a notify-only row is the
 * owner's to update, and that a row without a published checksum is not installed by FRIDAY. Pure helpers plus the
 * rendered row, driven by fake catalogue rows (no network, no Windows).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  InstallerFitView,
  type InstallerFitViewProps,
} from "../../src/components/friday/InstallerFitPanel";
import {
  homeLine,
  latestFromLine,
  notifyLine,
  checksumLine,
  rowActions,
  rowView,
} from "../../src/lib/friday/installer-fit";
import { FIXED_NOW, NO_GPU_PC, fakeRow, realCatalog } from "./helpers/installer-catalog-fixtures";

const read = (file: string) =>
  readFileSync(path.join(import.meta.dirname, "..", "..", file), "utf8").replace(/\r\n/g, "\n");
const installer = { via: "installer", id: "ripgrep" } as const;

describe("where a tool lives", () => {
  it("names the three homes in plain words", () => {
    expect(homeLine(fakeRow({ home: "friday-root" }))).toBe("In FRIDAY's folder");
    expect(homeLine(fakeRow({ home: "machine" }))).toBe("On this PC");
    expect(homeLine(fakeRow({ home: "npm-global" }))).toBe("npm global");
  });
  it("says nothing for an unknown or absent home", () => {
    expect(homeLine(fakeRow())).toBeNull();
    expect(homeLine(fakeRow({ home: "somewhere-new" }))).toBeNull();
  });
});

describe("where the newest version was read from", () => {
  it("names the source kind", () => {
    expect(latestFromLine(fakeRow({ source: "github-api" }))).toBe(
      "Latest checked from GitHub releases",
    );
  });
  it("adds via cache for a stale answer and via pinned for FRIDAY's own pin", () => {
    expect(latestFromLine(fakeRow({ source: "pypi-json", stale: true }))).toBe(
      "Latest checked from PyPI (via cache)",
    );
    expect(latestFromLine(fakeRow({ source: "pinned", pinnedAnswer: true }))).toBe(
      "Latest checked from pinned by FRIDAY (via pinned)",
    );
  });
  it("adds via primary or fallback when the row carries it", () => {
    expect(latestFromLine(fakeRow({ source: "npm", via: "fallback" }))).toBe(
      "Latest checked from npm (via fallback)",
    );
    expect(latestFromLine(fakeRow({ source: "npm", via: "primary" }))).toBe(
      "Latest checked from npm (via primary)",
    );
  });
  it("says nothing when no source answered", () => {
    expect(latestFromLine(fakeRow({ source: null }))).toBeNull();
  });
});

describe("notify-only and checksum rows", () => {
  it("a notify-only row with an update shows the plain notice and no Update button", () => {
    const row = fakeRow({ installed: true, updateStatus: "update", notifyOnly: true });
    expect(notifyLine(row)).toBe("Newer version available, update it yourself");
    expect(rowActions(row, { target: installer, busy: false }).update).toBeNull();
  });
  it("a notify-only row that is current shows no notice", () => {
    expect(notifyLine(fakeRow({ notifyOnly: true, updateStatus: "current" }))).toBeNull();
  });
  it("a normal row keeps its Update button", () => {
    const row = fakeRow({ installed: true, updateStatus: "update", notifyOnly: false });
    expect(rowActions(row, { target: installer, busy: false }).update?.label).toBe("Update");
  });
  it("downloadReady false says why but never hides a working Install button", () => {
    const row = fakeRow({ downloadReady: false });
    expect(checksumLine(row)).toBe(
      "No published checksum yet: the direct download fallback stays off for this tool",
    );
    const actions = rowActions(row, { target: installer, busy: false });
    expect(actions.install).not.toBeNull();
    expect(actions.note).toBe(
      "No published checksum yet: the direct download fallback stays off for this tool",
    );
  });
  it("downloadReady false still allows Update", () => {
    const row = fakeRow({ installed: true, updateStatus: "update", downloadReady: false });
    expect(rowActions(row, { target: installer, busy: false }).update).not.toBeNull();
  });
  it("downloadReady true or absent keeps Install", () => {
    expect(
      rowActions(fakeRow({ downloadReady: true }), { target: installer, busy: false }).install,
    ).not.toBeNull();
    expect(rowActions(fakeRow(), { target: installer, busy: false }).install).not.toBeNull();
    expect(checksumLine(fakeRow({ downloadReady: true }))).toBeNull();
  });
});

describe("the rendered row", () => {
  const props = (rows: ReturnType<typeof fakeRow>[]): InstallerFitViewProps => {
    const base = realCatalog(NO_GPU_PC);
    return {
      scope: "installManager",
      title: "Downloads for this PC",
      state: {
        catalog: { ...base, rows },
        error: null,
        offline: false,
        loaded: true,
        refreshing: false,
      },
      now: FIXED_NOW,
      lookups: { installerHas: () => true, voiceModelId: () => null, modelIdForTag: () => null },
      isBusy: () => false,
      onInstall: vi.fn(),
      onUpdate: vi.fn(async () => null),
      onRepair: vi.fn(),
      onRefresh: vi.fn(),
      onRetry: vi.fn(),
    };
  };
  it("rowView carries the three lines", () => {
    const view = rowView(
      fakeRow({ home: "machine", notifyOnly: true, updateStatus: "update", installed: true }),
      new Map(),
      FIXED_NOW,
    );
    expect(view.homeText).toBe("On this PC");
    expect(view.latestFromText).toBe("Latest checked from GitHub releases");
    expect(view.notifyText).toBe("Newer version available, update it yourself");
  });
  it("the wiring reads the helpers and adds no new timer", () => {
    const panel = read("src/components/friday/InstallerFitPanel.tsx");
    expect(panel).toContain("view.homeText");
    expect(panel).toContain("view.latestFromText");
    expect(panel).toContain("view.notifyText");
    expect(panel).not.toMatch(/setInterval/);
  });
  it("renders the home line and the checksum note for a row, and keeps its Install button", () => {
    const html = renderToStaticMarkup(
      createElement(
        InstallerFitView,
        props([fakeRow({ home: "friday-root", downloadReady: false, name: "ripgrep" })]),
      ),
    );
    expect(html).toContain("In FRIDAY&#x27;s folder");
    expect(html).toContain(
      "No published checksum yet: the direct download fallback stays off for this tool",
    );
    const article = html.slice(html.indexOf("<article"), html.indexOf("</article>"));
    expect(article).toContain("<button");
  });
});

describe("a row found in a local build", () => {
  it("is named in plain words on the page, and the catalog row type stays additive", () => {
    const page = read("src/routes/install-manager.tsx");
    expect(page).toContain("Found on this PC (from a local build)");
    const desktop = read("src/lib/friday/desktop.ts");
    expect(desktop).toMatch(/export type InstallerCatalogRow = \{/);
    expect(read("electron/install-inventory.cjs")).toContain(
      "return { origin: entry.origin, dir: entry.dir }",
    );
    expect(read("electron/main.cjs")).toContain("{ ...row, localSource: found }");
  });
});
