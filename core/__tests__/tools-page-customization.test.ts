/**
 * Tools page: zip/folder/git clone, forge, and test use the tools-only path.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("Tools page customization", () => {
  const source = read("src/routes/tools.tsx");

  it("keeps capability toggle and marketplace import", () => {
    expect(source).toContain('useCapabilities("tools")');
    expect(source).toContain("CapabilityMarket");
    expect(source).toContain("CapabilityImport");
  });

  it("imports tools from zip, folder, and git clone, and forges on this page", () => {
    expect(source).toContain("installToolZip");
    expect(source).toContain("installToolFolder");
    expect(source).toContain("installToolGit");
    expect(source).toContain("Git clone");
    expect(source).toContain("forgeTool");
    expect(source).toContain("invokeToolPack");
    expect(source).toContain("Create tool");
    expect(source).toContain("Test selected");
    expect(source).not.toContain("installSkillZip");
  });
});
