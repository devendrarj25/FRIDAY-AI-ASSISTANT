/**
 * Skills page customization: per-row enable/disable/remove go through the
 * existing capability IPC and the existing governance gate. Filters and the
 * details panel read real manifest fields — they do not invent copy.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("Skills page customization", () => {
  const source = read("src/routes/skills.tsx");

  it("lists 243 skills a page at a time, with Show more, Show all, and a reset when a filter changes", () => {
    expect(source).toContain("const SKILLS_PAGE = 60");
    expect(source).toContain("rows.slice(0, shown)");
    expect(source).toMatch(/Showing \{shown\} of \{rows\.length\} skills/);
    expect(source).toContain("Show all");
    expect(source).toContain("pageState.key === filterKey ? pageState.shown : SKILLS_PAGE");
  });

  it("wires the existing capability toggle and uninstall paths", () => {
    expect(source).toContain('useCapabilities("skills")');
    expect(source).toContain("toggle");
    expect(source).toContain("uninstallPack");
    expect(source).toContain('from "@/lib/friday/marketplace"');
    expect(source).toContain("setSkillEnabled");
  });

  it("files enable, disable and uninstall through governance instead of calling IPC directly", () => {
    expect(source).toContain("governance.submit");
    expect(source).toContain('kind: "install"');
    expect(source).toMatch(/Confirm remove/);
    expect(source).not.toMatch(/toggle\([^)]+\)\s*;\s*\n\s*await refresh/);
    expect(source).toContain("Could not update the skill runtime");
  });

  it("filters by live categories and searches name/category/summary", () => {
    expect(source).toContain("All categories");
    expect(source).toContain("s.category !== category");
    expect(source).toContain("s.summary");
    expect(source).toContain("Search name, category, or summary");
  });

  it("shows real manifest fields in the details panel", () => {
    expect(source).toContain("openRow.summary");
    expect(source).toContain("openRow.description");
    expect(source).toContain("openRow.risk");
    expect(source).toContain("openRow.permissions");
    expect(source).toContain("openRow.inputs");
  });

  it("imports skills from zip, folder, and git clone, and forges on this page", () => {
    expect(source).toContain("installSkillZip");
    expect(source).toContain("installSkillFolder");
    expect(source).toContain("installSkillGit");
    expect(source).toContain("Git clone");
    expect(source).toContain("forgeSkill");
    expect(source).toContain("invokeSkill");
    expect(source).toContain("allowDisabled");
    expect(source).toContain("Test selected");
    expect(source).not.toContain("hub.inspectFolder");
  });

  it("keeps every install route in one panel, apart from the list", () => {
    const install = source.indexOf('title="Install a skill"');
    const list = source.indexOf('title="All Skills"');
    const forge = source.indexOf('title="Create and test"');
    expect(install).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(install);
    expect(forge).toBeGreaterThan(list);
    const panel = source.slice(install, list);
    for (const route of [
      "CapabilityMarket",
      "CapabilityImport",
      'addFrom("zip")',
      'addFrom("folder")',
      "Git clone",
    ]) {
      expect(panel).toContain(route);
    }
    // The page header holds only Refresh, no longer a crowd of install controls.
    const header = source.slice(
      source.indexOf("actions={"),
      source.indexOf('<div className="space-y-4">'),
    );
    expect(header).toContain("Refresh");
    expect(header).not.toContain("addFrom(");
  });

  it("tells built-in skills from installed ones and never offers to remove a shipped skill", () => {
    expect(source).toContain('s.origin === "app"');
    expect(source).toContain("Built-in");
    expect(source).toContain("Installed");
    expect(source).toContain('source === "builtin"');
    expect(source).toContain('source === "installed"');
    expect(source).toContain('disabled={Boolean(busyId) || !s.id || s.origin === "app"}');
  });

  it("has a one-click Test, a Refresh with a Retry, and loading and desktop-only states", () => {
    expect(source).toContain("onTestShortcut");
    expect(source).toContain('id="skill-test-input"');
    expect(source).toContain("onRefresh");
    expect(source).toContain('label: "Retry"');
    expect(source).toContain("<LoadingState");
    expect(source).toContain("Skills are listed by the FRIDAY desktop app");
  });

  it("shows version, source, folder and approval prompt from the real manifest", () => {
    expect(source).toContain("openRow.approvalPrompt");
    expect(source).toContain("openRow.version");
    expect(source).toContain("openRow.path");
    expect(source).toContain("item.approvalPrompt");
  });
});
