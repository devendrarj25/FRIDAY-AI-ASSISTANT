import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { experiences, migrateExperience } from "../../src/lib/friday/self/task-ledger";
import { learning } from "../../src/lib/friday/self/learning-engine";
import {
  TurnProvenance,
  isLoopbackEndpoint,
  kindOfRecalled,
  kindsOfRecalled,
  modelKindOf,
  type RoutedModel,
} from "../../src/lib/friday/self/turn-provenance";
import { completeTurn } from "../../src/lib/friday/runtime";
import { LEDGER_DATA_CLASS, rowsFromExperiences } from "../../src/lib/friday/learn-from-me";
import { selectTrainingRows, type PrivacyClassify } from "../../src/lib/friday/self/finetune";

const read = (path: string) => readFileSync(resolve(__dirname, "../..", path), "utf8");
const classify: PrivacyClassify = () => ({ level: "public" });

const routed: RoutedModel[] = [
  { id: "ollama:qwen2.5:7b", kind: "local", endpoint: "http://127.0.0.1:11434" },
  { id: "lan:big", kind: "local", endpoint: "http://192.168.1.20:11434" },
  { id: "groq:llama-3.3-70b", providerModelId: "llama-3.3-70b", kind: "cloud" },
  { id: "weird:one", kind: "mystery" },
  { id: "gw:cloud-on-loopback", kind: "cloud", endpoint: "http://localhost:4000" },
];

const finishTurn = (taskId: string, modelIds: string[]) =>
  completeTurn({
    taskId,
    mode: "manual",
    prompt: "What is two plus two",
    answer: "Four.",
    ok: true,
    ms: 40,
    modelIds,
  });

const servedTurn = (taskId: string, served: string[], runId = `run-${taskId}`) => {
  const gate = new TurnProvenance();
  gate.begin(runId, { origin: "typed" });
  for (const id of served) gate.noteServed(runId, id);
  gate.flush(runId, taskId, [], (id) => modelKindOf(id, routed));
};

const rowOf = (taskId: string) =>
  experiences.getSnapshot().experiences.find((e) => e.taskId === taskId)!;

const kept = async () =>
  (
    await selectTrainingRows(rowsFromExperiences(experiences.successes()), {
      classesAccepted: [LEDGER_DATA_CLASS],
      classify,
    })
  ).kept;

