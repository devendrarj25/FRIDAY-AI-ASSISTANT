/**
 * Per-turn trace: FLOW_CHART node ids only, no invented checklist.
 */
import { describe, expect, it, afterEach } from "vitest";
import { FLOW_CHART, flowNodes } from "../../src/lib/friday/flow-chart";
import {
  TRACE_LANES,
  TRACE_NODES,
  appendTraceStep,
  lanesFromSteps,
  laneForNode,
  type TurnTraceStep,
} from "../../src/lib/friday/brain/turn-trace";
import { withDeadline } from "../../src/lib/friday/brain/turn-timing";
import { webSearch, WEB_SEARCH_DEADLINE_MS } from "../../src/lib/friday/browser-engine";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import { understand } from "../../src/lib/friday/brain/intent-engine";
import { resolveContext } from "../../src/lib/friday/brain/context-engine";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { considerCollaboration } from "../../src/lib/friday/brain/multi-model";
import { planPipeline } from "../../src/lib/friday/brain/orchestrator";
import { systemContextPrompt, readSystemContext } from "../../src/lib/friday/system-context";

describe("turn trace contract", () => {
  it("maps only real FLOW_CHART node ids with matching labels", () => {
    const nodes = flowNodes();
    for (const [id, meta] of Object.entries(TRACE_NODES)) {
      const chart = nodes.find((node) => node.id === id);
      expect(chart, id).toBeDefined();
      expect(chart!.label).toBe(meta.label);
      expect(TRACE_LANES).toContain(meta.lane);
    }
    expect(FLOW_CHART.some((layer) => layer.id === "thinking")).toBe(true);
  });

  it("never fills in lanes that did not run", () => {
    const steps: TurnTraceStep[] = [];
    appendTraceStep(steps, {
      id: "a",
      nodeId: "thinking.intent",
      detail: "chat (100%)",
      state: "done",
      ms: 2,
    });
    appendTraceStep(steps, {
      id: "b",
      nodeId: "thinking.understand",
      detail: "conversation",
      state: "done",
      ms: 1,
    });
    const lanes = lanesFromSteps(steps);
    expect(lanes.map((lane) => lane.lane)).toEqual(["Thinking"]);
    expect(lanes.some((lane) => lane.lane === "Searching")).toBe(false);
    expect(lanes.some((lane) => lane.lane === "Calculating")).toBe(false);
  });

  it("labels a real web-search detail as Searching, not a fake browser box", () => {
    expect(laneForNode("thinking.cognition", "web search: who is the current prime minister")).toBe(
      "Searching",
    );
    expect(laneForNode("thinking.cognition", "preparing the turn")).toBe("Analysing");
    expect(laneForNode("not-a-node", "anything")).toBeNull();
    const searchSteps: TurnTraceStep[] = [];
    appendTraceStep(searchSteps, {
      id: "s",
      nodeId: "thinking.cognition",
      detail: "web search: who is the current prime minister",
      state: "done",
      ms: 12,
    });
    expect(lanesFromSteps(searchSteps).map((lane) => lane.lane)).toEqual(["Searching"]);
  });

  it("drops unknown node ids instead of inventing a stage", () => {
    const steps: TurnTraceStep[] = [];
    expect(
      appendTraceStep(steps, { id: "x", nodeId: "invented.stage", detail: "nope" }),
    ).toBeNull();
    expect(steps).toHaveLength(0);
  });
});

describe("withDeadline", () => {
  afterEach(() => {
    const host = globalThis as unknown as { window?: unknown };
    delete host.window;
  });

  it("resolves the fallback when the work never finishes", async () => {
    const hanging = new Promise<string>(() => {
      /* never settles */
    });
    const started = Date.now();
    const result = await withDeadline(hanging, 40, "timeout");
    expect(result).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("returns the real value when it arrives in time", async () => {
    const result = await withDeadline(Promise.resolve("ok"), 200, "timeout");
    expect(result).toBe("ok");
  });

  it("does not block a turn for 140s when desktop web search never returns", async () => {
    const host = globalThis as unknown as {
      window?: { friday?: { webSearch: () => Promise<never> } };
    };
    host.window = { friday: { webSearch: () => new Promise(() => {}) } };
    const started = Date.now();
    const response = await webSearch("who is the current prime minister of India", 6);
    expect(Date.now() - started).toBeLessThan(WEB_SEARCH_DEADLINE_MS + 1500);
    expect(Date.now() - started).toBeGreaterThan(WEB_SEARCH_DEADLINE_MS - 500);
    expect(response.ok).toBe(false);
    expect(response.error ?? "").toMatch(/timed out/i);
  }, 20_000);
});

const HELLO = "hello";
const COMPLEX = "who is the current prime minister of India and what happened this week";

describe("pre-token stage timings (real, this process)", () => {
  it("times hello vs a live-facts prompt before any model token", async () => {
    const timeOne = async (prompt: string) => {
      let t0 = Date.now();
      resolveContext(prompt, []);
      const context = Date.now() - t0;
      t0 = Date.now();
      understand(prompt);
      const intent = Date.now() - t0;
      t0 = Date.now();
      const baseline = baselineRespond(prompt);
      const baselineMs = Date.now() - t0;
      const needsWeb = coreBrain.needsWeb(prompt) ? 1 : 0;
      t0 = Date.now();
      considerCollaboration(prompt, { enabled: true });
      const collaboration = Date.now() - t0;
      t0 = Date.now();
      planPipeline({ prompt });
      const planner = Date.now() - t0;
      t0 = Date.now();
      const cognition = await coreBrain.cognize(prompt, { mode: "manual" });
      return {
        prompt,
        context,
        intent,
        baseline: baselineMs,
        baselineHandled: baseline.handled ? 1 : 0,
        needsWeb,
        collaboration,
        planner,
        cognize: Date.now() - t0,
        webTools: cognition.tools.filter((tool) => tool.tool === "web-search").length,
        systemChars: cognition.system.length,
        notes: cognition.notes.join(" | "),
      };
    };

    const hello = await timeOne(HELLO);
    const complex = await timeOne(COMPLEX);

    console.info("[friday.turn.measure]", JSON.stringify({ hello, complex }, null, 2));

    expect(hello.baselineHandled).toBe(1);
    expect(hello.needsWeb).toBe(0);
    expect(hello.cognize).toBeLessThan(5_000);
    expect(complex.needsWeb).toBe(1);
    expect(complex.webTools).toBeGreaterThanOrEqual(0);
    expect(complex.cognize).toBeLessThan(30_000);
    expect(complex.baselineHandled).toBe(0);
    const stages: string[] = [];
    await coreBrain.cognize(COMPLEX, {
      mode: "manual",
      onStage: (nodeId, detail) => stages.push(`${nodeId}::${detail}`),
    });
    expect(stages.some((line) => /web search/i.test(line))).toBe(true);
    expect(stages.some((line) => line.startsWith("thinking.prepare"))).toBe(true);
  }, 15_000);
});

describe("system prompt vs kernel tools", () => {
  it("does not promise a browser search tool the kernel cannot run", () => {
    const prompt = systemContextPrompt({ ...readSystemContext(), online: true });
    expect(prompt.toLowerCase()).toContain("you do not have a web-search");
    expect(prompt.toLowerCase()).not.toContain("search the web with your browser tool");
  });
});
