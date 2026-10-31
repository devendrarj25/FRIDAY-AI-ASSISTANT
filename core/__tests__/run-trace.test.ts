import { beforeEach, describe, expect, it } from "vitest";
import { buildRunTrace, safeRunId } from "../../src/lib/friday/brain/run-trace";
import { resetStageOutcomes, turnDone, turnMark } from "../../src/lib/friday/brain/turn-timing";

describe("run trace", () => {
  beforeEach(() => resetStageOutcomes());

  it("keeps stage names, timings and failures for one run and nothing else", () => {
    turnMark("run-a", "intent");
    turnDone("run-a", "intent", "secret prompt text here");
    turnMark("run-a", "recall");
    turnDone("run-a", "recall", "recall failed");
    turnMark("run-b", "intent");
    turnDone("run-b", "intent");
    const trace = buildRunTrace("run-a");
    expect(trace.runId).toBe("run-a");
    expect(trace.stages.map((row) => row.stage)).toEqual(["intent", "recall"]);
    expect(trace.failedStages).toBe(1);
    expect(JSON.stringify(trace)).not.toMatch(/secret prompt/);
    expect(trace.totalMs).toBe(trace.stages.reduce((sum, row) => sum + row.ms, 0));
  });

  it("only passes a run id the kernel will accept", () => {
    expect(safeRunId("run-1.a_b")).toBe("run-1.a_b");
    for (const bad of ["", "a b", "../x", "x".repeat(65), 5, null])
      expect(safeRunId(bad)).toBeNull();
  });
});
