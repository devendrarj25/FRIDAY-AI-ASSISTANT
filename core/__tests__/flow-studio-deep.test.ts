/**
 * FRIDAY · Flow Studio depth.
 *
 * Coverage is generated from this checkout. Modes, exports, and the forge
 * stage machine do not call a host.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import { pdfPlainText } from "../../src/lib/friday/flow-pdf";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";
import { FLOW_PAGE_FEATURES } from "../../src/lib/friday/flow-adapters";
import { covered, coverageGraph, coverageNumbers } from "../../src/lib/friday/flow-coverage";
import { FLOW_REGISTRY } from "../../src/lib/friday/flow-registry.gen";
import {
  applyOption,
  applyOverlay,
  askChart,
  batchEvents,
  CANVAS_MODES,
  commitDraft,
  compareRuns,
  companionSnapshot,
  decideEvolution,
  EVOLUTION_LEVELS,
  explainTour,
  exportD2,
  exportDot,
  exportJsonCanvas,
  exportLocalTrace,
  exportPdf,
  exportPng,
  forgeCustomStep,
  goldenWorkflows,
  importDot,
  importExternal,
  importFlowPack,
  instantiateTemplate,
  labReplay,
  lineageOf,
  optionalExporterReady,
  pinData,
  projectMode,
  proposeEvolution,
  proposeFinding,
  reconcileDisk,
  retainEvents,
  rollbackDraft,
  runFromHere,
  runGolden,
  scrubWithBreaks,
  semanticZoom,
  wiringDoctor,
} from "../../src/lib/friday/flow-depth";
import {
  createDraft,
  editDraft,
  FLOW_RETENTION_CAP,
  flowHash,
  layoutFlowGraph,
  nodeOf,
  replayRun,
  validateFlowGraph,
  type FlowGraph,
  type FlowRunEvent,
} from "../../src/lib/friday/flow-graph";
import { flowElements } from "../../src/lib/friday/flow-render";
import { flowStudio } from "../../src/lib/friday/flow-studio-store";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const { buildRegistry } = require("../../scripts/flow-registry.cjs") as {
  buildRegistry: () => typeof FLOW_REGISTRY;
};

const WORKFLOWS = [
  "auto-recover",
  "branch-cleanup",
  "health-weekly",
  "main-safety-recovery",
  "maintenance",
  "official-publish",
  "pr-validation",
  "release",
  "repository-control",
  "safe-merge",
  "security",
  "test-build",
];

function preferenceIds() {
  return [
    "theme",
    ...Object.keys(DEFAULT_PREFERENCES.toggles).map((key) => `toggles.${key}`),
    ...Object.keys(DEFAULT_PREFERENCES.fields).map((key) => `fields.${key}`),
    ...Object.keys(DEFAULT_PREFERENCES.voice).map((key) => `voice.${key}`),
  ].sort();
}

function pngChunk(png: Uint8Array, type: string): Uint8Array {
  let offset = 8;
  while (offset + 8 < png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0);
    const name = String.fromCharCode(...png.slice(offset + 4, offset + 8));
    if (name === type) return png.slice(offset + 8, offset + 8 + length);
    offset += 12 + length;
  }
  throw new Error(`missing ${type}`);
}

function sample(): FlowGraph {
  return {
    version: 1,
    id: "sample",
    title: "Sample",
    trusted: true,
    enabled: true,
    nodes: [
      nodeOf({
        id: "read",
        kind: "tool",
        label: "Read",
        risk: "safe",
        module: "src/lib/friday/flow-graph.ts",
        source: { adapter: "template", ref: "read" },
      }),
      nodeOf({
        id: "write",
        kind: "tool",
        label: "Write",
        risk: "write",
        module: "src/lib/friday/flow-graph.ts",
        source: { adapter: "template", ref: "write" },
      }),
      nodeOf({
        id: "run",
        kind: "tool",
        label: "Run",
        risk: "exec",
        module: "src/lib/friday/flow-graph.ts",
        source: { adapter: "template", ref: "run" },
      }),
    ],
    edges: [
      { id: "e1", source: "read", target: "write", kind: "data" },
      { id: "e2", source: "write", target: "run", kind: "control" },
    ],
    groups: [{ id: "g", title: "g", nodeIds: ["read", "write", "run"] }],
  };
}

describe("flow coverage registry", () => {
  it("matches a fresh scan and maps every route, option, channel, and workflow", () => {
    const fresh = buildRegistry();
    expect(fresh).toEqual(FLOW_REGISTRY);
    expect(fresh.missingRoutes).toEqual([]);
    expect(fresh.options).toEqual(preferenceIds());
    expect(fresh.workflows).toEqual(WORKFLOWS);
    expect(fresh.ipc.some((item) => item.channel === "app:version")).toBe(true);
    expect(fresh.kernel.some((item) => item.path === "/health" && item.method === "GET")).toBe(
      true,
    );
    expect(fresh.kernel.some((item) => item.path === "/bridge")).toBe(true);
    expect(fresh.structures.every((item) => item.present)).toBe(true);
    const graph = coverageGraph(fresh);
    expect(coverageNumbers(fresh).routes).toEqual({
      mapped: fresh.routes.length,
      total: fresh.routes.length,
    });
    for (const route of fresh.routes)
      expect(covered(graph, "route", route.path)?.module).toBe(route.file);
    for (const option of fresh.options) expect(covered(graph, "option", option)).toBeTruthy();
    for (const channel of fresh.ipc) expect(covered(graph, "ipc", channel.channel)).toBeTruthy();
    for (const endpoint of fresh.kernel) {
      expect(covered(graph, "kernel", `${endpoint.method} ${endpoint.path}`)).toBeTruthy();
    }
    for (const name of fresh.workflows) expect(covered(graph, "ci", name)).toBeTruthy();
    for (const item of fresh.capabilities)
      expect(covered(graph, "capability", item.id)).toBeTruthy();
    expect(Object.keys(FLOW_PAGE_FEATURES).sort()).toEqual(
      fresh.routes.map((item) => item.path).sort(),
    );
  });
});

describe("flow canvas depth", () => {
  it("keeps one node set across canvas modes and the list", () => {
    const graph = sample();
    for (const mode of CANVAS_MODES) {
      const projected = projectMode(graph, mode);
      expect(projected.nodes.map((node) => node.id)).toEqual(graph.nodes.map((node) => node.id));
      const view = flowElements(projected, "");
      expect(view.nodes.map((node) => node.id)).toEqual(projected.nodes.map((node) => node.id));
      expect(view.nodes.every((node) => node.ariaLabel.includes(node.data.status))).toBe(true);
    }
    const zoomed = semanticZoom(graph, "overview");
    expect(zoomed.nodes.length).toBe(1);
    const ports = semanticZoom(graph, "internals", "read");
    expect(ports.nodes.some((node) => node.source.adapter === "port")).toBe(true);
  });

  it("redacts pins, stops before a breakpoint, and does not execute a run-from-here", () => {
    const graph = sample();
    const host = vi.fn();
    expect(pinData("password is hunter2").redacted).toBe(true);
    expect(pinData("plain note").text).toBe("plain note");
    const events: FlowRunEvent[] = [
      { generation: 1, nodeId: "read", status: "ok", at: 1, detail: "password is hunter2" },
      { generation: 1, nodeId: "write", status: "ok", at: 2 },
      { generation: 1, nodeId: "run", status: "running", at: 3 },
    ];
    const stopped = scrubWithBreaks(graph, events, 1, ["run"]);
    expect(stopped.stoppedBefore).toBe("run");
    expect(stopped.graph.nodes.find((node) => node.id === "run")?.status).toBe("unknown");
    expect(stopped.graph.nodes.find((node) => node.id === "read")?.detail).toBe("SENSITIVE");
    expect(host).not.toHaveBeenCalled();
    const from = runFromHere(graph, "write");
    expect(from.dryRun).toBe(true);
    expect(from.executed).toBe(false);
    expect(from.needsApproval).toBe(true);
    expect(
      compareRuns(events, [{ generation: 1, nodeId: "read", status: "failed", at: 4 }]),
    ).toEqual([
      { nodeId: "read", left: "ok", right: "failed" },
      { nodeId: "write", left: "ok", right: "unknown" },
      { nodeId: "run", left: "running", right: "unknown" },
    ]);
    expect(lineageOf(graph, "run")).toEqual(["write", "read"]);
    expect(batchEvents(events, 2)).toHaveLength(2);
    expect(retainEvents(events, 1)).toHaveLength(1);
    expect(applyOverlay(graph, [], "cost").nodes[0]?.detail).toContain("cost unknown");
    expect(replayRun(graph, events, 1).nodes.find((node) => node.id === "read")?.detail).toBe(
      "SENSITIVE",
    );
  });

  it("rejects a lowered risk, a self-approving forge, and an untrusted pack", () => {
    const graph = sample();
    const lowered = applyOption(graph, "run", "risk", "safe");
    expect(
      lowered.issues.some((issue) => issue.code === "invariant" || issue.code === "locked"),
    ).toBe(true);
    expect(lowered.graph.nodes.find((node) => node.id === "run")?.risk).toBe("exec");
    const locked = applyOption(
      {
        ...graph,
        nodes: graph.nodes.map((node) => (node.id === "read" ? { ...node, locked: true } : node)),
      },
      "read",
      "label",
      "Changed",
    );
    expect(locked.issues.some((issue) => issue.code === "locked")).toBe(true);
    const secret = applyOption(graph, "read", "label", "api key sk-1234567890abcdef");
    expect(secret.issues.some((issue) => issue.code === "sensitive")).toBe(true);

    const calls = { verify: 0, approve: 0, install: 0 };
    const refused = forgeCustomStep("Custom", {
      plan: () => ({ ok: true, detail: "planned" }),
      code: () => ({ ok: true, detail: "coded", source: "return 1" }),
      verify: () => {
        calls.verify += 1;
        return { ok: true, detail: "verified" };
      },
      approve: () => {
        calls.approve += 1;
        return false;
      },
      install: () => {
        calls.install += 1;
        return { ok: true, detail: "installed" };
      },
    });
    expect(refused.stage).not.toBe("done");
    expect(refused.stoppedAt).toBe("approval");
    expect(calls.install).toBe(0);
    expect(refused.node).toBeNull();

    const done = forgeCustomStep("Custom", {
      plan: () => ({ ok: true, detail: "planned" }),
      code: () => ({ ok: true, detail: "coded", source: "return 1" }),
      verify: () => ({ ok: true, detail: "verified" }),
      approve: () => true,
      install: () => ({ ok: true, detail: "installed", id: "workflows/custom/custom" }),
    });
    expect(done.stage).toBe("done");
    expect(done.node?.enabled).toBe(false);
    expect(done.node?.status).toBe("disabled");

    const pack = JSON.stringify({ nodes: [{ id: "box", label: "Hello" }] });
    const imported = importFlowPack(pack, "00000000");
    expect(imported.graph.enabled).toBe(false);
    expect(imported.issues.some((issue) => issue.code === "checksum")).toBe(true);
    const accepted = importFlowPack(pack, flowHash(pack));
    expect(accepted.graph.enabled).toBe(false);
    expect(accepted.graph.trusted).toBe(false);
    expect(accepted.graph.nodes[0]?.status).toBe("disabled");
    const marked = {
      ...accepted.graph,
      nodes: accepted.graph.nodes.map((node) => ({ ...node, label: "<img onerror=alert(1)>" })),
    };
    expect(flowElements(marked).nodes[0]?.data.label).toContain("<img");
    expect(exportDot(marked)).not.toContain("<img");
    expect(exportDot(marked)).toContain("&lt;img");
  });

  it("exports text and a PNG without a second renderer, and leaves optional binaries uninstalled", async () => {
    const graph = sample();
    expect(exportD2(graph)).toContain("Read");
    expect(exportJsonCanvas(graph)).toContain('"type":"text"');
    const pdf = await exportPdf(graph);
    expect(new TextDecoder().decode(pdf.slice(0, 8))).toMatch(/^%PDF-1\./);
    expect(pdfPlainText(pdf)).toContain("Read");
    const png = exportPng(graph);
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const idat = pngChunk(png, "IDAT");
    expect(zlib.inflateSync(idat).length).toBeGreaterThan(10);
    const dot = importDot('digraph friday {\n  "a" [label="Hello"];\n  "a" -> "b";\n}');
    expect(dot.graph.enabled).toBe(false);
    const nasty = importDot('digraph { "a" [label="<script>alert(1)</script>"]; }');
    expect(nasty.graph.nodes).toEqual([]);
    const n8n = importExternal(
      "n8n",
      JSON.stringify({ nodes: [{ name: "Start", type: "n8n-nodes-base.manualTrigger" }] }),
    );
    expect(n8n.readOnly).toBe(true);
    expect(n8n.graph.enabled).toBe(false);
    expect(
      exportLocalTrace(
        [{ generation: 1, nodeId: "read", status: "ok", at: 1, detail: "password is hunter2" }],
        false,
      ),
    ).toBeNull();
    expect(
      exportLocalTrace(
        [{ generation: 1, nodeId: "read", status: "ok", at: 1, detail: "password is hunter2" }],
        true,
      ),
    ).toContain("SENSITIVE");
    expect(optionalExporterReady("graphviz").installed).toBe(false);
    expect(optionalExporterReady("d2").core).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@xyflow/react"]).toBeTruthy();
    for (const name of ["elkjs", "ajv", "@viz-js/viz", "@codemirror/view"]) {
      expect(pkg.dependencies[name]).toBeTruthy();
    }
    for (const name of [
      "mermaid",
      "cytoscape",
      "bpmn-js",
      "tldraw",
      "jointjs",
      "n8n",
      "monaco-editor",
    ]) {
      expect(pkg.dependencies[name]).toBeUndefined();
    }
  });

  it("runs golden workflows as a dry run and keeps evolution and the phone read-only", () => {
    const host = vi.fn();
    for (const graph of goldenWorkflows()) {
      const result = runGolden(graph, () => 1);
      expect(result.log.every((row) => row.at === 1)).toBe(true);
      expect(result.log.every((row) => row.status === "dry-run" || row.status === "blocked")).toBe(
        true,
      );
      expect(validateFlowGraph(graph).some((issue) => issue.code === "self-approve")).toBe(false);
    }
    const selfish = instantiateTemplate("approval-gate", { name: "Ship" });
    selfish.nodes = selfish.nodes.map((node) =>
      node.risk === "exec" ? { ...node, approvesSelf: true } : node,
    );
    expect(validateFlowGraph(selfish).some((issue) => issue.code === "self-approve")).toBe(true);
    expect(host).not.toHaveBeenCalled();

    const graph = sample();
    const proposal = proposeEvolution(graph, "E2");
    expect(proposal.applied).toBe(false);
    expect(proposal.labOnly).toBe(true);
    expect(graph.nodes).toHaveLength(3);
    expect(EVOLUTION_LEVELS).toContain("E2");
    const rejected = decideEvolution(graph, proposal.proposal, false);
    expect(rejected.applied).toBe(false);
    expect(rejected.graph.nodes).toHaveLength(3);
    const accepted = decideEvolution(graph, proposal.proposal, true);
    expect(accepted.applied).toBe(true);
    expect(accepted.rollback.nodes).toHaveLength(3);
    expect(labReplay(graph).executed).toBe(false);

    const phone = companionSnapshot(graph, { authenticated: false });
    expect(phone.mutations).toBe(false);
    expect(phone.readOnly).toBe(true);
    expect(phone.graph.nodes[0]?.id).toBe("companion.offline");
    expect(companionSnapshot(graph, { authenticated: true }).mutations).toBe(false);

    const finding = wiringDoctor({
      graph: {
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === "read" ? { ...node, status: "unwired" } : node,
        ),
      },
      routes: ["/missing"],
      features: {},
    })[0];
    expect(finding?.severity).toBe("red");
    const proposalSteps = proposeFinding(finding!);
    expect(proposalSteps.applied).toBe(false);
    expect(proposalSteps.steps.length).toBeGreaterThan(0);

    const draft = editDraft(createDraft(graph), applyOption(graph, "read", "label", "Seen").graph);
    expect(rollbackDraft(draft.draft).current.nodes[0]?.label).toBe("Read");
    const committed = commitDraft(draft.draft, false);
    expect(committed.applied).toBe(false);
    const disk = { ...graph, title: "From disk" };
    expect(reconcileDisk(createDraft(graph), disk).conflict).toBe(false);
    expect(reconcileDisk(draft.draft, disk).conflict).toBe(true);
    expect(askChart(graph, 'explain "missing-box"')).toContain("not on this chart");
    expect(explainTour(graph, "hindi")[0]).toContain("स्थिति");
  });

  it("lays out a thousand boxes and stores a redacted recording", () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `n${index}`);
    const nodes = ids.map((id) =>
      nodeOf({
        id,
        kind: "note",
        label: id,
        module: "src/lib/friday/flow-graph.ts",
        source: { adapter: "bench", ref: id },
      }),
    );
    const graph: FlowGraph = {
      version: 1,
      id: "bench",
      title: "bench",
      trusted: true,
      nodes,
      edges: [],
      groups: [{ id: "g", title: "g", nodeIds: ids }],
    };
    const clock = { t: 5 };
    const laid = layoutFlowGraph(graph, () => clock.t);
    expect(laid.ms).toBe(0);
    expect(laid.positions).toHaveLength(1000);
    const started = performance.now();
    layoutFlowGraph(graph, () => performance.now());
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);

    flowStudio.beginRun("deep-retention");
    flowStudio.note("deep-retention", "n0", "ok", "password is hunter2");
    expect(flowStudio.getSnapshot().events.at(-1)?.detail).toBe("SENSITIVE");
    expect(flowStudio.getSnapshot().events.length).toBeLessThanOrEqual(FLOW_RETENTION_CAP);
    flowStudio.clearEvents();
    expect(flowStudio.getSnapshot().events).toEqual([]);
  });
});
