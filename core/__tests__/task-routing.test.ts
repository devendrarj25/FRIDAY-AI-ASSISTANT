/**
 * The Models page "Task routing" reaches the real router: a catalog id finds its
 * live row, the job a prompt looks like picks the assignment, spoken turns lead
 * with the fast model, and nothing paid is ever offered this way.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { modelById, registryRowMatches, routingTasks } from "../../src/lib/friday/model-catalog";
import {
  taskOfPrompt,
  taskPreference,
  type TaskRow,
} from "../../src/lib/friday/brain/task-routing";

const rows: TaskRow[] = [
  {
    id: "ollama:qwen2.5:1.5b",
    modelName: "qwen2.5:1.5b",
    providerId: "ollama",
    type: "local",
    available: true,
    eligible: true,
  },
  {
    id: "ollama:deepseek-coder-v2:16b",
    modelName: "deepseek-coder-v2:16b",
    providerId: "ollama",
    type: "local",
    available: true,
    eligible: true,
  },
  {
    id: "groq:llama-3.3-70b-versatile",
    modelName: "llama-3.3-70b-versatile",
    providerId: "groq",
    type: "cloud",
    access: "free",
    available: true,
    eligible: true,
  },
  {
    id: "openai:gpt-4o",
    modelName: "gpt-4o",
    providerId: "openai",
    type: "cloud",
    access: "paid",
    available: true,
    eligible: true,
  },
];

describe("catalog entries find their live router rows", () => {
  it("matches a local tag and a cloud API id, and nothing else", () => {
    const fast = modelById.get("qwen2.5-1.5b")!;
    expect(registryRowMatches(fast, rows[0]!)).toBe(true);
    expect(registryRowMatches(fast, rows[1]!)).toBe(false);
    const gpt = modelById.get("gpt-4o")!;
    expect(registryRowMatches(gpt, rows[3]!)).toBe(true);
    expect(registryRowMatches(gpt, rows[2]!)).toBe(false);
    expect(registryRowMatches(fast, { id: "ollama:qwen2.5:7b", modelName: "qwen2.5:7b" })).toBe(
      false,
    );
  });
});

describe("Task routing says who reads each assignment", () => {
  it("every task has an effect, and the ones FRIDAY reads are really read", () => {
    const effects = Object.fromEntries(routingTasks.map((t) => [t.key, t.effect]));
    expect(effects).toMatchObject({
      brain: "turns",
      coding: "turns",
      research: "turns",
      reasoning: "turns",
      vision: "turns",
      fast: "turns",
      speech: "voice",
      voice: "voice",
      image: "none",
      embedding: "none",
      rerank: "none",
    });
    const readable = new Set(["brain", "coding", "research", "reasoning", "vision", "fast"]);
    for (const [key, effect] of Object.entries(effects)) {
      if (effect === "turns") expect(readable.has(key), key).toBe(true);
    }
    expect(read_("src/routes/models.tsx")).toContain("not used yet");
  });
});

describe("task preference", () => {
  const routing = {
    brain: "qwen2.5-1.5b",
    fast: "qwen2.5-1.5b",
    coding: "deepseek-coder-v2",
  } as const;

  it("reads the job from the prompt", () => {
    expect(taskOfPrompt("fix this bug in my script")).toBe("coding");
    expect(taskOfPrompt("why did sales drop")).toBe("reasoning");
    expect(taskOfPrompt("what is on this screenshot")).toBe("vision");
    expect(taskOfPrompt("summarize this whitepaper")).toBe("research");
    expect(taskOfPrompt("good morning")).toBe("brain");
  });

  it("prefers the assigned live model for the job, then the brain", () => {
    expect(
      taskPreference({ prompt: "refactor this function", surface: "chat", routing, rows }),
    ).toEqual(["ollama:deepseek-coder-v2:16b", "ollama:qwen2.5:1.5b"]);
    expect(taskPreference({ prompt: "hello there", surface: "voice", routing, rows })).toEqual([
      "ollama:qwen2.5:1.5b",
    ]);
  });

  it("skips an assignment that is not installed or not eligible", () => {
    expect(
      taskPreference({ prompt: "hello", surface: "chat", routing: { brain: "qwen2.5-32b" }, rows }),
    ).toEqual([]);
    const cooling = rows.map((row) =>
      row.id === "ollama:qwen2.5:1.5b" ? { ...row, eligible: false } : row,
    );
    expect(taskPreference({ prompt: "hello", surface: "chat", routing, rows: cooling })).toEqual(
      [],
    );
  });

  it("never offers a paid model, however it was assigned", () => {
    expect(
      taskPreference({ prompt: "hello", surface: "chat", routing: { brain: "gpt-4o" }, rows }),
    ).toEqual([]);
  });

  it("is applied by send() only when nothing else chose, and never as a Manual/Multi pool", () => {
    const brain = readFileSync(
      path.resolve(import.meta.dirname, "../../src/lib/friday/brain-engine.ts"),
      "utf8",
    );
    expect(brain).toContain(
      "const withTask = named ?? taskRoutingFor(prompt, rawOptions, surface);",
    );
    expect(brain).toContain('snapshot.routeMode === "manual" || snapshot.routeMode === "multi"');
    expect(brain).toContain("if (snapshot.selected.length) return null;");
  });
});

function read_(file: string) {
  return readFileSync(path.resolve(import.meta.dirname, "../..", file), "utf8");
}
