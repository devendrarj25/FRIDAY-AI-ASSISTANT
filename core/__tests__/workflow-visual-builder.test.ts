/**
 * Visual Builder: React Flow canvas over existing workflow.json steps.
 * Saves still go through saveWorkflowPack → installPack(); write/exec stay gated.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

vi.mock("@xyflow/react/dist/style.css", () => ({}));

import {
  asWorkflowStep,
  catalogToStep,
  orderStepsFromGraph,
  packToDraft,
  sequentialEdges,
  stepsToFlow,
} from "../../src/routes/workflow-visual";
import {
  runWorkflowPack,
  saveWorkflowPack,
  type WorkflowForgeHost,
  type WorkflowPackWrite,
  type WorkflowStep,
} from "../../src/lib/friday/brain/workflow-forge";
import type { GovAction, GovItem } from "../../src/lib/friday/self/governance";

const require = createRequire(import.meta.url);
const capabilities = require("../../electron/capabilities.cjs") as {
  installPack: (
    roots: { workspaceRoot: string },
    pack: unknown,
    hint?: string,
  ) => { ok: boolean; id?: string; path?: string; error?: string };
};

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const morning = JSON.parse(read("workflows/saved/morning-briefing/workflow.json")) as {
  id: string;
  name: string;
  description: string;
  category: string;
  schedule: string;
  risk: string;
  steps: Array<{ id: string; label: string; kind: string; ref: string; risk: string }>;
};

async function autoApprove(action: GovAction): Promise<GovItem> {
  const result = await action.apply();
  return {
    id: "gov-test-workflow-visual",
    kind: action.kind,
    title: action.title,
    rationale: action.rationale,
    risk: action.risk,
    evidence: action.evidence ?? [],
    stage: result.ok ? "completed" : "failed",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    logs: [],
    ...(result.ok ? {} : { error: result.detail }),
  };
}

describe("Workflow Visual Builder wiring", () => {
  const page = read("src/routes/workflows.tsx");
  const visual = read("src/routes/workflow-visual.tsx");

  it("adds a Visual Builder tab on the existing Workflows page, not a sidebar item", () => {
    expect(page).toContain("Visual Builder");
    expect(page).toContain("WorkflowVisualBuilder");
    expect(page).toContain('key: "visual"');
    expect(page).toContain('pageView === "visual"');
    const nav = read("src/lib/friday/navigation.ts");
    expect(nav).not.toContain("/workflow-visual");
  });

  it("uses @xyflow/react and the existing saveWorkflowPack / installPack path", () => {
    expect(visual).toContain('from "@xyflow/react"');
    expect(visual).toContain("saveWorkflowPack");
    expect(visual).toContain("runWorkflowPack");
    expect(visual).toContain("listWorkflowStepCatalog");
    expect(visual).toContain("capabilityRegistry");
    expect(visual).toContain("StatusPill");
    expect(visual).not.toContain('from "../../core/workflow"');
    expect(visual).not.toContain('from "@/../core/workflow"');
    expect(visual).not.toContain("core/workflow");
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@xyflow/react"]).toBeTruthy();
    expect(pkg.dependencies["reactflow"]).toBeUndefined();
  });

  it("keeps write/exec behind the existing approval / dry-run gate", () => {
    expect(visual).toContain("write/exec steps still need owner approval");
    expect(visual).toContain("dryRun: true");
    expect(visual).toContain("saveWorkflowPack(draft");
  });
});

describe("steps[] graph mapping", () => {
  const steps: WorkflowStep[] = morning.steps.map(asWorkflowStep);

  it("turns a real installed pack's steps into kind-typed nodes and sequential edges", () => {
    const { nodes, edges } = stepsToFlow(steps);
    expect(nodes.map((node) => node.id)).toEqual(steps.map((step) => step.id));
    expect(nodes.map((node) => node.type)).toEqual(steps.map((step) => step.kind));
    expect(nodes[0]?.data.kind).toBe("agent");
    expect(nodes[5]?.data.kind).toBe("connector");
    expect(nodes[6]?.data.kind).toBe("skill");
    expect(nodes[7]?.data.kind).toBe("note");
    expect(edges).toHaveLength(steps.length - 1);
    expect(edges[0]).toMatchObject({ source: "s1", target: "s2" });
    expect(sequentialEdges(steps).map((edge) => `${edge.source}->${edge.target}`)).toEqual(
      edges.map((edge) => `${edge.source}->${edge.target}`),
    );
  });

  it("reorders by connection then leftover y-position, without inventing a new schema", () => {
    const reordered = orderStepsFromGraph(
      steps,
      steps.map((step, index) => ({ id: step.id, position: { x: 0, y: index * 10 } })),
      [
        { source: "s1", target: "s3" },
        { source: "s3", target: "s2" },
      ],
    );
    expect(reordered.map((step) => step.id).slice(0, 3)).toEqual(["s1", "s3", "s2"]);
    expect(reordered.map((step) => ({ kind: step.kind, ref: step.ref, risk: step.risk }))).toEqual(
      expect.arrayContaining(
        steps.map((step) => ({ kind: step.kind, ref: step.ref, risk: step.risk })),
      ),
    );
  });

  it("adds a catalog pick as a real WorkflowStep, including write risk from the catalog", () => {
    const added = catalogToStep(
      { kind: "tool", id: "tools/core/fs-write", name: "Write a local file", risk: "write" },
      steps.length,
    );
    expect(added).toEqual({
      id: `s${steps.length + 1}`,
      label: "Write a local file",
      kind: "tool",
      ref: "tools/core/fs-write",
      risk: "write",
    });
  });
});

describe("Visual Builder write-back", () => {
  it("saves an added step through installPack so runWorkflowPack can execute the manifest", async () => {
    const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friday-workflow-visual-"));
    const pack = packToDraft({
      id: "visual-morning-canvas",
      name: "Visual morning canvas",
      category: morning.category,
      schedule: morning.schedule,
      summary: morning.description,
      risk: morning.risk,
      origin: "workspace",
      steps: morning.steps,
    });
    const extra = catalogToStep(
      { kind: "note", id: "note", name: "Keep the digest local", risk: "safe" },
      pack.steps.length,
    );
    const { nodes } = stepsToFlow([...pack.steps, extra]);
    expect(nodes).toHaveLength(morning.steps.length + 1);
    expect(nodes.at(-1)?.type).toBe("note");
    pack.steps = [...pack.steps, extra];

    const host: Partial<WorkflowForgeHost> = {
      installPack: async (next: WorkflowPackWrite) =>
        capabilities.installPack({ workspaceRoot: ownerRoot }, next, "workflows"),
      sandboxVerify: async () => ({ ok: true, mode: "manifest" }),
      submit: autoApprove,
    };
    const saved = await saveWorkflowPack(pack, { host });
    expect(saved.stage).toBe("done");
    const file = path.join(
      ownerRoot,
      "workflows",
      "saved",
      "visual-morning-canvas",
      "workflow.json",
    );
    expect(fs.existsSync(file)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as {
      enabled: boolean;
      steps: WorkflowStep[];
    };
    expect(manifest.enabled).toBe(false);
    expect(manifest.steps).toHaveLength(morning.steps.length + 1);
    expect(manifest.steps.at(-1)?.kind).toBe("note");
    expect(manifest.steps.at(-1)?.label).toBe("Keep the digest local");

    const ran = await runWorkflowPack("workflows/saved/visual-morning-canvas", {
      allowDisabled: true,
      dryRun: true,
      host: {
        list: async () => [
          {
            id: "workflows/saved/visual-morning-canvas",
            name: pack.name,
            description: pack.description,
            category: pack.category,
            schedule: pack.schedule,
            steps: manifest.steps,
            risk: "safe",
            enabled: false,
          },
        ],
        invokeSkill: async () => ({ ok: true, value: "skill-ok" }),
        planAgent: async () => ({ ok: true, value: "planned" }),
        runAgent: async () => ({ ok: true, value: "ran" }),
        listConnectors: async () => [
          { id: "google-calendar", name: "Google Calendar", connected: true },
        ],
        connectorTools: () => [
          {
            tool: "connector.google-calendar.list",
            connectorId: "google-calendar",
            connectorName: "Google Calendar",
            connected: true,
            action: { id: "list", label: "List events", risk: "safe" as const, inputs: [] },
          },
        ],
        invokeConnector: async () => ({ ok: true, value: "calendar-ok" }),
      },
    });
    expect(ran.steps).toHaveLength(manifest.steps.length);
    expect(ran.steps.every((step) => step.ok)).toBe(true);
    fs.rmSync(ownerRoot, { recursive: true, force: true });
  });
});
