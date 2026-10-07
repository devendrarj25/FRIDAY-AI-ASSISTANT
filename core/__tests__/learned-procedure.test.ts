import { describe, expect, it } from "vitest";
import {
  encodeProcedure,
  parseProcedure,
  rememberProcedure,
  recallProcedure,
} from "../../src/lib/friday/self/learning-engine";
import { TaskGraphEngine } from "../../src/lib/friday/self/task-graph";

const GOAL =
  "Collect the September invoices then reconcile them against the bank export then write the summary";

describe("learned procedures", () => {
  it("round-trips a verified workflow without inventing extra steps", () => {
    const steps = [
      { title: "Collect invoices", instruction: "Collect the September invoices" },
      { title: "Reconcile", instruction: "reconcile them against the bank export" },
      { title: "Summary", instruction: "write the summary" },
    ];
    const parsed = parseProcedure(encodeProcedure(GOAL, steps));
    expect(parsed?.steps).toHaveLength(3);
    expect(parsed?.steps.map((step) => step.instruction)).toEqual(steps.map((s) => s.instruction));
  });

  it("recalls a stored procedure for a similar goal and ignores unrelated work", () => {
    rememberProcedure(
      GOAL,
      [
        { title: "Collect invoices", instruction: "Collect the September invoices" },
        { title: "Reconcile", instruction: "reconcile them against the bank export" },
        { title: "Summary", instruction: "write the summary" },
      ],
      "test",
    );
    const hit = recallProcedure(
      "Collect the September invoices then reconcile them against the bank export then write the summary again",
    );
    expect(hit?.steps.length).toBe(3);
    expect(recallProcedure("what is the time in Tokyo")).toBeNull();
  });

  it("reuses the learned steps on a later similar owner graph", async () => {
    const engine = new TaskGraphEngine();
    engine.registerRunner("goal", async ({ node }) => ({ result: `handled ${node.title}` }));
    const first = engine.submit(GOAL);
    const end = Date.now() + 800;
    while (Date.now() < end && engine.get(first.id)?.state !== "completed") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(engine.get(first.id)?.state).toBe("completed");

    const second = engine.submit(
      "Collect the September invoices then reconcile them against the bank export then write the summary for the archive",
    );
    const graph = engine.get(second.id)!;
    expect(graph.logs.some((line) => line.line.includes("reusing learned procedure"))).toBe(true);
    expect(graph.nodes.map((node) => node.instruction)).toEqual(
      engine.get(first.id)!.nodes.map((node) => node.instruction),
    );
    engine.cancel(second.id);
  });
});
