/**
 * Agents page customization: Enable uses the tools toggle() IPC, Remove uses
 * uninstallPack after an in-page confirm, filters and details read real
 * manifest fields, last-run comes from the task ledger.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("Agents page customization", () => {
  const source = read("src/routes/agents.tsx");

  it("wires the existing capability toggle and uninstall paths", () => {
    expect(source).toContain('useCapabilities("agents")');
    expect(source).toContain("toggle");
    expect(source).toContain("uninstallPack");
    expect(source).toContain('from "@/lib/friday/marketplace"');
    expect(source).toContain("aria-label={`Enable ${a.name}`}");
  });

  it("uses the tools toggle() path for enable/disable, not a second flag store", () => {
    expect(source).toContain("toggle(row.id, next)");
    expect(source).toContain('from "@/components/ui/switch"');
    expect(source).not.toContain("setSkillEnabled");
  });

  it("requires an in-page confirm before remove", () => {
    expect(source).toMatch(/Confirm remove/);
    expect(source).toContain("uninstallPack(row.id)");
  });

  it("filters by live manifest categories", () => {
    expect(source).toContain("All categories");
    expect(source).toContain("a.category !== category");
  });

  it("shows real manifest fields and a ledger last-run, never a canned success line", () => {
    expect(source).toContain("openRow.description");
    expect(source).toContain("openRow.risk");
    expect(source).toContain("openRow.permissions");
    expect(source).toContain("openRow.inputs");
    expect(source).toContain("openRow.approvalPrompt");
    expect(source).toContain("lastRunFrom");
    expect(source).toContain("tasksFor");
    expect(source).toContain("No ledger result stored.");
    expect(source).not.toMatch(/last ran successfully/i);
  });

  it("wires existing forgeAgent and plan/run Test selected, same HUD as Skills", () => {
    expect(source).toContain("forgeAgent");
    expect(source).toContain("planAgent");
    expect(source).toContain("runAgent");
    expect(source).toContain("Create and test");
    expect(source).toContain("Test selected");
    expect(source).toContain("allowDisabled: true");
    expect(source).toContain("dryRun: true");
  });

  it("refuses to uninstall shipped library packs", () => {
    expect(source).toContain('row.origin === "app"');
    expect(source).toContain("Disable them instead of removing");
  });
});
