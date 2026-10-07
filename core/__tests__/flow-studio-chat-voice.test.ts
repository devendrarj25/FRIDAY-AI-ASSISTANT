/**
 * FRIDAY · chat, voice, and diagram charts.
 *
 * Fixtures only. No network, no microphone, no clock date, and no git history.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TurnTraceStep } from "../../src/lib/friday/brain/turn-trace";
import { memoryHost, productionHost } from "../../src/lib/friday/flow-bind";
import { exportChecked, importChecked } from "../../src/lib/friday/flow-codec";
import {
  exportPdf,
  exportPng,
  importDrawio,
  importSvg,
  projectMode,
} from "../../src/lib/friday/flow-depth";
import { pdfPlainText } from "../../src/lib/friday/flow-pdf";
import {
  boxesFromPng,
  buildFromDiagram,
  encodeDiagramPng,
  graphFromBoxes,
  readAttachmentDiagrams,
  readDiagram,
  routeDiagramVision,
  type OcrBox,
} from "../../src/lib/friday/flow-diagram";
import {
  applyModeDraft,
  armChartOffer,
  chatTurnGraph,
  voiceAutoGraph,
  rememberRun,
} from "../../src/lib/friday/flow-modes";
import { exportSvg, nodeOf, type FlowGraph } from "../../src/lib/friday/flow-graph";
import { flowStudio } from "../../src/lib/friday/flow-studio-store";
import { readFlowIntent } from "../../src/lib/friday/flow-tools";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";

const root = path.resolve(import.meta.dirname, "../..");

function sample(): FlowGraph {
  return {
    version: 1,
    id: "sample",
    title: "Sample",
    trusted: true,
    enabled: true,
    nodes: [
      nodeOf({ id: "Read", label: "Read", kind: "note", module: "src/lib/friday/flow-graph.ts" }),
      nodeOf({ id: "Write", label: "Write", kind: "note", module: "src/lib/friday/flow-graph.ts" }),
    ],
    edges: [{ id: "e1", source: "Read", target: "Write", kind: "control" }],
    groups: [],
  };
}

function labelsOf(graph: FlowGraph): string[] {
  return graph.nodes.map((node) => node.label).sort();
}

const cleanBoxes: OcrBox[] = [
  { text: "Start", x: 10, y: 10, width: 40, height: 20, confidence: 0.95 },
  { text: "Middle", x: 10, y: 90, width: 40, height: 20, confidence: 0.91 },
  { text: "End", x: 12, y: 170, width: 40, height: 20, confidence: 0.88 },
];

const ambiguousBoxes: OcrBox[] = [
  { text: "Start", x: 10, y: 10, width: 40, height: 20, confidence: 0.95 },
  { text: "Left", x: 10, y: 100, width: 40, height: 20, confidence: 0.9 },
  { text: "Right", x: 30, y: 100, width: 40, height: 20, confidence: 0.4 },
];

describe("chat and voice charts", () => {
  it("builds a chat turn from a fixture trace and leaves missing stages unrecorded", () => {
    const steps: TurnTraceStep[] = [
      {
        id: "1",
        nodeId: "thinking.intent",
        label: "Command / intent",
        lane: "Thinking",
        state: "done",
        startedAt: 1,
        ms: 2,
        detail: "classified chat",
      },
      {
        id: "2",
        nodeId: "router.select",
        label: "Selection",
        lane: "Analysing",
        state: "done",
        startedAt: 3,
        ms: 4,
        detail: "local model after the firewall",
      },
      {
        id: "3",
        nodeId: "agents.tools",
        label: "Tool routing",
        lane: "Calculating",
        state: "failed",
        startedAt: 5,
        detail: "tool missing",
      },
    ];
    const graph = chatTurnGraph({
      steps,
      message: "hello",
      modelIds: ["local"],
      routing: "firewall allowed local",
    });
    expect(graph.id).toBe("chat-turn");
    expect(graph.nodes.find((node) => node.id === "chat.message")?.status).toBe("ok");
    expect(graph.nodes.find((node) => node.id === "chat.classify")?.detail).toContain(
      "classified chat",
    );
    expect(graph.nodes.find((node) => node.id === "chat.model")?.detail).toContain("local model");
    expect(graph.nodes.find((node) => node.id === "chat.model")?.detail).toContain("firewall");
    expect(graph.nodes.find((node) => node.id === "chat.tools")?.status).toBe("failed");
    expect(graph.nodes.find((node) => node.id === "chat.memory")?.detail).toContain("not recorded");
    expect(graph.nodes.find((node) => node.id === "chat.response")?.detail).toContain(
      "not recorded",
    );
    const empty = chatTurnGraph({});
    expect(empty.nodes.every((node) => node.detail.includes("not recorded"))).toBe(true);
  });

  it("keeps real voice transitions in state mode and does not mark a failed session as working", () => {
    const off = voiceAutoGraph({ voiceState: "OFF" });
    const projected = projectMode(off, "state");
    expect(
      projected.edges.some(
        (edge) => edge.source === "voice.OFF" && edge.target === "voice.STARTING",
      ),
    ).toBe(true);
    expect(off.nodes.find((node) => node.id === "voice.stt")?.detail).toContain("not recorded");
    expect(off.nodes.find((node) => node.id === "voice.vad")?.detail).toContain("not recorded");
    const failed = voiceAutoGraph({ voiceState: "ERROR", error: "mic failed" });
    expect(failed.nodes.find((node) => node.id === "voice.ERROR")?.status).toBe("failed");
    expect(failed.nodes.find((node) => node.id === "voice.LISTENING")?.status).not.toBe("ok");
    expect(failed.nodes.find((node) => node.id === "voice.LISTENING")?.status).not.toBe("running");
    const heard = voiceAutoGraph({
      voiceState: "LISTENING",
      stt: { engine: "faster-whisper", lastTranscript: "hello", lastError: null },
    });
    expect(heard.nodes.find((node) => node.id === "voice.stt")?.status).toBe("ok");
    expect(heard.nodes.find((node) => node.id === "voice.stt")?.detail).toContain("hello");
    const generic = projectMode(sample(), "state");
    expect(generic.edges[0]?.source).toBe("Read");
    expect(generic.edges[0]?.target).toBe("Write");
  });

  it("asks in Balanced and applies a chart value in Full", () => {
    const host = memoryHost();
    const graph = chatTurnGraph({ strategy: "pipeline" });
    const asked = applyModeDraft({
      graph,
      level: "balanced",
      halted: false,
      host,
      at: 1,
      journal: [],
    });
    expect(asked.needsApproval).toBe(true);
    expect(asked.applied).toBe(false);
    expect(host.get("router", "strategy")).toBe("");
    const applied = applyModeDraft({
      graph,
      level: "full",
      halted: false,
      host,
      at: 2,
      journal: [],
      approved: true,
    });
    expect(applied.applied).toBe(true);
    expect(host.get("router", "strategy")).toBe("pipeline");
    const before = preferences.getSnapshot().voice.wakeWord;
    const level = autonomy.getSnapshot().approvalLevel;
    const voice = voiceAutoGraph({
      voiceState: "OFF",
      wakeWord: "computer",
      approvalLevel: "strict",
    });
    applyModeDraft({
      graph: voice,
      level: "full",
      halted: false,
      host: productionHost(),
      at: 3,
      journal: [],
      approved: true,
    });
    expect(preferences.getSnapshot().voice.wakeWord).toBe("computer");
    expect(autonomy.getSnapshot().approvalLevel).toBe("strict");
    preferences.setVoice({ wakeWord: before });
    autonomy.update({ approvalLevel: level });
  });

  it("opens a recorded chart from a chat phrase and from a voice yes", () => {
    flowStudio.close();
    rememberRun(
      chatTurnGraph({
        steps: [
          {
            id: "1",
            nodeId: "thinking.intent",
            label: "Command / intent",
            lane: "Thinking",
            state: "done",
            startedAt: 1,
            detail: "classified chat",
          },
        ],
      }),
    );
    const asked = readFlowIntent("how did you do that");
    expect(flowStudio.getSnapshot().open).toBe(true);
    expect(flowStudio.getSnapshot().board?.id).toBe("chat-turn");
    expect(asked?.message).toContain("not recorded");
    expect(asked?.message).toContain("classified chat");
    const withContext = readFlowIntent("how did you do that\n(Context: the last greeting)");
    expect(flowStudio.getSnapshot().open).toBe(true);
    expect(withContext?.message).toContain("classified chat");
    const show = readFlowIntent("show me");
    expect(show?.message).toContain("classified chat");
    const hinglish = readFlowIntent("dikhao kaise");
    expect(hinglish?.message).toContain("status");
    armChartOffer(
      "voice",
      voiceAutoGraph({
        voiceState: "LISTENING",
        stt: { lastTranscript: "open the chart" },
      }),
    );
    const yes = readFlowIntent("yes");
    expect(flowStudio.getSnapshot().board?.id).toBe("voice-auto");
    expect(yes?.message).toContain("open the chart");
    expect(readFlowIntent("how did you do that", "data")?.message).toContain("data");
    const trace = fs.readFileSync(path.join(root, "src/components/friday/TurnTrace.tsx"), "utf8");
    const auto = fs.readFileSync(path.join(root, "src/components/friday/AutoMode.tsx"), "utf8");
    const dock = fs.readFileSync(path.join(root, "src/components/friday/ChatDock.tsx"), "utf8");
    expect(trace).toContain('aria-label="Show this turn as a flow chart"');
    expect(auto).toContain("Voice flow");
    expect(dock.match(/<TurnTrace /g)).toHaveLength(1);
    expect(dock).toContain("stripRunId");
    expect(dock).not.toContain("m.answeredBy");
    flowStudio.close();
  });
});

describe("diagram formats", () => {
  it("round-trips every text diagram format", async () => {
    const graph = sample();
    const formats = ["mermaid", "dot", "d2", "canvas", "json", "n8n", "node-red"] as const;
    for (const format of formats) {
      const once = importChecked(format, exportChecked(format, graph));
      expect(labelsOf(once.graph)).toEqual(["Read", "Write"]);
      expect(once.graph.edges.length).toBe(1);
      const twice = importChecked(format, exportChecked(format, once.graph));
      expect(labelsOf(twice.graph)).toEqual(["Read", "Write"]);
      expect(twice.graph.edges.length).toBe(1);
    }
    const drawio = importDrawio(
      `<mxfile><diagram><mxGraphModel><root><mxCell id="2" value="Start" vertex="1"/><mxCell id="3" value="End" vertex="1"/><mxCell id="4" edge="1" source="2" target="3"/></root></mxGraphModel></diagram></mxfile>`,
    );
    expect(labelsOf(drawio.graph)).toEqual(["End", "Start"]);
    expect(drawio.graph.edges.length).toBe(1);
    expect(drawio.graph.enabled).toBe(false);
    const svg = importSvg(
      `<svg><text x="10" y="20">Start</text><text x="10" y="80">End</text><line x1="10" y1="24" x2="10" y2="76"/></svg>`,
    );
    expect(labelsOf(svg.graph)).toEqual(["End", "Start"]);
    expect(svg.graph.edges.length).toBe(1);
    const picture = exportSvg(chatTurnGraph({ message: "hello" }));
    expect(picture).toContain("Message in");
    expect(pdfPlainText(await exportPdf(chatTurnGraph({ message: "hello" })))).toContain(
      "Message in",
    );
    expect(exportPng(voiceAutoGraph({ voiceState: "OFF" })).length).toBeGreaterThan(32);
  });

  it("extracts a clean stack and flags an ambiguous picture", () => {
    const clean = graphFromBoxes(cleanBoxes);
    expect(clean.graph.nodes).toHaveLength(3);
    expect(clean.graph.edges).toHaveLength(2);
    expect(clean.uncertain).toEqual([]);
    const ambiguous = graphFromBoxes(ambiguousBoxes);
    expect(ambiguous.graph.edges).toHaveLength(0);
    expect(ambiguous.uncertain.length).toBe(3);
    expect(ambiguous.graph.nodes.some((node) => node.detail.startsWith("uncertain"))).toBe(true);
    const encoded = encodeDiagramPng(cleanBoxes);
    expect(boxesFromPng(encoded)).toEqual(cleanBoxes);
    const dataUrl = `data:image/png;base64,${Buffer.from(encoded).toString("base64")}`;
    const read = readAttachmentDiagrams([
      { id: "1", name: "flow.png", kind: "image", mime: "image/png", dataUrl },
    ]);
    expect(read?.graph.nodes).toHaveLength(3);
    expect(read?.graph.edges).toHaveLength(2);
    expect(read?.route).toBe("local");
    const missed = readDiagram({
      name: "photo.png",
      mime: "image/png",
      sensitive: true,
      cloudAllowed: true,
      ownerOptIn: true,
    });
    expect(missed.route).toBe("local");
    expect(missed.explanation.toLowerCase()).toContain("not read");
    expect(missed.uncertain).toContain("diagram.unread");
  });

  it("keeps image content local unless the firewall and the setting both allow cloud", () => {
    expect(routeDiagramVision({ sensitive: false, cloudAllowed: false, ownerOptIn: false })).toBe(
      "local",
    );
    expect(routeDiagramVision({ sensitive: true, cloudAllowed: true, ownerOptIn: true })).toBe(
      "local",
    );
    expect(routeDiagramVision({ sensitive: false, cloudAllowed: true, ownerOptIn: false })).toBe(
      "local",
    );
    expect(routeDiagramVision({ sensitive: false, cloudAllowed: false, ownerOptIn: true })).toBe(
      "local",
    );
    expect(routeDiagramVision({ sensitive: false, cloudAllowed: true, ownerOptIn: true })).toBe(
      "cloud",
    );
    const cloud = readDiagram({
      name: "plain.png",
      mime: "image/png",
      sensitive: false,
      cloudAllowed: true,
      ownerOptIn: true,
    });
    expect(cloud.route).toBe("cloud");
    expect(cloud.explanation.toLowerCase()).toContain("did not call a provider");
  });

  it("does not mark a forge stage done when it did not run", async () => {
    const ambiguous = graphFromBoxes(ambiguousBoxes).graph;
    let calls = 0;
    const blocked = await buildFromDiagram(ambiguous, {
      forge: async () => {
        calls += 1;
        return { stage: "done", log: [] };
      },
    });
    expect(calls).toBe(0);
    expect(blocked.called).toBe(false);
    expect(blocked.stage).toBe("failed");
    expect(blocked.applied).toBe(false);
    const clean = graphFromBoxes(cleanBoxes).graph;
    const partial = await buildFromDiagram(clean, {
      forge: async () => ({
        stage: "writing",
        log: [{ text: "Planned the flow", ok: true }],
      }),
    });
    expect(partial.stage).not.toBe("done");
    expect(partial.applied).toBe(false);
    expect(partial.ran).toEqual(["plan"]);
    const incomplete = await buildFromDiagram(clean, {
      forge: async () => ({
        stage: "done",
        log: [
          { text: "Planned the flow", ok: true },
          { text: "Writing the step", ok: true },
        ],
      }),
    });
    expect(incomplete.stage).toBe("failed");
    expect(incomplete.applied).toBe(false);
    const done = await buildFromDiagram(clean, {
      forge: async () => ({
        stage: "done",
        log: [
          { text: "Planned the flow", ok: true },
          { text: "Writing the step", ok: true },
          { text: "Verifying in the sandbox", ok: true },
          { text: "Installed as workflows/demo", ok: true },
        ],
      }),
    });
    expect(done.stage).toBe("done");
    expect(done.applied).toBe(true);
    expect(done.ran).toEqual(["plan", "code", "verify", "install"]);
  });
});
