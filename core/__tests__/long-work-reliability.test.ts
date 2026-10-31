import { describe, expect, it } from "vitest";
import { compactHistory } from "../../src/lib/friday/brain/history-compact";
import {
  checkWithTools,
  claimedFiles,
  runnableBlocks,
  toolChecksFor,
  type ToolPort,
} from "../../src/lib/friday/brain/tool-checks";
import { runVerified } from "../../src/lib/friday/brain/verified-run";
import { earlierResults, TaskGraphEngine } from "../../src/lib/friday/self/task-graph";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("notes that survive a long task", () => {
  it("tell a retried step what already failed and where to continue", async () => {
    const engine = new TaskGraphEngine();
    const seen: Record<string, string[]> = {};
    let calls = 0;
    engine.registerRunner("goal", async ({ node, earlier }) => {
      if (node.title === "build") {
        calls += 1;
        seen[`build${calls}`] = earlier;
        if (calls === 1) throw new Error("socket hang up");
      }
      return { result: `done ${node.title}`, checked: true };
    });
    const { id } = engine.submit("fetch\n2. build\n3. report");
    const end = Date.now() + 4000;
    while (Date.now() < end && engine.get(id)?.state !== "completed") await sleep(5);
    expect(engine.get(id)?.state).toBe("completed");
    expect(seen["build1"]?.some((line) => line.startsWith("note:"))).toBe(false);
    expect(
      seen["build2"]?.some((line) =>
        /earlier attempt at this step failed \(socket hang up\)/.test(line),
      ),
    ).toBe(true);
    const graph = engine.get(id)!;
    expect(earlierResults(graph, graph.nodes[0]!).length).toBeLessThanOrEqual(10);
  });
});

describe("old turns shown to the model", () => {
  const long = "x".repeat(2000);
  const lines = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? ("friday" as const) : ("user" as const),
    text: i % 2 ? long : `question ${i}`,
  }));

  it("keeps recent turns whole and cuts only old long answers", () => {
    const out = compactHistory(lines, { keepRecent: 4, maxOld: 300 });
    expect(out).toHaveLength(12);
    expect(out[11]?.text).toBe(long);
    expect(out[1]?.text.length).toBeLessThan(500);
    expect(out[1]?.text).toMatch(/1700 more characters .* kept on this PC/);
    expect(out[0]?.text).toBe("question 0");
    expect(lines[1]?.text).toBe(long);
  });

  it("leaves short old answers and the sensitive flag alone", () => {
    const out = compactHistory(
      [{ role: "friday", text: "short", sensitive: true }, ...lines.slice(0, 6)],
      { keepRecent: 2 },
    );
    expect(out[0]).toEqual({ role: "friday", text: "short", sensitive: true });
  });
});

describe("checks that need a tool", () => {
  const port = (over: Partial<ToolPort> = {}): ToolPort => ({
    runCode: async (_l, code) => ({ ok: !code.includes("boom"), detail: "NameError: boom" }),
    fileInfo: async (p) => ({ exists: !p.includes("missing"), size: p.includes("empty") ? 0 : 10 }),
    ...over,
  });

  it("finds runnable code and claimed files", () => {
    expect(toolChecksFor("write a python script that sorts a list")).toEqual(["runnable-code"]);
    expect(toolChecksFor("what is the capital of France")).toEqual([]);
    expect(runnableBlocks("```python\nprint(1)\n```\n```bash\nls\n```")).toEqual([
      { language: "python", code: "print(1)" },
    ]);
    expect(claimedFiles("I saved the report to `out/report.docx` and created notes.txt")).toEqual([
      "out/report.docx",
      "notes.txt",
    ]);
    expect(claimedFiles("see https://example.com/a.html")).toEqual([]);
  });

  it("fails an answer whose code does not run or whose file is missing", async () => {
    const ask = "write a python script that prints hello";
    expect((await checkWithTools(ask, "```python\nprint('hi')\n```", port())).failures).toEqual([]);
    const bad = await checkWithTools(ask, "```python\nboom\n```", port());
    expect(bad.failures[0]?.message).toMatch(/python code block did not run: NameError/);
    expect((await checkWithTools(ask, "no code here", port())).failures[0]?.message).toMatch(
      /no code block/,
    );
    const files = await checkWithTools(
      "hi",
      "I saved it to missing.txt and wrote empty.txt",
      port(),
    );
    expect(files.failures.map((f) => f.message).join("|")).toMatch(
      /missing.txt, but that file is not there/,
    );
    expect(files.failures.map((f) => f.message).join("|")).toMatch(
      /empty.txt was made but is empty/,
    );
  });

  it("does nothing, and says what it skipped, without tools", async () => {
    const out = await checkWithTools("write a python script", "```python\nboom\n```", undefined);
    expect(out).toEqual({ checked: [], failures: [], skipped: ["runnable-code"] });
  });

  it("makes the verified loop retry until the code runs", async () => {
    let calls = 0;
    const result = await runVerified({
      prompt: "write a python script that prints hello",
      rungs: [{ id: "a", label: "a", modelIds: [] }],
      tools: port(),
      ask: async () => {
        calls += 1;
        return calls === 1 ? "```python\nboom\n```" : "```python\nprint('hello')\n```";
      },
    });
    expect(calls).toBe(2);
    expect(result.verified).toBe(true);
    expect(result.checked).toContain("runnable-code");
  });

  it("answers once, as before, when no tools are given", async () => {
    let calls = 0;
    const result = await runVerified({
      prompt: "write a python script that prints hello",
      rungs: [{ id: "a", label: "a", modelIds: [] }],
      ask: async () => {
        calls += 1;
        return "```python\nboom\n```";
      },
    });
    expect(calls).toBe(1);
    expect(result.verified).toBe(false);
  });
});

import { runHorizonLadder } from "../../src/lib/friday/self/eval-suites";

describe("the horizon ladder", () => {
  it("finishes chains of growing length and reports where the curve stops", async () => {
    const { report, curve } = await runHorizonLadder([3, 6, 12]);
    expect(curve).toEqual([
      { steps: 3, ok: true },
      { steps: 6, ok: true },
      { steps: 12, ok: true },
    ]);
    expect(report).toMatchObject({ suite: "horizon", tasks: 3, passed: 3, misses: [] });
    expect(report.extra["longest"]).toBe(12);
  });
});
