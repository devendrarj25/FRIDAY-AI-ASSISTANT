/**
 * FRIDAY · pages do not import sample HUD rows.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapabilityGroups } from "../../src/lib/friday/capabilities";

const root = path.resolve(import.meta.dirname, "../..");

const pages = [
  "src/routes/agents.tsx",
  "src/routes/skills.tsx",
  "src/routes/plugins.tsx",
  "src/routes/workflows.tsx",
  "src/routes/system.tsx",
  "src/components/friday/settings/SecuritySettings.tsx",
  "src/components/friday/settings/BackupSettings.tsx",
  "src/components/friday/settings/AdvancedSettings.tsx",
  "src/lib/friday/capabilities.ts",
  "src/lib/friday/ops-engine.ts",
];

describe("sample HUD payloads stay out of the pages", () => {
  it("does not import hud.ts and the file is gone", () => {
    expect(fs.existsSync(path.join(root, "src/lib/friday/hud.ts"))).toBe(false);
    for (const file of pages) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      expect(text, file).not.toMatch(/from ["'][^"']*\/hud["']/);
      expect(text, file).not.toContain("ASUS ROG");
      expect(text, file).not.toContain("D:\\\\FRIDAY");
    }
  });

  it("leaves an empty workspace empty", () => {
    const groups = buildCapabilityGroups(null, {
      root: "",
      exists: false,
      valid: false,
      present: [],
      missing: [],
      scannedAt: 0,
      skills: [],
      plugins: [],
      agents: [],
      workflows: [],
      tools: [],
      modules: [],
    } as never);
    const names = groups.flatMap((group) => group.items.map((item) => item.name));
    expect(names).not.toContain("Code Gen");
    expect(names).not.toContain("Nightly");
    expect(groups.find((group) => group.kind === "agents")?.items ?? []).toEqual([]);
  });
});
