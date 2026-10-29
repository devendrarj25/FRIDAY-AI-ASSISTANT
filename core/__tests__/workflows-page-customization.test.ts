/**
 * Workflows page customization: catalog list (not ops-engine fake runs),
 * search/category, Details show the block flow diagram, Remove uses
 * uninstallPack, Forge/Test reuse workflow-forge.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("Workflows page customization", () => {
  const source = read("src/routes/workflows.tsx");

  it("reads live workflow packs, not ops.runWorkflow fake completions", () => {
    expect(source).toContain('useCapabilities("workflows")');
    expect(source).toContain("CapabilityMarket");
    expect(source).toContain("CapabilityImport");
    expect(source).not.toContain("ops.runWorkflow");
    expect(source).not.toContain("ops.addWorkflow");
    expect(source).not.toContain("useOps");
  });

  it("adds zip/folder/git through the shared importer", () => {
    expect(source).toContain('tree="workflows"');
  });

  it("wires uninstallPack after in-page confirm and refuses shipped app packs", () => {
    expect(source).toContain("uninstallPack");
    expect(source).toMatch(/Confirm remove/);
    expect(source).toContain("uninstallPack(row.id)");
    expect(source).toContain('row.origin === "app"');
    expect(source).toContain("Disable them instead of removing");
  });

  it("filters by live categories and searches name/category/schedule/steps", () => {
    expect(source).toContain("All categories");
    expect(source).toContain("row.category !== category");
    expect(source).toContain("Search name, category, schedule, or step");
  });

  it("shows a block flow diagram when Details is open", () => {
    const flow = read("src/components/friday/WorkflowFlow.tsx");
    expect(source).toContain("WorkflowFlow");
    expect(source).toContain("openRow.steps");
    expect(source).toContain("aria-label={`Test ${row.name}`}");
    expect(flow).toContain("workflow-flow");
    expect(flow).toContain("Block flow");
    expect(flow).toContain("How it works");
    expect(flow).toContain("START");
  });

  it("lets the owner visually create and edit a flow then Save", () => {
    expect(source).toContain("Edit flow");
    expect(source).toContain("New workflow");
    expect(source).toContain("saveWorkflowPack");
    expect(source).toContain("blankWorkflowDraft");
    expect(source).toContain("WorkflowEditor");
    expect(source).toContain("Visual Builder");
    expect(source).toContain("WorkflowVisualBuilder");
    const editor = read("src/components/friday/WorkflowFlow.tsx");
    expect(editor).toContain("Add step");
    expect(editor).toContain("Save");
    expect(editor).toContain("workflow-editor");
  });

  it("wires existing forgeWorkflow and runWorkflowPack Test selected", () => {
    expect(source).toContain("forgeWorkflow");
    expect(source).toContain("runWorkflowPack");
    expect(source).toContain("allowDisabled: true");
    expect(source).toContain("dryRun: true");
    expect(source).toContain("Create and test");
    expect(source).toContain("Test selected");
  });
});