describe("the served model's kind", () => {
  it("a loopback engine is local", () => {
    expect(modelKindOf("ollama:qwen2.5:7b", routed)).toBe("local");
    expect(isLoopbackEndpoint("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackEndpoint("localhost:11434")).toBe(true);
    expect(isLoopbackEndpoint("http://[::1]:9000")).toBe(true);
  });

  it("a remote host is never loopback, whatever its name says", () => {
    expect(isLoopbackEndpoint("https://localhost.evil.example")).toBe(false);
    expect(isLoopbackEndpoint("http://127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackEndpoint("")).toBe(false);
  });

  it("a hosted model is cloud, matched by its router id or its provider id", () => {
    expect(modelKindOf("groq:llama-3.3-70b", routed)).toBe("cloud");
    expect(modelKindOf("llama-3.3-70b", routed)).toBe("cloud");
  });

  it("a local row on a non-loopback host stays unknown, and a cloud row on loopback stays cloud", () => {
    expect(modelKindOf("lan:big", routed)).toBe("unknown");
    expect(modelKindOf("gw:cloud-on-loopback", routed)).toBe("cloud");
  });

  it("an id nobody knows, or a kind nobody defined, is unknown and never guessed", () => {
    expect(modelKindOf("nobody:nothing", routed)).toBe("unknown");
    expect(modelKindOf("weird:one", routed)).toBe("unknown");
    expect(modelKindOf(undefined, routed)).toBe("unknown");
    expect(modelKindOf("", routed)).toBe("unknown");
  });

  it("the catalog answers only when the router list has no row", () => {
    const catalog = (id: string) => (id === "qwen-local" ? "local" : undefined);
    expect(modelKindOf("qwen-local", [], catalog)).toBe("local");
    expect(modelKindOf("qwen-local", routed, catalog)).toBe("local");
    expect(modelKindOf("other", [], catalog)).toBe("unknown");
    expect(modelKindOf("groq:llama-3.3-70b", routed, () => "local")).toBe("cloud");
  });
});

describe("the served model reaches the ledger row", () => {
  beforeEach(() => experiences.clear());

  it("a turn served by a loopback engine stores modelKind local and the model id, and trains", async () => {
    servedTurn("t-local", ["ollama:qwen2.5:7b"]);
    finishTurn("t-local", ["qwen2.5-7b"]);
    const row = rowOf("t-local");
    expect(row.modelKind).toBe("local");
    expect(row.modelId).toBe("ollama:qwen2.5:7b");
    expect(row.models).toEqual([{ id: "ollama:qwen2.5:7b", kind: "local" }]);
    expect(await kept()).toHaveLength(1);
  });

  it("a cloud reply never trains: modelKind cloud, no outputMayTrain on the row", async () => {
    servedTurn("t-cloud", ["groq:llama-3.3-70b"]);
    finishTurn("t-cloud", ["llama-3.3-70b"]);
    expect(rowOf("t-cloud").modelKind).toBe("cloud");
    const [candidate] = rowsFromExperiences(experiences.successes());
    expect(candidate?.provenance.responseModel).toBe("cloud");
    expect(candidate?.provenance.outputMayTrain).toBeUndefined();
    expect(await kept()).toEqual([]);
  });

  it("a cloud reply trains only when outputMayTrain is exactly true", async () => {
    servedTurn("t-cloud-opt", ["groq:llama-3.3-70b"]);
    finishTurn("t-cloud-opt", []);
    const [candidate] = rowsFromExperiences(experiences.successes());
    const withFlag = (flag: unknown) =>
      selectTrainingRows(
        [{ ...candidate!, provenance: { ...candidate!.provenance, outputMayTrain: flag as true } }],
        { classesAccepted: [LEDGER_DATA_CLASS], classify },
      );
    expect((await withFlag(true)).kept).toHaveLength(1);
    for (const bad of [false, "true", 1, undefined]) {
      expect((await withFlag(bad)).kept).toEqual([]);
    }
  });

  it("a turn whose engine nobody could place is unknown and never trains", async () => {
    servedTurn("t-unknown", ["nobody:nothing"]);
    finishTurn("t-unknown", ["nothing"]);
    expect(rowOf("t-unknown").modelKind).toBe("unknown");
    expect(await kept()).toEqual([]);
  });

  it("a turn with no served model at all stays unknown, as before", async () => {
    finishTurn("t-bare", ["local-model"]);
    expect(rowOf("t-bare").modelKind).toBe("unknown");
    expect(await kept()).toEqual([]);
  });

  it("a retried turn answered by a local then a cloud engine counts as cloud", async () => {
    servedTurn("t-mixed", ["ollama:qwen2.5:7b", "groq:llama-3.3-70b"]);
    finishTurn("t-mixed", []);
    expect(rowOf("t-mixed").modelKind).toBe("cloud");
    expect(await kept()).toEqual([]);
  });

  it("a local reply next to an unplaced engine is unknown, never local", async () => {
    servedTurn("t-half", ["ollama:qwen2.5:7b", "nobody:nothing"]);
    finishTurn("t-half", []);
    expect(rowOf("t-half").modelKind).toBe("unknown");
  });

  it("a note about the served model alone does not make the context look known", () => {
    const gate = new TurnProvenance();
    gate.noteServed("run-x", "ollama:qwen2.5:7b");
    gate.flush("run-x", "t-ctx", [], (id) => modelKindOf(id, routed));
    learning.evaluate({
      taskId: "t-ctx",
      kind: "manual-turn",
      title: "hi",
      success: true,
      verified: true,
      ms: 1,
    });
    expect(rowOf("t-ctx").modelKind).toBe("local");
    expect(rowOf("t-ctx").contextKinds).toBeUndefined();
    expect(rowOf("t-ctx").promptAuthor).toBe("unknown");
  });
});

describe("old rows move forward", () => {
  it("a row stored before modelKind existed reads as unknown, and a junk value too", () => {
    const old = { id: "e1", taskId: "t", models: [{ id: "m", kind: "local" }] };
    expect(migrateExperience(old).modelKind).toBe("unknown");
    expect(migrateExperience({ ...old, modelKind: "cloud" }).modelKind).toBe("cloud");
    expect(migrateExperience({ ...old, modelKind: "owned" }).modelKind).toBe("unknown");
  });

  it("migration is idempotent and keeps the model id", () => {
    const row = migrateExperience({
      id: "e",
      taskId: "t",
      modelId: "ollama:x",
      modelKind: "local",
    });
    expect(migrateExperience(row)).toEqual(row);
    expect(row.modelId).toBe("ollama:x");
  });
});

describe("recalled memory counts as outside content unless the owner wrote it", () => {
  it("web, screen, file and mcp sources are named by their kind", () => {
    expect(kindOfRecalled({ source: "https://example.org/a" })).toBe("web");
    expect(kindOfRecalled({ source: "web-search" })).toBe("web");
    expect(kindOfRecalled({ source: "dom" })).toBe("screen");
    expect(kindOfRecalled({ source: "uia" })).toBe("screen");
    expect(kindOfRecalled({ source: "upload" })).toBe("file");
    expect(kindOfRecalled({ source: "library:abc" })).toBe("file");
    expect(kindOfRecalled({ source: "mcp/notes" })).toBe("mcp");
  });

  it("an owner-authored record adds nothing", () => {
    for (const source of ["user", "owner", "teach", "settings-intent", "first-run"]) {
      expect(kindOfRecalled({ source })).toBeNull();
    }
    expect(kindOfRecalled({ source: "task/abc", provenance: "user" })).toBeNull();
  });

  it("any other or missing source is the conservative kind memory", () => {
    expect(kindOfRecalled({ source: "task/abc" })).toBe("memory");
    expect(kindOfRecalled({ source: "forge/skill" })).toBe("memory");
    expect(kindOfRecalled({ source: "" })).toBe("memory");
    expect(kindOfRecalled({})).toBe("memory");
    expect(kindOfRecalled({ source: 7 })).toBe("memory");
  });

  it("only items used during this turn count, and one that was written during it does not", () => {
    const items = [
      { source: "https://a.example", createdAt: 10, lastUsedAt: 120 },
      { source: "task/old", createdAt: 10, lastUsedAt: 50 },
      { source: "task/new", createdAt: 110, lastUsedAt: 120 },
      { source: "user", createdAt: 10, lastUsedAt: 130 },
    ];
    expect(kindsOfRecalled(items, 100)).toEqual(["web"]);
    expect(kindsOfRecalled([], 100)).toEqual([]);
  });

  it("a recalled web memory keeps an owner-typed row out of training", async () => {
    experiences.clear();
    const gate = new TurnProvenance();
    gate.begin("run-m", { origin: "typed" });
    gate.flush(
      "run-m",
      "t-mem",
      kindsOfRecalled([{ source: "https://a.example", createdAt: 1, lastUsedAt: 200 }], 100),
      (id) => modelKindOf(id, routed),
    );
    servedTurn("t-mem-b", ["ollama:qwen2.5:7b"]);
    learning.evaluate({
      taskId: "t-mem",
      kind: "manual-turn",
      title: "q",
      success: true,
      verified: true,
      ms: 1,
      detail: "a",
      models: [{ id: "ollama:qwen2.5:7b", kind: "local" }],
    });
    expect(rowOf("t-mem").contextKinds).toEqual(["web"]);
    expect(await kept()).toEqual([]);
  });
});

describe("the live wiring", () => {
  it("the engine resolves the served model and the recalled memory before the ledger write", () => {
    const engine = read("src/lib/friday/brain-engine.ts");
    expect(engine).toContain("turnProvenance.noteServed(run.id, event.modelId)");
    expect(engine).toContain("kindsOfRecalled(");
    expect(engine).toContain("modelKindOf(");
    const flush = engine.indexOf("turnProvenance.flush(");
    expect(engine.indexOf("coreBrain.reflect({", flush)).toBeGreaterThan(flush);
  });

  it("the Tasks page marks a queued goal typed, the Brain page marks its box typed", () => {
    expect(read("src/routes/tasks.tsx")).toMatch(
      /taskGraph\.submit\([\s\S]{0,400}promptOrigin: "typed"/,
    );
    expect(read("src/routes/brain.tsx")).toContain('brain.send(input, { promptOrigin: "typed" })');
  });
});
