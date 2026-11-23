/**
 * The downloads-by-fit panel (src/components/friday/InstallerFitPanel.tsx) on both pages, drawn from real catalogue
 * payloads for fake PCs: every page state (loading, offline, error with Retry, empty, ready, stale, refreshing,
 * rate-limited), the three groups with the not-supported one folded but one click away, the buttons each row may have, and
 * the wiring (one store, the shared poller only while a refresh runs, no timer of its own, no dead button).
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
import type { InstallerCatalog } from "../../src/lib/friday/desktop";
import type { CatalogState } from "../../src/lib/friday/use-installer-catalog";
import { groupRows, INSTALLER_SCOPES } from "../../src/lib/friday/installer-fit";
import {
  FIXED_NOW,
  NO_GPU_PC,
  NVIDIA_16GB_PC,
  fakeRow,
  realCatalog,
  withRows,
} from "./helpers/installer-catalog-fixtures";

const read = (file: string) =>
  readFileSync(path.join(import.meta.dirname, "..", "..", file), "utf8").replace(/\r\n/g, "\n");

const ready = (
  catalog: CatalogState["catalog"],
  over: Partial<CatalogState> = {},
): CatalogState => ({
  catalog,
  error: null,
  offline: false,
  loaded: true,
  refreshing: false,
  ...over,
});

function html(
  state: CatalogState,
  over: Partial<InstallerFitViewProps> = {},
  scope: InstallerFitViewProps["scope"] = "installManager",
): string {
  return renderToStaticMarkup(
    createElement(InstallerFitView, {
      scope,
      title: scope === "models" ? "Models this PC can run" : "Downloads for this PC",
      state,
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

/** The catalogue cut to some rows (a short list shows without the "Show all" window). */
const only = (catalog: InstallerCatalog, ...ids: string[]): InstallerCatalog =>
  withRows(catalog, {}, { rows: catalog.rows.filter((row) => ids.includes(row.id)) });

const inScope = (catalog: InstallerCatalog, kinds: readonly string[], state: string) =>
  catalog.rows.filter((row) => kinds.includes(row.kind) && row.fit.state === state);

/** An enabled-or-disabled test that ignores the `disabled:` utility classes. */
const isDisabled = (markup: string) => /\sdisabled(=|\s|>)/.test(markup);

/** The markup of one row's article. */
const article = (markup: string, id: string): string =>
  new RegExp(
    `<article[^>]*data-fit-row="${id.replace(/[().]/g, "\\$&")}"[\\s\\S]*?</article>`,
  ).exec(markup)?.[0] ?? "";

const buttonLabels = (markup: string) =>
  [...markup.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    m[1]!.replace(/<[^>]+>/g, "").trim(),
  );

describe("page states", () => {
  it("shows a loading skeleton before the first read", () => {
    const out = html(ready(null, { loaded: false }));
    expect(out).toContain("Reading what this PC can run…");
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('data-fit-phase="loading"');
  });

  it("says the list needs the installed app when there is no desktop bridge", () => {
    const out = html(ready(null, { offline: true }));
    expect(out).toContain("The fit list appears in the installed FRIDAY app");
    expect(out).toContain('data-fit-phase="offline"');
  });

  it("shows an error with Retry when no list could be read", () => {
    const out = html(ready(null, { error: "ipc budget expired" }));
    expect(out).toContain('role="alert"');
    expect(out).toContain("The download list could not be read");
    expect(out).toContain("ipc budget expired");
    expect(buttonLabels(out)).toContain("Retry");
  });

  it("keeps the saved list and offers Retry when a later read fails", () => {
    const out = html(ready(realCatalog(NO_GPU_PC), { error: "gone" }));
    expect(out).toContain("The last read failed (gone). The saved list is shown.");
    expect(out).toContain('data-fit-phase="ready"');
    expect(out).toContain("Ready for this PC");
    expect(buttonLabels(out)).toContain("Retry");
  });

  it("shows an empty state when the catalogue has nothing for the page", () => {
    const empty = withRows(realCatalog(NO_GPU_PC), {}, { rows: [] });
    const out = html(ready(empty));
    expect(out).toContain("Nothing to list yet");
    expect(out).toContain('data-fit-phase="empty"');
  });

  it("says it is using the saved list when privacy is on or the PC is offline, and marks stale answers", () => {
    const stale = withRows(
      only(realCatalog(NVIDIA_16GB_PC, { online: false }), "ripgrep"),
      {
        ripgrep: {
          installed: true,
          installedVersion: "14.1.0",
          latestVersion: "14.2.0",
          updateStatus: "current",
          stale: true,
          source: "github-api",
        },
      },
      { lastRefreshAt: FIXED_NOW - 86_400_000 },
    );
    const out = html(ready(stale), { initiallyOpen: [] });
    expect(out).toContain('data-fit-notice="offline"');
    expect(out).toContain("using the saved list");
    expect(out).toContain("Last checked 24 h ago");
    const row = article(out, "ripgrep");
    expect(row).toContain("Stale");
    expect(row).toContain("Up to date");
    expect(row).toContain("via GitHub releases");
    const priv = html(ready(realCatalog(NVIDIA_16GB_PC, { privacy: true })));
    expect(priv).toContain('data-fit-notice="privacy"');
    expect(priv).toContain("using the saved list");
  });

  it("names a running refresh and the PC still being measured", () => {
    const base = realCatalog(NVIDIA_16GB_PC);
    const out = html(ready({ ...base, refreshing: true, hardwareKnown: false }));
    expect(out).toContain('data-fit-notice="refreshing"');
    expect(out).toContain('data-fit-notice="measuring"');
    expect(out).toContain("Refreshing…");
  });
});

