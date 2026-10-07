/**
 * Modules page customization: Remove uses uninstallPack after confirm,
 * search/category match Skills, details show declared ui.page without a
 * second router, Forge/Test reuse module-forge and modules:invoke.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("Modules page customization", () => {
  const source = read("src/routes/modules.tsx");

  it("keeps the existing Market / Import / Load-from-folder actions", () => {
    expect(source).toContain('useCapabilities("modules")');
    expect(source).toContain("CapabilityMarket");
    expect(source).toContain("CapabilityImport");
    expect(source).toContain("Load from folder");
    expect(source).toContain("hub.inspectFolder");
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
    expect(source).toContain("row.category !== category");
    expect(source).toContain("Search name, category, or summary");
  });

  it("shows declared ui.page / ui.icon in a details panel, not a dynamic route", () => {
    expect(source).toContain("mod.uiPage");
    expect(source).toContain("mod.uiIcon");
    expect(source).toContain("Full dynamic per-module routes are a future step");
    expect(source).not.toContain('createFileRoute("/modules/$');
  });

  it("wires existing forgeModule and invokeModulePack Test selected", () => {
    expect(source).toContain("forgeModule");
    expect(source).toContain("invokeModulePack");
    expect(source).toContain("allowDisabled: true");
    expect(source).toContain("Create and test");
    expect(source).toContain("Test selected");
    expect(source).not.toContain("verifyCapability");
  });
});
