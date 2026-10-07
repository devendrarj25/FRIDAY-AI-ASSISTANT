/**
 * FRIDAY · Flow Studio contracts.
 *
 * The graph is the model. React Flow is only a renderer. Old workflow packs
 * still run as a straight step list.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  applyRunEvents,
  createDraft,
  editDraft,
  exportMermaid,
  exportSvg,
  fromCode,
  importMermaid,
  layoutFlowGraph,
  migrateFlowDocument,
  simulateFlow,
  parseFlowCommand,
  redactFlowText,
  replayRun,
  riskTier,
  stepsToGraph,
  validateFlowGraph,
  nodeOf,
  type FlowGraph,
} from "../../src/lib/friday/flow-graph";
import {
  answerFlowCommand,
  featureForPath,
  graphForFeature,
  graphFromCapabilities,
  graphFromFlowChart,
  unresolvedNodes,
} from "../../src/lib/friday/flow-adapters";
import { flowElements } from "../../src/lib/friday/flow-render";
import {
  normalizeWorkflowSteps,
  runWorkflowPack,
  type WorkflowPackManifest,
  type WorkflowStep,
} from "../../src/lib/friday/brain/workflow-forge";
import { branchEdges, sequentialEdges } from "../../src/routes/workflow-visual";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

function chain(ids: string[]): FlowGraph {
  const nodes = ids.map((id, index) =>
    nodeOf({
      id,
      kind: "note",
      label: id,
      module: "src/lib/friday/flow-graph.ts",
      source: { adapter: "workflow", ref: id },
      ...(index === 0 ? {} : {}),
    }),
  );
  return {
    version: 1,
    id: "t",
    title: "t",
    trusted: true,
    nodes,
    edges: ids.slice(1).map((id, index) => ({
      id: `e${index}`,
      source: ids[index]!,
      target: id,
      kind: "control" as const,
    })),
    groups: [{ id: "g", title: "g", nodeIds: ids }],
  };
}

describe("flow graph model", () => {
  it("migrates a version-less step list and refuses a future schema", () => {
    const migrated = migrateFlowDocument({
      id: "old",
      name: "Old",
      steps: [{ id: "s1", label: "Look", kind: "note", ref: "look", risk: "safe" }],
    });
    expect(migrated.graph?.version).toBe(1);
    expect(migrated.graph?.nodes[0]?.label).toBe("Look");
    expect(migrateFlowDocument({ schemaVersion: 9, steps: [] }).graph).toBeNull();
    const yaml = fromCode(
      "version: 1\nid: y\ntitle: Y\ntrusted: true\nnodes: []\nedges: []\ngroups: []\n",
    );
    expect(yaml.graph?.id).toBe("y");
    expect(fromCode("{").issues[0]?.code).toBe("json");
  });

  it("resolves every master-chart box to a file in this tree", () => {
    const graph = graphFromFlowChart(exists);
    expect(graph.nodes.length).toBeGreaterThan(10);
    expect(unresolvedNodes(graph, exists)).toEqual([]);
    expect(graph.nodes.every((node) => node.status !== "unwired")).toBe(true);
    expect(graph.nodes.find((node) => node.id === "permission.billing")?.locked).toBe(true);
    const missing = graphFromFlowChart(() => false);
    expect(missing.nodes.every((node) => node.status === "unwired")).toBe(true);
  });

  it("keeps an unwired capability visible", () => {
    const graph = graphFromCapabilities("skills", [
      { id: "skills/custom/x", name: "X", kind: "skill", summary: "local" },
    ]);
    expect(graph.nodes[0]?.status).toBe("unwired");
    expect(graph.nodes[0]?.label).toBe("X");
  });

  it("rejects a cycle, a self-approving exec step, and a lowered risk", () => {
    const cyclic = chain(["a", "b"]);
    cyclic.edges.push({ id: "back", source: "b", target: "a", kind: "control" });
    expect(validateFlowGraph(cyclic).some((issue) => issue.code === "cycle")).toBe(true);

    const exec = chain(["run"]);
    exec.nodes[0] = { ...exec.nodes[0]!, risk: "exec", approvesSelf: true };
    expect(validateFlowGraph(exec).some((issue) => issue.code === "self-approve")).toBe(true);

    const before = chain(["write"]);
    before.nodes[0] = { ...before.nodes[0]!, risk: "exec", locked: true };
    const after = structuredClone(before);
    after.nodes[0] = { ...after.nodes[0]!, risk: "safe" };
    const edit = editDraft(createDraft(before), after);
    expect(edit.issues.some((issue) => issue.code === "invariant" || issue.code === "locked")).toBe(
      true,
    );
    expect(edit.draft.current.nodes[0]?.risk).toBe("exec");
  });

  it("drops a stale generation and replays without calling a host", () => {
    const graph = chain(["thinking.intent"]);
    const host = vi.fn();
    const applied = applyRunEvents(
      graph,
      [
        {
          generation: 1,
          nodeId: "thinking.intent",
          status: "running",
          at: 1,
          detail: "password is hunter2",
        },
        { generation: 2, nodeId: "thinking.intent", status: "ok", at: 2, detail: "old run" },
      ],
      1,
    );
    expect(applied.ignored).toBe(1);
    expect(applied.graph.nodes[0]?.status).toBe("running");
    expect(applied.graph.nodes[0]?.detail).toBe("SENSITIVE");
    const replayed = replayRun(
      graph,
      applied.graph.nodes[0]
        ? [{ generation: 1, nodeId: "thinking.intent", status: "ok", at: 3, detail: "done" }]
        : [],
      1,
    );
    expect(replayed.nodes[0]?.status).toBe("ok");
    expect(host).not.toHaveBeenCalled();
  });

  it("layouts 500 boxes with a fake clock and stays under 100ms on this machine", () => {
    const ids = Array.from({ length: 500 }, (_, index) => `n${index}`);
    const graph = stepsToGraph(
      ids.map((id) => ({ id, label: id, kind: "note", ref: id, risk: "safe" })),
      "big",
      "big",
    );
    let tick = 0;
    const clock = () => {
      tick += 1;
      return tick;
    };
    const laid = layoutFlowGraph(graph, clock);
    expect(laid.positions).toHaveLength(500);
    expect(laid.ms).toBe(1);
    const real = layoutFlowGraph(graph);
    expect(real.ms).toBeLessThan(100);
    expect(real.positions).toHaveLength(500);
  });

  it("treats Mermaid and labels as untrusted text", () => {
    const bad = importMermaid(
      'flowchart TD\n  A["<script>alert(1)</script>"] --> B\n  click A "javascript:alert(1)"',
    );
    expect(bad.issues.some((issue) => issue.code === "untrusted")).toBe(true);
    expect(bad.graph.enabled).toBe(false);
    expect(bad.graph.trusted).toBe(false);
    expect(bad.graph.nodes.every((node) => node.status === "disabled")).toBe(true);
    const clean = importMermaid("flowchart TD\n  A[Look] --> B[Save]");
    expect(clean.graph.enabled).toBe(false);
    expect(exportSvg(clean.graph)).not.toContain("<script");
    expect(
      exportSvg(stepsToGraph([{ id: "s1", label: "<script>x</script>", kind: "note" }], "i", "i")),
    ).toContain("&lt;script&gt;");
    expect(exportMermaid(clean.graph)).toContain("flowchart TD");
  });

  it("answers a flow question from the chart, including Hindi", () => {
    expect(parseFlowCommand("show me the voice flow").feature).toBe("voice");
    const english = answerFlowCommand("explain the voice flow", exists);
    expect(english.text.toLowerCase()).toContain("voice");
    expect(english.text).not.toContain("I think");
    const hindi = answerFlowCommand("आवाज flow kaise", exists);
    expect(hindi.text.length).toBeGreaterThan(10);
    expect(featureForPath("/doctor")).toBe("doctor");
    expect(riskTier(graphForFeature("models", exists))).toBe("safe");
  });

  it("simulates a branch with a fake clock and does not execute", () => {
    const graph = stepsToGraph(
      [
        { id: "s1", label: "One", kind: "note", ref: "one", risk: "safe" },
        {
          id: "s2",
          label: "Else",
          kind: "note",
          ref: "else",
          risk: "safe",
          when: "previous-failed",
        },
      ],
      "sim",
      "sim",
    );
    let tick = 10;
    const log = simulateFlow(graph, { s1: true }, () => {
      tick += 5;
      return tick;
    });
    expect(log.map((row) => row.status)).toEqual(["dry-run", "blocked"]);
    expect(log[0]?.at).toBe(15);
  });

  it("renders the same ids for the canvas and the list", () => {
    const graph = graphForFeature("voice", exists);
    const view = flowElements(graph);
    expect(view.nodes.map((node) => node.id).sort()).toEqual(
      graph.nodes.map((node) => node.id).sort(),
    );
    expect(
      view.nodes.every((node) => String(node.ariaLabel).includes(String(node.data.status))),
    ).toBe(true);
  });
});

describe("workflow schema 2 on the existing runner", () => {
  const manifest = (steps: WorkflowStep[]): WorkflowPackManifest => ({
    id: "flow-studio-pack",
    name: "Flow studio pack",
    description: "",
    category: "saved",
    schedule: "on demand",
    steps,
    risk: "safe",
    enabled: true,
  });

  it("still runs an old step list straight through", async () => {
    const steps = normalizeWorkflowSteps([
      { id: "s1", label: "One", kind: "note", ref: "one", risk: "safe" },
      { id: "s2", label: "Two", kind: "note", ref: "two", risk: "safe" },
    ]);
    expect(steps[0]?.when).toBeUndefined();
    const run = await runWorkflowPack("flow-studio-pack", {
      host: { list: async () => [manifest(steps)] },
    });
    expect(run.ok).toBe(true);
    expect(run.steps.map((step) => step.id)).toEqual(["s1", "s2"]);
  });

  it("skips the other branch, retries a bounded loop, and refuses a self-approving exec", async () => {
    const branched = normalizeWorkflowSteps([
      { id: "s1", label: "One", kind: "note", ref: "one", risk: "safe" },
      { id: "s2", label: "Else", kind: "note", ref: "else", risk: "safe", when: "previous-failed" },
    ]);
    const run = await runWorkflowPack("flow-studio-pack", {
      host: { list: async () => [manifest(branched)] },
    });
    expect(run.steps[1]?.skipped).toBe(true);
    expect(branchEdges(branched)[0]?.label).toBe("previous-failed");
    expect(sequentialEdges(branched)).toHaveLength(1);

    let calls = 0;
    const looped = normalizeWorkflowSteps([
      { id: "s1", label: "Try", kind: "skill", ref: "skills/custom/try", risk: "safe", loopMax: 3 },
    ]);
    const loopedRun = await runWorkflowPack("flow-studio-pack", {
      host: {
        list: async () => [manifest(looped)],
        invokeSkill: async () => {
          calls += 1;
          return calls < 2 ? { ok: false, error: "not yet" } : { ok: true, value: "done" };
        },
      },
    });
    expect(calls).toBe(2);
    expect(loopedRun.ok).toBe(true);

    const selfish = normalizeWorkflowSteps([
      {
        id: "s1",
        label: "Do",
        kind: "tool",
        ref: "tools/core/run",
        risk: "exec",
        approvesSelf: true,
      },
    ]);
    const refused = await runWorkflowPack("flow-studio-pack", {
      dryRun: false,
      host: {
        list: async () => [manifest(selfish)],
        invokeTool: async () => ({ ok: true, value: "ran" }),
      },
    });
    expect(refused.ok).toBe(false);
    expect(refused.steps[0]?.detail).toContain("cannot approve itself");
  });
});

describe("flow studio wiring", () => {
  it("opens from the shell and keeps the wiring list", async () => {
    const shell = read("src/components/friday/AppShell.tsx");
    const wiring = read("src/components/friday/WiringVisualizer.tsx");
    const brain = read("src/lib/friday/brain-engine.ts");
    expect(read("docs/FRIDAY_MASTER_FLOW.md")).toContain("Flow Studio");
    expect(read("docs/FRIDAY_USER_GUIDE.md")).toContain("How to watch, edit, and build flows");
    expect(shell).toContain("FlowStudioHost");
    expect(shell).toContain('flowStudio.open(featureForPath(pathname), "chart")');
    expect(shell).toContain("Flow");
    expect(wiring).toContain("locked");
    expect(brain).toContain("answerFlowCommand");
    await import("../../src/lib/friday/brain-engine");
    const adapters = await import("../../src/lib/friday/flow-adapters");
    expect(adapters.answerFlowCommand("show me the voice flow", exists).feature).toBe("voice");
    expect(brain).toContain("flowStudio.note");
    const schema = JSON.parse(read("src/lib/friday/flow-graph.schema.json")) as {
      required: string[];
    };
    expect(schema.required).toContain("version");
    expect(redactFlowText("api key sk-1234567890abcdef")).toBe("SENSITIVE");
  });
});
