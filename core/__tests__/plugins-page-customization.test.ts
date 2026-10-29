/**
 * Plugins page customization: search/category, Details show hooks/permissions,
 * Remove uses uninstallPack, Forge/Test reuse plugin-forge, versions/updates stay.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("Plugins page customization", () => {
  const source = read("src/routes/plugins.tsx");

  it("keeps Market, Check updates, and the version/latest table", () => {
    expect(source).toContain('useCapabilities("plugins")');
    expect(source).toContain("CapabilityMarket");
    expect(source).toContain("Check updates");
    expect(source).toContain("checkPluginUpdates");
    expect(source).toContain('p.latest || "—"');
    expect(source).not.toContain("latest: item.version");
  });

  it("adds CapabilityImport and zip/folder/git through the shared importer", () => {
    expect(source).toContain("CapabilityImport");
    expect(source).toContain('tree="plugins"');
  });

  it("wires uninstallPack after in-page confirm and refuses shipped app packs", () => {
    expect(source).toContain("uninstallPack");
    expect(source).toMatch(/Confirm remove/);
    expect(source).toContain("uninstallPack(row.id)");
    expect(source).toContain('row.origin === "app"');
    expect(source).toContain("Disable them instead of removing");
  });

  it("filters by live categories and searches name/category/summary", () => {
    expect(source).toContain("All categories");
    expect(source).toContain("p.category !== category");
    expect(source).toContain("Search name, category, or summary");
  });

  it("shows declared hooks and permissions in Details", () => {
    expect(source).toContain("openRow.hooks");
    expect(source).toContain("openRow.permissions");
    expect(source).toContain("Hooks —");
  });

  it("Enable Switch also updates the plugin runtime copy", () => {
    expect(source).toContain("setPluginEnabled(row.id, next)");
    expect(source).toContain("toggle(row.id, next)");
  });

  it("wires existing forgePlugin and dispatchPluginHooks Test selected", () => {
    expect(source).toContain("forgePlugin");
    expect(source).toContain("dispatchPluginHooks");
    expect(source).toContain("allowDisabled: true");
    expect(source).toContain("pluginId: openRow.id");
    expect(source).toContain("Create and test");
    expect(source).toContain("Test selected");
  });
});
