import { describe, expect, it } from "vitest";
import {
  candidateWorkflows,
  chooseWorkflows,
  lastWorkflowScoredCount,
  resetWorkflowIndex,
  scoreWorkflow,
  setWorkflowRouteHost,
  wantsParallelWorkflows,
} from "../../src/lib/friday/brain/workflow-router";
import type { WorkflowPackManifest } from "../../src/lib/friday/brain/workflow-forge";

const pack = (
  id: string,
  name: string,
  description: string,
  extra: Partial<WorkflowPackManifest> = {},
): WorkflowPackManifest => ({
  id,
  name,
  description,
  category: "office",
  schedule: "on demand",
  steps: [
    { id: "s1", label: "Inspect", kind: "note", ref: "inspect", risk: "safe" },
    { id: "s2", label: "Record", kind: "note", ref: "record", risk: "safe" },
    { id: "s3", label: "Wrap", kind: "note", ref: "wrap", risk: "safe" },
  ],
  risk: "safe",
  enabled: true,
  ...extra,
});

describe("workflow router", () => {
  it("indexes by token and does not score the whole catalog on a miss", () => {
    resetWorkflowIndex();
    const catalog = [
      pack("workflows/saved/morning-briefing", "Morning briefing chain", "ICS and disk snapshot"),
      pack("workflows/saved/workspace-cleanup", "Workspace cleanup chain", "Empty folders"),
    ];
    const hits = candidateWorkflows("please run morning-briefing", catalog);
    expect(hits.map((item) => item.id)).toContain("workflows/saved/morning-briefing");
    expect(candidateWorkflows("please chat about the weather", catalog)).toEqual([]);
    expect(lastWorkflowScoredCount()).toBe(0);
  });

  it("picks one named enabled+safe workflow and skips disabled or write packs", () => {
    resetWorkflowIndex();
    const catalog = [
      pack("workflows/saved/morning-briefing", "Morning briefing chain", "ICS digest"),
      pack("workflows/saved/workspace-cleanup", "Workspace cleanup chain", "Empty folders", {
        risk: "write",
      }),
      pack("workflows/saved/self-health", "Self-health inspect chain", "Uptime snapshot", {
        enabled: false,
      }),
    ];
    expect(scoreWorkflow("run morning-briefing", catalog[0]!)).toBe(1);
    const chosen = chooseWorkflows("run morning-briefing then workspace-cleanup", catalog);
    expect(chosen.map((item) => item.id)).toEqual(["workflows/saved/morning-briefing"]);
  });

  it("runs two named safe packs one after one in prompt order", () => {
    resetWorkflowIndex();
    const catalog = [
      pack("workflows/saved/morning-briefing", "Morning briefing chain", "ICS digest"),
      pack("workflows/saved/workspace-cleanup", "Workspace cleanup chain", "Empty folders"),
    ];
    const chosen = chooseWorkflows("run morning-briefing then workspace-cleanup", catalog);
    expect(chosen.map((item) => item.id)).toEqual([
      "workflows/saved/morning-briefing",
      "workflows/saved/workspace-cleanup",
    ]);
    const reversed = chooseWorkflows("run workspace-cleanup then morning-briefing", catalog);
    expect(reversed.map((item) => item.id)).toEqual([
      "workflows/saved/workspace-cleanup",
      "workflows/saved/morning-briefing",
    ]);
  });

  it("runs named packs at once when the prompt asks for parallel", () => {
    resetWorkflowIndex();
    const catalog = [
      pack("workflows/saved/morning-briefing", "Morning briefing chain", "ICS digest"),
      pack("workflows/saved/self-health", "Self-health inspect chain", "Uptime snapshot"),
    ];
    expect(wantsParallelWorkflows("run morning-briefing and self-health at once")).toBe(true);
    const chosen = chooseWorkflows("run morning-briefing and self-health at once", catalog);
    expect(chosen.map((item) => item.id).sort()).toEqual([
      "workflows/saved/morning-briefing",
      "workflows/saved/self-health",
    ]);
  });

  it("does not score the whole 116-pack catalog on a miss", () => {
    resetWorkflowIndex();
    const catalog = Array.from({ length: 116 }, (_, i) =>
      pack(`workflows/saved/noise-${i}`, `Noise pack ${i}`, `Garden watering interval ${i}`),
    );
    catalog[0] = pack("workflows/saved/morning-briefing", "Morning briefing chain", "ICS digest");
    expect(chooseWorkflows("please chat about the weather", catalog)).toEqual([]);
    expect(lastWorkflowScoredCount()).toBe(0);
    const picked = chooseWorkflows("run morning-briefing", catalog);
    expect(picked[0]?.id).toBe("workflows/saved/morning-briefing");
    expect(lastWorkflowScoredCount()).toBeLessThan(20);
  });
});

describe("workflow router run order", () => {
  it("passes previous output into the next sequential pack and fans out in parallel", async () => {
    const { routeWorkflows } = await import("../../src/lib/friday/brain/workflow-router");
    const catalog = [
      pack("workflows/saved/morning-briefing", "Morning briefing chain", "ICS digest"),
      pack("workflows/saved/workspace-cleanup", "Workspace cleanup chain", "Empty folders"),
    ];
    const prompts: string[] = [];
    setWorkflowRouteHost({
      list: async () => catalog,
      run: async (id, prompt) => {
        prompts.push(`${id}::${prompt.includes("Previous workflow output") ? "prev" : "first"}`);
        return {
          ok: true,
          id,
          name: id,
          steps: [{ id: "s1", label: "note", kind: "note", ref: "n", ok: true, detail: id }],
        };
      },
    });
    resetWorkflowIndex();
    const sequential = await routeWorkflows("run morning-briefing then workspace-cleanup");
    expect(sequential.map((run) => run.id)).toEqual([
      "workflows/saved/morning-briefing",
      "workflows/saved/workspace-cleanup",
    ]);
    expect(prompts[0]).toMatch(/first$/);
    expect(prompts[1]).toMatch(/prev$/);

    prompts.length = 0;
    resetWorkflowIndex();
    const parallel = await routeWorkflows("run morning-briefing and workspace-cleanup at once");
    expect(parallel).toHaveLength(2);
    expect(prompts.every((line) => line.endsWith("first"))).toBe(true);
    setWorkflowRouteHost(null);
  });
});