describe("a PC with no graphics card", () => {
  const catalog = realCatalog(NO_GPU_PC);

  it("shows the three groups and folds the not-supported one, with its count and a way to open it", () => {
    const out = html(ready(catalog));
    for (const title of ["Ready for this PC", "Works with limits", "Not supported on this PC"])
      expect(out).toContain(title);
    expect(out).toMatch(/data-fit-group="unsupported"[\s\S]*?aria-expanded="false"/);
    expect(out).toMatch(/data-fit-group="supported"[\s\S]*?aria-expanded="true"/);
    const count = inScope(catalog, INSTALLER_SCOPES.installManager, "unsupported").length;
    expect(count).toBeGreaterThan(0);
    expect(out).toMatch(new RegExp(`Not supported on this PC</span><span[^>]*>${count}</span>`));
    // folded: the rows are not drawn yet, and no row is dropped from the catalogue
    expect(out).not.toContain('data-fit-row="CUDA runtime libraries"');
    expect(catalog.split.unsupported).toContain("CUDA runtime libraries");
  });

  it("opens to every not-supported row with the plain reason, what it needs and the alternative, and no button", () => {
    const out = html(ready(catalog), { initiallyOpen: ["unsupported"] });
    const unsupportedRows = [...out.matchAll(/data-fit-state="unsupported"/g)].length;
    expect(unsupportedRows).toBe(
      inScope(catalog, INSTALLER_SCOPES.installManager, "unsupported").length,
    );
    const cuda = article(out, "CUDA runtime libraries");
    expect(cuda).toContain("Needs an NVIDIA graphics card; none was found.");
    expect(cuda).toContain("What it would need:");
    expect(cuda).toContain("NVIDIA driver 527.41 or newer");
    expect(cuda).not.toContain("<button");
    expect(article(out, "ONNX Runtime (GPU)")).toContain(
      "Use instead:</span> ONNX Runtime (DirectML)",
    );
  });

  it("cuts a long ready list to the first rows and offers Show all", () => {
    const out = html(ready(catalog));
    const shown = [...out.matchAll(/data-fit-state="supported"/g)].length;
    expect(shown).toBe(12);
    const readyCount = inScope(catalog, INSTALLER_SCOPES.installManager, "supported").length;
    expect(out).toContain(`Show all (${readyCount - 12} more)`);
  });

  it("the Models page lists the big speech models as not supported with their VRAM need", () => {
    const out = html(ready(catalog), { initiallyOpen: ["unsupported"] }, "models");
    const row = article(out, "voice:faster-whisper-medium");
    expect(row).toContain('data-fit-state="unsupported"');
    expect(row).toContain("3 GB of graphics memory (VRAM)");
    expect(out).not.toContain("data-fit-doctor");
    expect(out).toContain("Models this PC can run");
  });
});

