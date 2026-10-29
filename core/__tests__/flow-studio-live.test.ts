/**
 * FRIDAY · live Flow Studio.
 *
 * Canvas edits, bindings, round trips, and the autonomy dial. No network,
 * no clock date, and no git history.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { actionNeedsApproval } from "../../src/lib/friday/brain/action-risk";
import { capabilityRegistry } from "../../src/lib/friday/brain/capability-registry";
import { optionalDiagramChecks } from "../../src/lib/friday/doctor-engine";
import {
  applyWire,
  bindingCoverage,
  makeReal,
  memoryHost,
  packInternals,
  productionHost,
  rollbackWire,
  type JournalEntry,
} from "../../src/lib/friday/flow-bind";
import {
  acceptImport,
  renderDot,
  roundTrip,
  validateGraphText,
} from "../../src/lib/friday/flow-codec";
import { flowLine } from "../../src/lib/friday/flow-copy";
import { canvasDo, canvasRedo, canvasState, canvasUndo } from "../../src/lib/friday/flow-edit";
import { layoutWithElk } from "../../src/lib/friday/flow-layout";
import { coverageGraph } from "../../src/lib/friday/flow-coverage";
import { importDot, importExternal, optionalExporterReady } from "../../src/lib/friday/flow-depth";
import {
  BINDING_KINDS,
  applyRunEvents,
  importMermaid,
  nodeOf,
  replayRun,
  simulateFlow,
  validateFlowGraph,
  type FlowBindingKind,
  type FlowGraph,
  type FlowGraphNode,
} from "../../src/lib/friday/flow-graph";
import { flowElements, wireMotion } from "../../src/lib/friday/flow-render";
import { chatTurnGraph, voiceAutoGraph } from "../../src/lib/friday/flow-modes";
import { flowStudio } from "../../src/lib/friday/flow-studio-store";
import {
  callFlowTool,
  configureFlowSession,
  readFlowIntent,
} from "../../src/lib/friday/flow-tools";
import { modelRegistry } from "../../src/lib/friday/model-registry";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";

const require_ = createRequire(import.meta.url);
const toolchain = require_("../../electron/toolchain.cjs") as {
  acceptPinnedFile: (
    file: string,
    tool: { sha256?: string; needBytes?: number },
    options?: { checkDisk?: boolean },
  ) => { ok: boolean; reason: string };
  fileSha256: (file: string) => string;
  TOOLS: { id: string; sha256?: string; installerUrl?: string }[];
};

function box(id: string, extra: Partial<FlowGraphNode> = {}): FlowGraphNode {
  return nodeOf({
    id,
    label: extra.label || id,
    kind: extra.kind || "tool",
    module: "src/lib/friday/flow-graph.ts",
    source: extra.source || { adapter: "manual", ref: id },
    ...extra,
  });
}

function chain(count: number): FlowGraph {
  const nodes = Array.from({ length: count }, (_, index) => box(`n${index}`));
  const edges = nodes.slice(1).map((node, index) => ({
    id: `e${index}`,
    source: nodes[index]!.id,
    target: node.id,
    kind: "control" as const,
  }));
  return {
    version: 1,
    id: "chain",
    title: "chain",
    trusted: true,
    enabled: true,
    nodes,
    edges,
    groups: [],
  };
}

describe("live canvas edits", () => {
  it("moves, connects, reconnects, deletes, inserts, groups, and undoes", () => {
    let state = canvasState(chain(2));
    state = canvasDo(state, { type: "move", ids: ["n0"], dx: 16, dy: 32 }).state;
    expect(state.placement.positions["n0"]).toMatchObject({ x: 16, y: 32 });
    state = canvasDo(state, { type: "resize", id: "n0", w: 200, h: 80 }).state;
    expect(state.placement.positions["n0"]).toMatchObject({ w: 200, h: 80 });
    state = canvasDo(state, { type: "connect", source: "n0", target: "n1", kind: "data" }).state;
    const added = state.graph.edges[state.graph.edges.length - 1]!;
    expect(added.kind).toBe("data");
    expect(added.binding?.kind).toBeTruthy();
    state = canvasDo(state, {
      type: "reconnect",
      edgeId: added.id,
      source: "n1",
      target: "n0",
    }).state;
    expect(state.graph.edges.find((edge) => edge.id === added.id)?.source).toBe("n1");
    state = canvasDo(state, {
      type: "waypoints",
      edgeId: added.id,
      points: [{ x: 8, y: 8 }],
    }).state;
    expect(state.placement.waypoints[added.id]).toEqual([{ x: 8, y: 8 }]);
    state = canvasDo(state, { type: "kind", edgeId: added.id, kind: "event", label: "ping" }).state;
    expect(state.graph.edges.find((edge) => edge.id === added.id)?.label).toBe("ping");
    const inserted = canvasDo(state, { type: "insert", edgeId: added.id, label: "Mid" });
    expect(inserted.state.graph.nodes.some((node) => node.label === "Mid")).toBe(true);
    state = inserted.state;
    state = canvasDo(state, {
      type: "group",
      id: "lane",
      title: "Lane",
      nodeIds: ["n0", "n1"],
    }).state;
    expect(state.graph.groups[0]?.title).toBe("Lane");
    state = canvasDo(state, { type: "collapse", groupId: "lane", collapsed: true }).state;
    expect(state.placement.collapsed).toContain("lane");
    state = canvasDo(state, { type: "duplicate", ids: ["n0"] }).state;
    expect(state.graph.nodes.length).toBeGreaterThan(3);
    const locked = canvasDo(canvasState(chain(1)), { type: "lock", id: "n0", locked: true });
    const refused = canvasDo(locked.state, { type: "move", ids: ["n0"], dx: 8, dy: 0 });
    expect(refused.issues.some((issue) => issue.code === "locked")).toBe(true);
    const undone = canvasUndo(state);
    expect(undone.future.length).toBe(1);
    expect(canvasRedo(undone).graph.nodes.length).toBe(state.graph.nodes.length);
    const tidy = canvasDo(canvasState(chain(3)), { type: "tidy", grid: 16 });
    expect(tidy.state.placement.positions["n1"]?.x).toBeGreaterThanOrEqual(0);
    const view = flowElements(state.graph, "", state.placement);
    expect(view.nodes.map((node) => node.id).sort()).toEqual(
      state.graph.nodes.map((node) => node.id).sort(),
    );
    const canvas = fs.readFileSync(
      path.join(process.cwd(), "src/components/friday/FlowCanvas.tsx"),
      "utf8",
    );
    expect(canvas).toContain("nodesDraggable");
    expect(canvas).not.toContain("nodesDraggable={false}");
    expect(canvas).toContain("deleteKeyCode");
    expect(canvas).not.toContain("dangerouslySetInnerHTML");
  });

  it("keeps a markup label as text", () => {
    const graph = chain(1);
    graph.nodes[0] = box("n0", { label: "<script>alert(1)</script>" });
    const view = flowElements(graph);
    expect(view.nodes[0]?.data.label).toBe("<script>alert(1)</script>");
    expect(view.nodes[0]?.ariaLabel.startsWith("<script>alert(1)</script>")).toBe(true);
  });
});

describe("wire bindings", () => {
  it("applies every real kind and rolls it back", () => {
    const host = memoryHost();
    let journal: JournalEntry[] = [];
    const realKinds = BINDING_KINDS.filter(
      (kind) => kind !== "descriptive" && kind !== "event" && kind !== "update",
    );
    realKinds.forEach((kind, index) => {
      const applied = applyWire({
        binding: { kind, ref: `ref.${kind}`, value: `v${index}`, real: true },
        risk: "write",
        level: "full",
        halted: false,
        host,
        actor: "owner",
        why: kind,
        at: index + 1,
        journal,
      });
      expect(applied.applied, kind).toBe(true);
      journal = applied.journal;
      expect(host.get(kind, `ref.${kind}`)).toBe(`v${index}`);
    });
    const descriptive = applyWire({
      binding: { kind: "descriptive", ref: "d", value: "x", real: false },
      risk: "write",
      level: "full",
      halted: false,
      host,
      actor: "owner",
      why: "describe",
      at: 50,
      journal,
    });
    expect(descriptive.applied).toBe(false);
    const asked = applyWire({
      binding: { kind: "setting", ref: "tone", value: "warm", real: true },
      risk: "write",
      level: "balanced",
      halted: false,
      host,
      actor: "owner",
      why: "ask",
      at: 51,
      journal,
    });
    expect(asked.needsApproval).toBe(true);
    expect(host.get("setting", "tone")).toBe("");
    const stopped = applyWire({
      binding: { kind: "workflow", ref: "w", value: "1", real: true },
      risk: "exec",
      level: "full",
      halted: true,
      host,
      actor: "friday",
      why: "stop",
      at: 52,
      journal,
    });
    expect(stopped.stopped).toBe(true);
    const data = applyWire({
      binding: { kind: "memory", ref: "m", value: "1", real: true },
      risk: "write",
      level: "full",
      halted: false,
      host,
      actor: "friday",
      why: "page",
      source: "data",
      at: 53,
      journal,
    });
    expect(data.reason).toContain("data");
    const last = realKinds[realKinds.length - 1] as FlowBindingKind;
    expect(host.get(last, `ref.${last}`)).not.toBe("");
    const rolled = rollbackWire(host, journal, 90);
    expect(rolled.restored).toBe(true);
    expect(host.get(last, `ref.${last}`)).toBe("");
    const forged = makeReal(
      { kind: "descriptive", ref: "pack", value: "step", real: false },
      { stage: "writing", ok: false },
    );
    expect(forged.applied).toBe(false);
    expect(makeReal(forged.binding, { stage: "done", ok: true }).binding.real).toBe(true);
    const internals = packInternals(
      { id: "skill.demo", kind: "skill", name: "Demo" },
      { steps: [{ id: "s", label: "Read" }] },
    );
    expect(validateFlowGraph(internals).some((issue) => issue.code === "unwired")).toBe(false);
    expect(internals.nodes.length).toBeGreaterThan(3);
  });

  it("writes a real router strategy and a real setting, then restores them", () => {
    const host = productionHost();
    const strategy = modelRegistry.getSnapshot().strategy;
    host.set("router", "strategy", "fallback");
    expect(modelRegistry.getSnapshot().strategy).toBe("fallback");
    host.set("router", "strategy", strategy);
    expect(modelRegistry.getSnapshot().strategy).toBe(strategy);
    const previous = preferences.getSnapshot().fields["flow-live-probe"] || "";
    host.set("setting", "flow-live-probe", "on");
    expect(preferences.getSnapshot().fields["flow-live-probe"]).toBe("on");
    host.set("setting", "flow-live-probe", previous);
  });
});

describe("flow code and tools", () => {
  it("round-trips a graph and keeps imports disabled until accepted", () => {
    const graph = chain(3);
    const trip = roundTrip(graph);
    expect(trip.same).toBe(true);
    expect(validateGraphText("{").ok).toBe(false);
    expect(
      validateGraphText(JSON.stringify({ version: 1, id: "a", title: "a", nodes: [], edges: [] }))
        .ok,
    ).toBe(true);
    const mermaid = importMermaid("flowchart LR\n  A[Read] --> B[Write]");
    expect(mermaid.graph.enabled).toBe(false);
    expect(mermaid.graph.nodes.length).toBeGreaterThan(0);
    expect(acceptImport(mermaid.graph).enabled).toBe(true);
    const dot = importDot('digraph friday {\n  "a" [label="Hello"];\n  "a" -> "b";\n}');
    expect(dot.graph.nodes.length).toBeGreaterThan(0);
    expect(dot.graph.enabled).toBe(false);
    const n8n = importExternal(
      "n8n",
      JSON.stringify({ nodes: [{ name: "Start", type: "n8n-nodes-base.manualTrigger" }] }),
    );
    expect(n8n.graph.nodes.length).toBeGreaterThan(0);
    expect(n8n.graph.enabled).toBe(false);
    expect(flowLine("legend", "hi")).toContain("Shape");
  });

  it("calls flow tools on the capability bus and refuses data", () => {
    const host = memoryHost();
    const graph = chain(2);
    graph.nodes[0] = box("n0", { source: { adapter: "workflow", ref: "wake" }, kind: "workflow" });
    graph.nodes[1] = box("n1", {
      source: { adapter: "workflow", ref: "speaker" },
      kind: "workflow",
    });
    configureFlowSession({ graph, host, level: "balanced", halted: false });
    expect(callFlowTool("flow.read", {}).ok).toBe(true);
    expect(callFlowTool("flow.search", { query: "n0" }).text).toContain("n0");
    const run = callFlowTool("flow.run", {});
    expect(run.text).toContain("Nothing was executed");
    expect(run.applied).toBe(false);
    const asked = callFlowTool("flow.patch", { sourceId: "n0", targetId: "n1", text: "rewire" });
    expect(asked.needsApproval).toBe(true);
    expect(host.store.size).toBe(0);
    configureFlowSession({ level: "full", halted: false });
    const applied = callFlowTool(
      "flow.patch",
      { sourceId: "n0", targetId: "n1", text: "rewire" },
      4,
    );
    expect(applied.applied).toBe(true);
    expect(callFlowTool("flow.rollback", {}, 5).text).toContain("Rolled back");
    configureFlowSession({ level: "full", halted: true });
    expect(callFlowTool("flow.run", {}).text).toBe("Stopped.");
    configureFlowSession({ halted: false, level: "balanced" });
    expect(callFlowTool("flow.read", { source: "data" }).text).toContain("data");
    expect(readFlowIntent("please rewire the pipeline", "data")?.message).toContain("data");
    expect(readFlowIntent("show work")?.message).toBeTruthy();
    const names = [
      "flow.read",
      "flow.search",
      "flow.patch",
      "flow.create",
      "flow.run",
      "flow.explain",
      "flow.diff",
      "flow.rollback",
    ];
    const snapshot = capabilityRegistry.refresh();
    for (const name of names) {
      expect(snapshot.resources.some((resource) => resource.ref === name)).toBe(true);
    }
    const replay = replayRun(graph, [{ generation: 1, nodeId: "n0", status: "ok", at: 1 }], 1);
    expect(replay.nodes.find((node) => node.id === "n0")?.status).toBe("ok");
    const log = simulateFlow(graph, {}, () => 1);
    expect(log.every((row) => row.status === "dry-run" || row.status === "blocked")).toBe(true);
    expect(log.every((row) => row.at === 1)).toBe(true);
  });
});

describe("live runs, retention, and layout", () => {
  it("drops a stale generation, batches notes, and deletes the recording", () => {
    const graph = chain(2);
    const painted = applyRunEvents(
      graph,
      [
        { generation: 1, nodeId: "n0", status: "ok", at: 1 },
        { generation: 2, nodeId: "n1", status: "failed", at: 2, detail: "timeout" },
      ],
      1,
    );
    expect(painted.ignored).toBe(1);
    expect(painted.graph.nodes.find((node) => node.id === "n1")?.status).not.toBe("failed");
    flowStudio.clearEvents();
    flowStudio.setRetention(20);
    flowStudio.noteMany(
      "run-live",
      Array.from({ length: 25 }, (_, index) => ({
        nodeId: "n0",
        status: "ok" as const,
        detail: `s${index}`,
      })),
      1,
    );
    expect(flowStudio.getSnapshot().events.length).toBe(20);
    flowStudio.clearEvents();
    expect(flowStudio.getSnapshot().events.length).toBe(0);
    expect(flowStudio.retention()).toBe(20);
    flowStudio.setRetention(200);
  });

  it("lays out with the real engine and a fake clock", async () => {
    let tick = 10;
    const small = await layoutWithElk(chain(12), () => tick++);
    expect(small.engine).toBe("elk");
    expect(small.positions).toHaveLength(12);
    expect(small.ms).toBeGreaterThan(0);
    const started = performance.now();
    const wide = await layoutWithElk(chain(1000));
    const elapsed = performance.now() - started;
    expect(wide.engine).toBe("elk");
    expect(wide.positions).toHaveLength(1000);
    expect(wide.ms).toBeGreaterThan(0);
    expect(wide.ms).toBeLessThan(30_000);
    expect(elapsed).toBeLessThan(30_000);
    const numbers = bindingCoverage(coverageGraph());
    expect(numbers.total).toBe(numbers.real + numbers.descriptive);
    expect(numbers.total).toBeGreaterThan(0);
    for (const graph of [
      coverageGraph(),
      voiceAutoGraph({ voiceState: "OFF" }),
      chatTurnGraph({}),
    ]) {
      for (const edge of graph.edges) {
        expect(edge.binding, edge.id).toBeTruthy();
        if (edge.binding?.real) {
          expect(edge.binding.bindable).not.toBe(false);
          continue;
        }
        expect(edge.binding?.bindable).toBe(false);
        expect((edge.binding?.reason || "").length).toBeGreaterThan(8);
      }
    }
    expect(
      wireMotion({ source: "a", target: "b" }, [
        { generation: 1, nodeId: "a", status: "running", at: 1 },
      ]),
    ).toEqual({ active: true, label: "—" });
    expect(
      wireMotion({ source: "a", target: "b" }, [
        { generation: 1, nodeId: "b", status: "running", at: 1, transferred: 0 },
      ]),
    ).toEqual({ active: true, label: "0" });
    expect(
      wireMotion({ source: "a", target: "b" }, [
        { generation: 1, nodeId: "a", status: "ok", at: 1, transferred: 3 },
      ]),
    ).toEqual({ active: false, label: "" });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "friday-flow-live-"));
    fs.writeFileSync(
      path.join(scratch, "flow-live-numbers.json"),
      JSON.stringify({ ...numbers, elkMs: wide.ms, elapsed }),
    );
  }, 60_000);
});

describe("optional diagram compilers", () => {
  it("keeps core drawing working when the compilers are absent", () => {
    expect(optionalExporterReady("d2").installed).toBe(false);
    expect(optionalExporterReady("graphviz").installed).toBe(false);
    expect(importDot('digraph { "a" [label="Hi"]; }').graph.enabled).toBe(false);
    const checks = optionalDiagramChecks();
    expect(checks.map((check) => check.id)).toEqual(["diagram:graphviz", "diagram:d2"]);
    expect(checks.every((check) => check.status === "Missing")).toBe(true);
    const graphviz = toolchain.TOOLS.find((tool) => tool.id === "Graphviz");
    const d2 = toolchain.TOOLS.find((tool) => tool.id === "D2");
    expect(graphviz?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(d2?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(graphviz?.installerUrl).toContain("graphviz-install-16.1.0-win64.exe");
    expect(d2?.installerUrl).toContain("d2-v0.9.0-windows-amd64.msi");
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "friday-flow-pin-")),
      "flow-pin-ok.bin",
    );
    fs.writeFileSync(file, "friday-pin");
    const hash = toolchain.fileSha256(file);
    expect(toolchain.acceptPinnedFile(file, { sha256: hash }, { checkDisk: false }).ok).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    const bad = toolchain.acceptPinnedFile(file, { sha256: "ab".repeat(32) }, { checkDisk: false });
    expect(bad.ok).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    const bundled = path.join(process.cwd(), "node_modules/elkjs/lib/elk.bundled.js");
    expect(fs.existsSync(bundled)).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "node_modules/@viz-js/viz/package.json"))).toBe(
      true,
    );
  });

  it("renders DOT with the bundled library and refuses a script", async () => {
    const drawn = await renderDot("digraph { a -> b; }");
    expect(drawn.ok).toBe(true);
    expect(drawn.svg).toContain("<svg");
    expect(drawn.svg.includes("<script")).toBe(false);
  });
});

describe("autonomy dial", () => {
  it("asks on Balanced, applies on Full, and stops on the kill switch", () => {
    autonomy.update({ approvalLevel: "balanced", halted: false });
    expect(actionNeedsApproval("exec", "auto")).toBe(true);
    expect(actionNeedsApproval("safe", "auto")).toBe(false);
    autonomy.update({ approvalLevel: "full", halted: false });
    expect(actionNeedsApproval("exec", "manual")).toBe(false);
    autonomy.stopEverything();
    expect(actionNeedsApproval("safe", "auto")).toBe(true);
    autonomy.update({ approvalLevel: "balanced", halted: false });
    expect(autonomy.getSnapshot().approvalLevel).toBe("balanced");
    expect(autonomy.getSnapshot().halted).toBe(false);
  });
});
