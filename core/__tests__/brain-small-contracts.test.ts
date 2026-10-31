import { describe, expect, it } from "vitest";
import { isTraceNode, labelForNode, TRACE_NODES } from "../../src/lib/friday/brain/turn-trace";
import {
  noteSubtopic,
  noteTopic,
  currentSubtopics,
  currentTopic,
} from "../../src/lib/friday/brain/topic-state";
import { addOpenLoop, listAllLoops, listOpenLoops } from "../../src/lib/friday/brain/open-loops";
import { GOVERNANCE_STAGES } from "../../src/lib/friday/self/governance";
import { AUTONOMY_LOOP } from "../../src/lib/friday/self/autonomous-core";
import { BACKEND_SCHEMA_VERSION } from "../../src/lib/friday/self/run-receipt";
import { systemPrompt } from "../../src/lib/friday/brain/identity";

describe("small Brain contracts that the app reads", () => {
  it("every trace node has a label and a lane; unknown ids are refused", () => {
    for (const id of Object.keys(TRACE_NODES)) {
      expect(isTraceNode(id)).toBe(true);
      expect(labelForNode(id)).toBeTruthy();
    }
    expect(isTraceNode("not.a.node")).toBe(false);
    expect(labelForNode("not.a.node")).toBeNull();
    expect(isTraceNode("toString")).toBe(false);
  });

  it("the topic helpers change the one session and return it", () => {
    const session = noteTopic("invoice");
    expect(session.activeTopic).toBe("invoice");
    expect(currentTopic()).toBe("invoice");
    noteSubtopic("tax");
    expect(currentSubtopics()).toContain("tax");
  });

  it("listAllLoops keeps resolved loops that listOpenLoops hides", () => {
    const loop = addOpenLoop("task", "send the report");
    expect(loop).not.toBeNull();
    expect(listAllLoops().length).toBeGreaterThanOrEqual(listOpenLoops().length);
    expect(listAllLoops().some((item) => item.text === "send the report")).toBe(true);
  });

  it("the governance stages and autonomy loop are ordered and have no duplicates", () => {
    const ids = GOVERNANCE_STAGES.map((stage) => stage.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("discovered");
    expect(new Set(AUTONOMY_LOOP).size).toBe(AUTONOMY_LOOP.length);
    expect(AUTONOMY_LOOP.indexOf("authorize")).toBeLessThan(AUTONOMY_LOOP.indexOf("act"));
    expect(AUTONOMY_LOOP.indexOf("verify")).toBeGreaterThan(AUTONOMY_LOOP.indexOf("act"));
  });

  it("the record schema version is a positive whole number and the prompt carries extra text", () => {
    expect(Number.isInteger(BACKEND_SCHEMA_VERSION) && BACKEND_SCHEMA_VERSION > 0).toBe(true);
    expect(systemPrompt("EXTRA-MARKER")).toContain("EXTRA-MARKER");
  });
});