describe("an NVIDIA 16 GB PC", () => {
  const catalog = withRows(
    realCatalog(NVIDIA_16GB_PC, { detected: [{ id: "CUDA runtime libraries", installed: false }] }),
    { "ONNX Runtime (GPU)": { installed: false } },
  );

  it("shows the CUDA hint and an Install button on the runtime row", () => {
    const out = html(ready(only(catalog, "CUDA runtime libraries", "ONNX Runtime (GPU)")));
    const row = article(out, "CUDA runtime libraries");
    expect(row).toContain("GPU found; install the CUDA runtime libraries");
    expect(buttonLabels(row)).toEqual(["Install"]);
  });

  it("a limited row lists its reason lines and still has a button (its confirm opens on click)", () => {
    const out = html(ready(only(catalog, "CUDA runtime libraries", "ONNX Runtime (GPU)")));
    const row = article(out, "ONNX Runtime (GPU)");
    expect(row).toContain('data-fit-state="limited"');
    expect(row).toContain("not installed; install the CUDA runtime libraries first.");
    expect(buttonLabels(row)).toEqual(["Install"]);
    expect(out).toMatch(/data-fit-group="limited"[\s\S]*?aria-expanded="true"/);
  });

  it("has an empty not-supported list that still opens", () => {
    const out = html(ready(only(catalog, "ONNX Runtime (GPU)")), {
      initiallyOpen: ["unsupported"],
    });
    expect(out).toContain("Nothing in this list.");
  });

  it("shows the Doctor rows with their Repair or Install button, only on the Install Manager", () => {
    const out = html(ready(catalog));
    const doctor = /<section data-fit-doctor[\s\S]*?<\/section>/.exec(out)?.[0] ?? "";
    expect(doctor).toContain("CUDA runtime libraries (cuBLAS 12, cuDNN 9)");
    expect(doctor).toContain("Needs attention");
    expect(doctor).toContain("not installed: speech and ONNX stay on the CPU");
    expect(buttonLabels(doctor)).toContain("Install");
    expect(html(ready(catalog), {}, "models")).not.toContain("data-fit-doctor");
  });
});

describe("version rows and their buttons", () => {
  const base = realCatalog(NVIDIA_16GB_PC);
  const updated = withRows(base, {
    ripgrep: {
      installed: true,
      installedVersion: "14.1.0",
      latestVersion: "14.2.0",
      updateStatus: "update",
      source: "github-api",
      checkedAt: FIXED_NOW - 60_000,
    },
    "uv (Python)": {
      installed: true,
      installedVersion: "0.9.0",
      updateStatus: "error",
      error: "no source answered",
    },
  });

  it("shows the update badge, both versions, the source, when it was checked, and an Update button", () => {
    const out = html(ready(only(updated, "ripgrep", "uv (Python)")));
    const row = article(out, "ripgrep");
    expect(row).toContain("Update available");
    expect(row).toContain("Installed 14.1.0");
    expect(row).toContain("Latest 14.2.0");
    expect(row).toContain("via GitHub releases");
    expect(row).toContain("checked 1 min ago");
    expect(buttonLabels(row)).toEqual(["Update"]);
    expect(article(out, "uv (Python)")).toContain("Check failed");
  });

  it("ripgrep floats up the list because it has an update", () => {
    const out = html(ready(only(updated, "ripgrep", "uv (Python)", "Docker")));
    expect(out.indexOf('data-fit-row="ripgrep"')).toBeGreaterThan(-1);
    expect(out.indexOf('data-fit-row="ripgrep"')).toBeLessThan(
      out.indexOf('data-fit-row="uv (Python)"') === -1
        ? Infinity
        : out.indexOf('data-fit-row="uv (Python)"'),
    );
  });

  it("disables a row's buttons while its own job runs", () => {
    const out = html(ready(only(updated, "ripgrep")), { isBusy: (row) => row.id === "ripgrep" });
    expect(isDisabled(article(out, "ripgrep"))).toBe(true);
  });

  it("an installed row without an update has no Install and no Update button", () => {
    const out = html(
      ready(
        only(
          withRows(base, {
            ripgrep: { installed: true, installedVersion: "14.2.0", updateStatus: "current" },
          }),
          "ripgrep",
        ),
      ),
    );
    expect(buttonLabels(article(out, "ripgrep"))).toEqual([]);
  });

  it("a row nothing here can install shows no button instead of a dead one", () => {
    const out = html(ready(only(withRows(base, { ripgrep: { installed: false } }), "ripgrep")), {
      lookups: { installerHas: () => false, voiceModelId: () => null, modelIdForTag: () => null },
    });
    expect(buttonLabels(article(out, "ripgrep"))).toEqual([]);
  });
});

