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
});
