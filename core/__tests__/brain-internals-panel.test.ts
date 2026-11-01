import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ledger from "../../config/brain-wiring-ledger.json";

const panel = readFileSync("src/components/friday/BrainInternalsPanel.tsx", "utf8");
const page = readFileSync("src/routes/self-management.tsx", "utf8");
const tasks = readFileSync("src/routes/tasks.tsx", "utf8");

describe("Brain internals are shown, not hidden", () => {
  it("the Self-management page mounts the panel", () => {
    expect(page).toContain("<BrainInternalsPanel />");
  });

  it("the panel reads every accessor the ledger used to list as unused", () => {
    for (const name of [
      "recentAgentGapDrafts",
      "recentModuleGapDrafts",
      "recentPluginGapDrafts",
      "recentWorkflowGapDrafts",
      "pluginForgeAvailable",
      "workflowForgeAvailable",
      "baselineAlreadyInstalled",
      "lastMark",
      "lastModuleScoredCount",
      "lastToolScoredCount",
      "lastSourceHealth",
      "routeSkill",
      "devBaseline",
      "listSource",
    ]) {
      expect(panel, name).toContain(name);
    }
  });

  it("the blocker box on My tasks goes through the horizon helper", () => {
    expect(tasks).toContain("noteHorizonBlocker(graph.id, reason)");
    expect(tasks).not.toContain("taskGraph.replanBlocked");
  });

  it("only the one honest seam is still pending in the ledger", () => {
    const keys = Object.keys(ledger.pending);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^brain\/module-router\.ts::/);
  });
});