describe("Refresh list", () => {
  const base = realCatalog(NVIDIA_16GB_PC);
  const button = (markup: string) =>
    /<button[^>]*title="Ask the official sources[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";

  it("is enabled when nothing limits it", () => {
    const out = button(html(ready({ ...base, generatedAt: FIXED_NOW, nextManualRefreshInMs: 0 })));
    expect(out).toContain("Refresh list");
    expect(isDisabled(out)).toBe(false);
  });

  it("is disabled with the countdown while the main process rate-limits it", () => {
    const out = button(
      html(ready({ ...base, generatedAt: FIXED_NOW, nextManualRefreshInMs: 42_000 })),
    );
    expect(isDisabled(out)).toBe(true);
    expect(out).toContain("Refresh list (42 s)");
  });

  it("is disabled while a refresh runs, on the owner's click or in the background", () => {
    expect(isDisabled(button(html(ready({ ...base, refreshing: true }))))).toBe(true);
    expect(button(html(ready(base, { refreshing: true })))).toContain("Refreshing…");
  });

  it("stays usable as the way to try again before the first list has loaded", () => {
    const out = button(html(ready(null, { loaded: false })));
    expect(out).toContain("Refresh list");
    expect(isDisabled(out)).toBe(false);
  });
});

describe("a row with no readable fit state is kept, not dropped", () => {
  it("lists it under Works with limits", () => {
    const odd = fakeRow({ id: "odd", name: "Odd row" });
    (odd.fit as { state: string }).state = "weird";
    const catalog = withRows(realCatalog(NO_GPU_PC), {}, { rows: [odd] });
    const limited = groupRows(catalog, { now: FIXED_NOW }).find((g) => g.state === "limited")!;
    expect(limited.rows.map((r) => r.id)).toEqual(["odd"]);
  });
});

describe("wiring", () => {
  const panel = read("src/components/friday/InstallerFitPanel.tsx");
  const hook = read("src/lib/friday/use-installer-catalog.ts");

  it("mounts once on the Install Manager and once on the Models page, and the voice packs read the same store", () => {
    expect(read("src/routes/install-manager.tsx")).toContain(
      '<InstallerFitPanel scope="installManager" />',
    );
    expect(read("src/routes/models.tsx")).toContain('<InstallerFitPanel scope="models" />');
    const voice = read("src/components/friday/VoicePacksCard.tsx");
    expect(voice).toContain("useInstallerCatalog().catalog");
    expect(voice).toContain("bundleFit(");
    expect(voice).toContain("data-pack-fit");
  });

  it("owns no timer: it reads on mount and on installer events, and polls on the shared poller only while refreshing", () => {
    for (const source of [panel, hook, read("src/lib/friday/installer-fit.ts")]) {
      expect(source).not.toMatch(/setInterval\(/);
    }
    expect(hook).toContain("export const REFRESHING_POLL_MS = 3000;");
    expect(hook).toMatch(
      /useLivePoll\(\s*"installer\.catalog",[\s\S]*?REFRESHING_POLL_MS,\s*state\.catalog\?\.refreshing === true,\s*\)/,
    );
    expect(hook).toContain("installerCatalogStore.changed()");
    expect(hook).toContain("installerState.lastScanAt");
    // the countdown is written by the shared one-second clock, not by a render timer
    expect(panel).toContain("onVisibleSecond(");
  });

  it("calls the three bridge methods and nothing else on the main process", () => {
    expect(hook).toContain("api.installerCatalog()");
    expect(hook).toContain("api.refreshInstallerCatalog()");
    expect(hook).toContain("api.updateInstallerRow({ id, autonomy");
    expect(panel).not.toMatch(/ipcRenderer|window\.friday/);
  });

  it("every Button on the panel has a handler or a state", () => {
    const tags = [...panel.matchAll(/<Button\b[^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThan(5);
    const dead = tags.filter((tag) => !/onClick=|disabled=|asChild/.test(tag));
    expect(dead).toEqual([]);
  });

  it("uses the shared states and tokens: ErrorState with Retry, LoadingState, EmptyState, no hard-coded colours", () => {
    expect(panel).toContain("<ErrorState");
    expect(panel).toContain("<LoadingState");
    expect(panel).toContain("<EmptyState");
    expect(panel).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|\d+px/);
  });

  it("asks the autonomy dial before an update and sends the owner's yes only after the dialog", () => {
    expect(panel).toContain("dialOf(settings.approvalLevel, settings.halted)");
    expect(panel).toMatch(/update\(row\.id, dial\);[\s\S]*?outcome\.kind === "consent"/);
    expect(panel).toContain("update(row.id, dial, { granted: true })");
  });
});
