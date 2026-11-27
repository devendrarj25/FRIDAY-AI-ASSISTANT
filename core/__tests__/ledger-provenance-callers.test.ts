import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { experiences } from "../../src/lib/friday/self/task-ledger";
import { learning } from "../../src/lib/friday/self/learning-engine";
import {
  TurnProvenance,
  kindOfTool,
  kindsOfCognition,
  ownerVoiceOrigin,
  promptAuthorOf,
  systemTurnProvenance,
} from "../../src/lib/friday/self/turn-provenance";
import {
  TaskGraphEngine,
  graphProvenance,
  resetTaskGraphStore,
  type TaskGraph,
} from "../../src/lib/friday/self/task-graph";
import { completeTurn } from "../../src/lib/friday/runtime";
import { rowsFromExperiences, LEDGER_DATA_CLASS } from "../../src/lib/friday/learn-from-me";
import { selectTrainingRows, type PrivacyClassify } from "../../src/lib/friday/self/finetune";

const read = (path: string) => readFileSync(resolve(__dirname, "../..", path), "utf8");
const classify: PrivacyClassify = () => ({ level: "public" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const finishTurn = (taskId: string, prompt = "What is two plus two") =>
  completeTurn({
    taskId,
    mode: "manual",
    prompt,
    answer: "Four.",
    ok: true,
    ms: 40,
    modelIds: ["local-model"],
  });

/** The same ledger write, with the answering model known to be local (a bare id has no kind yet). */
const finishLocal = (taskId: string, prompt = "What is two plus two") =>
  learning.evaluate({
    taskId,
    kind: "manual-turn",
    title: prompt,
    success: true,
    verified: true,
    ms: 40,
    detail: "Four.",
    models: [{ id: "local-model", kind: "local" }],
  });

const rowOf = (taskId: string) =>
  experiences.getSnapshot().experiences.find((e) => e.taskId === taskId);

const trainable = async () =>
  (
    await selectTrainingRows(rowsFromExperiences(experiences.successes()), {
      classesAccepted: [LEDGER_DATA_CLASS],
      classify,
    })
  ).kept;

describe("the pure rules", () => {
  it("only a typed or owner-voice origin makes the owner the author", () => {
    expect(promptAuthorOf("typed")).toBe("owner");
    expect(promptAuthorOf("owner-voice")).toBe("owner");
    for (const bad of [undefined, null, "", "owner", "voice", "web", "tool", 1, {}]) {
      expect(promptAuthorOf(bad)).toBe("unknown");
    }
  });

  it("spoken-by-owner counts only when the ear tagged the speaker as the owner", () => {
    expect(ownerVoiceOrigin("owner")).toEqual({ promptOrigin: "owner-voice" });
    for (const speaker of ["other", "unknown", "", undefined, null, "OWNER"]) {
      expect(ownerVoiceOrigin(speaker)).toEqual({});
    }
  });

  it("each kind of outside content is named from the tool that brought it", () => {
    expect(kindOfTool("web_search")).toBe("web");
    expect(kindOfTool("fetch_url")).toBe("web");
    expect(kindOfTool("screen.read")).toBe("screen");
    expect(kindOfTool("mcp.notes.list")).toBe("mcp");
    expect(kindOfTool("read_file")).toBe("file");
    expect(kindOfTool("calendar.today")).toBe("tool");
    expect(kindOfTool(undefined)).toBe("tool");
  });

  it("a cognition that ran tools or cited sources is never clean", () => {
    expect(kindsOfCognition({ tools: [], sources: [] })).toEqual([]);
    expect(kindsOfCognition({ tools: [{ tool: "web-search" }] })).toEqual(["web"]);
    expect(kindsOfCognition({ tools: [{ tool: "connector" }, { tool: "skill" }] }).sort()).toEqual([
      "mcp",
      "tool",
    ]);
    expect(kindsOfCognition({ sources: [{ url: "https://example.org" }] })).toEqual(["web"]);
  });

  it("a task FRIDAY started herself is a tool turn", () => {
    expect(systemTurnProvenance()).toEqual({ promptAuthor: "tool", contextKinds: ["tool"] });
  });
});

describe("a chat turn reaches the ledger with its provenance", () => {
  beforeEach(() => experiences.clear());

  it("a turn the owner typed, with nothing else in the context, is a clean owner row the rails keep", async () => {
    const gate = new TurnProvenance();
    gate.begin("run-1", { origin: "typed" });
    gate.flush("run-1", "task-1");
    finishLocal("task-1");
    const row = rowOf("task-1")!;
    expect(row.promptAuthor).toBe("owner");
    expect(row.contextKinds).toEqual([]);
    expect(await trainable()).toHaveLength(1);
  });

  it("a turn with a web tool result is never owner-clean, even when the owner typed it", async () => {
    const gate = new TurnProvenance();
    gate.begin("run-2", { origin: "typed" });
    gate.add("run-2", kindOfTool("web_search"));
    gate.flush("run-2", "task-2");
    finishTurn("task-2", "Summarise the news");
    const row = rowOf("task-2")!;
    expect(row.promptAuthor).toBe("owner");
    expect(row.contextKinds).toEqual(["web"]);
    expect(await trainable()).toEqual([]);
  });

  it("screen text, app extras and a cognition's tools each keep the row out of training", async () => {
    const gate = new TurnProvenance();
    gate.begin("run-3", { origin: "typed", screen: true, extra: true });
    gate.flush("run-3", "task-3", kindsOfCognition({ tools: [{ tool: "connector" }] }));
    finishTurn("task-3");
    expect(rowOf("task-3")!.contextKinds).toEqual(["extra", "mcp", "screen"]);
    expect(await trainable()).toEqual([]);
  });

  it("a spoken turn from a voice that is not the owner stays unknown and never trains", async () => {
    const gate = new TurnProvenance();
    gate.begin("run-4", { origin: ownerVoiceOrigin("other").promptOrigin });
    gate.flush("run-4", "task-4");
    finishTurn("task-4");
    expect(rowOf("task-4")!.promptAuthor).toBe("unknown");
    expect(rowOf("task-4")!.contextKinds).toBeUndefined();
    expect(await trainable()).toEqual([]);
  });

  it("a spoken turn from the owner's own microphone path counts as the owner", async () => {
    const gate = new TurnProvenance();
    gate.begin("run-5", { origin: ownerVoiceOrigin("owner").promptOrigin });
    gate.flush("run-5", "task-5");
    finishLocal("task-5");
    expect(rowOf("task-5")!.promptAuthor).toBe("owner");
    expect(await trainable()).toHaveLength(1);
  });

  it("a turn nobody tagged stays unknown", async () => {
    new TurnProvenance().flush("run-6", "task-6");
    finishTurn("task-6");
    expect(rowOf("task-6")!.promptAuthor).toBe("unknown");
    expect(await trainable()).toEqual([]);
  });

  it("an origin that is not typed or owner-voice is ignored, so the author stays unknown", () => {
    const gate = new TurnProvenance();
    gate.begin("run-7", { origin: "owner" });
    gate.begin("run-7b", { origin: "web" });
    gate.flush("run-7", "task-7");
    gate.flush("run-7b", "task-7b");
    finishTurn("task-7");
    finishTurn("task-7b");
    expect(rowOf("task-7")!.promptAuthor).toBe("unknown");
    expect(rowOf("task-7b")!.promptAuthor).toBe("unknown");
  });

  it("outside content noted late can never be erased: the row keeps it", () => {
    const gate = new TurnProvenance();
    gate.begin("run-8", { origin: "typed" });
    gate.add("run-8", "file");
    gate.begin("run-8", { origin: "typed" });
    gate.flush("run-8", "task-8");
    finishTurn("task-8");
    expect(rowOf("task-8")!.contextKinds).toEqual(["file"]);
  });

  it("the provenance of one run never leaks into another task", () => {
    const gate = new TurnProvenance();
    gate.begin("run-9", { origin: "typed" });
    gate.flush("run-9", "task-9");
    gate.flush("run-9", "task-9-again");
    finishTurn("task-9");
    finishTurn("task-9-again");
    expect(rowOf("task-9")!.promptAuthor).toBe("owner");
    expect(rowOf("task-9-again")!.promptAuthor).toBe("unknown");
    expect(gate.size()).toBe(0);
  });

  it("the collector stays bounded", () => {
    const gate = new TurnProvenance();
    for (let i = 0; i < 500; i += 1) gate.begin(`run-${i}`, { origin: "typed" });
    expect(gate.size()).toBeLessThanOrEqual(200);
  });
});

describe("task graphs", () => {
  beforeEach(() => {
    experiences.clear();
    resetTaskGraphStore();
  });

  const settle = async (engine: TaskGraphEngine) => {
    const end = Date.now() + 600;
    while (Date.now() < end) {
      await sleep(5);
      if (!engine.list().some((g) => g.state === "running" || g.state === "queued")) return;
    }
  };

  const run = async (request: string, options: Parameters<TaskGraphEngine["submit"]>[1] = {}) => {
    const engine = new TaskGraphEngine();
    engine.registerRunner("goal", async ({ node }) => ({
      result: `did ${node.title}`,
      checked: true,
    }));
    const { id } = engine.submit(request, options);
    await settle(engine);
    return id;
  };

  it("a single-step graph the caller marked typed is an owner row", async () => {
    const id = await run("Rename the draft", { promptOrigin: "typed" });
    const row = rowOf(id)!;
    expect(row.promptAuthor).toBe("owner");
    expect(row.contextKinds).toEqual([]);
  });

  it("a graph with no origin stays unknown", async () => {
    const id = await run("Rename the draft");
    expect(rowOf(id)!.promptAuthor).toBe("unknown");
  });

  it("a graph whose steps feed each other is never clean", async () => {
    const id = await run("Collect the invoices\n2. add them up", { promptOrigin: "typed" });
    const row = rowOf(id)!;
    expect(row.promptAuthor).toBe("owner");
    expect(row.contextKinds).toContain("tool");
  });

  it("a desktop step reads the screen, so the graph carries a screen kind", () => {
    const graph = {
      promptOrigin: "typed",
      nodes: [{ kind: "desktop" }],
    } as unknown as TaskGraph;
    expect(graphProvenance(graph)).toEqual({ promptAuthor: "owner", contextKinds: ["screen"] });
  });

  it("a stored origin that was tampered with does not make the owner the author", () => {
    const forged = { promptOrigin: "owner", nodes: [{ kind: "goal" }] } as unknown as TaskGraph;
    expect(graphProvenance(forged)).toEqual({});
  });
});

describe("the other callers of the learning engine", () => {
  beforeEach(() => experiences.clear());

  it("a system task carries a tool author so it can never train", async () => {
    learning.evaluate({
      taskId: "repair-1",
      kind: "repair",
      title: "Kernel health",
      success: true,
      verified: true,
      ms: 5,
      ...systemTurnProvenance(),
    });
    expect(rowOf("repair-1")!.promptAuthor).toBe("tool");
    expect(await trainable()).toEqual([]);
  });

  it("every learning.evaluate call in self-manager passes the system provenance", () => {
    const source = read("src/lib/friday/self/self-manager.ts");
    const calls = source.split("learning.evaluate({").length - 1;
    const tagged = source.match(
      /learning\.evaluate\(\{\n\s+taskId: ctx\.id,\n\s+\.\.\.systemTurnProvenance\(\),/g,
    );
    expect(calls).toBe(7);
    expect(tagged).toHaveLength(calls);
  });
});

describe("the live wiring", () => {
  const engine = read("src/lib/friday/brain-engine.ts");

  it("brain-engine begins, extends and flushes the provenance of a run", () => {
    expect(engine).toContain("turnProvenance.begin(run.id, {");
    expect(engine).toContain("turnProvenance.add(run.id, kindOfTool(event.name));");
    expect(engine).toMatch(/turnProvenance\.flush\(\s*run\.id,/);
  });

  it("the flush uses the cognition's own task id and its tools on the core-brain path", () => {
    expect(engine).toContain("this.lastCognition.cognition.taskId : run.id");
    expect(engine).toContain("kindsOfCognition(this.lastCognition.cognition)");
  });

  it("the flush happens before the ledger row is written", () => {
    const flush = engine.indexOf("turnProvenance.flush(");
    const reflect = engine.indexOf("coreBrain.reflect({", flush);
    const legacy = engine.indexOf("completeTurn({", flush);
    expect(flush).toBeGreaterThan(0);
    expect(reflect).toBeGreaterThan(flush);
    expect(legacy).toBeGreaterThan(flush);
  });

  it("the chat box marks a turn typed only when the owner typed words", () => {
    const dock = read("src/components/friday/ChatDock.tsx");
    expect(dock).toContain('...(typed ? { promptOrigin: "typed" as const } : {})');
  });

  it("the voice send never claims the owner by itself: the conductor is untouched and the helper needs the speaker tag", () => {
    const voice = read("src/lib/friday/voice-engine/brain-bridge.ts");
    expect(voice).not.toContain("promptOrigin");
    expect(engine).not.toMatch(/promptOrigin:\s*"owner-voice"/);
  });

  it("the Brain page and the Tasks queue mark owner-typed text; app-composed senders stay unmarked", () => {
    expect(read("src/routes/brain.tsx")).toContain('brain.send(input, { promptOrigin: "typed" })');
    expect(read("src/routes/tasks.tsx")).toMatch(
      /taskGraph\.submit\([\s\S]{0,400}promptOrigin: "typed"/,
    );
    for (const file of ["src/lib/friday/self/ask-brain.ts", "src/lib/friday/character/link.ts"]) {
      expect(read(file)).not.toContain("promptOrigin");
    }
    for (const file of ["src/lib/friday/import-chat.ts", "src/lib/friday/hub-chat.ts"]) {
      expect(read(file)).toContain('promptOrigin: "typed"');
    }
  });
});
