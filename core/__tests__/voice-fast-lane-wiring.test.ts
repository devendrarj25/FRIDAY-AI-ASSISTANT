/**
 * The fast voice brain, end to end with fakes: a quick spoken line carries lane "quick" to the router and takes the
 * small fast model, the real turn carries lane "full" and keeps the main one, a long task says at most three status
 * lines a minute (a closed template, never the task's own words), and Chat mode says none. The small PC with no twin
 * keeps its one model for everything.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
const require_ = createRequire(import.meta.url);
pinKnowledgeClock();
const router = require_("../../electron/model-router.cjs");

type Handler = (event: Record<string, unknown>) => void;
const globals = globalThis as unknown as { window?: unknown; friday?: unknown };
globals.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}
const sentChats: Array<Record<string, unknown>> = [];
const deltas = new Set<Handler>();
const dones = new Set<Handler>();
const noop = () => () => undefined;
// Only a one-shot ask (session "ask-...") is answered here; the Brain's own turns are recorded and left open.
globals.friday = {
  isDesktop: true,
  sendChat: (request: Record<string, unknown>) => {
    sentChats.push(request);
    if (String(request["sessionId"]).startsWith("ask-")) {
      const status = String(request["prompt"]).startsWith("Task:");
      queueMicrotask(() => {
        const id = String(request["requestId"]);
        deltas.forEach((fn) => fn({ requestId: id, text: status ? "Still on it." : "Paris." }));
        dones.forEach((fn) => fn({ requestId: id }));
      });
    }
    return String(request["requestId"]);
  },
  abortChat: () => undefined,
  onChatDelta: (fn: Handler) => (deltas.add(fn), () => deltas.delete(fn)),
  onChatDone: (fn: Handler) => (dones.add(fn), () => dones.delete(fn)),
  onChatError: noop,
  onChatTool: noop,
};

const { brain } = await import("../../src/lib/friday/brain-engine");
const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
const { modelRegistry } = await import("../../src/lib/friday/model-registry");
const { assistantMode } = await import("../../src/lib/friday/assistant-mode");
const { voiceGate } = await import("../../src/lib/friday/voice-audio");
const { STATUS_FIRST_MS, STATUS_GAP_MS, STATUS_PER_TASK } =
  await import("../../src/lib/friday/voice-engine/brain-bridge");
const { TASK_STATUS_LINES } = await import("../../src/lib/friday/voice-engine/narration-policy");

const TAGS = ["qwen3.5:0.8b", "qwen3.5:2b"];
const local = (id: string, sizeGb: number) => ({
  id,
  type: "local" as const,
  contextK: 8,
  providerId: "ollama",
  meta: {
    providerId: "ollama",
    kind: "local",
    modelName: id.replace(/^ollama:/, ""),
    connected: true,
    sizeGb,
  },
});
const MAIN = () => local("ollama:qwen3.5:9b", 6.6);
const FAST = () => local("ollama:qwen3.5:2b", 2.7);
/** What main.cjs hands the router from a chat request: the surface and the lane, nothing else is trusted. */
const routeOf = (models: unknown[], request: Record<string, unknown>, extra = {}) =>
  router.routeRequest(models, {
    task: "chat",
    mode: "local-only",
    policy: "free-only",
    limit: 4,
    voiceTags: TAGS,
    ...(request["routingSurface"] === "voice" || request["routingSurface"] === "chat"
      ? { surface: request["routingSurface"] }
      : {}),
    ...(request["lane"] === "quick" || request["lane"] === "full" ? { lane: request["lane"] } : {}),
    ...extra,
  });
const first = (plan: { models: { id: string }[] }) => plan.models[0]?.id;

type Inner = {
  state: Record<string, unknown> & {
    runs: unknown[];
    messages: unknown[];
    activeRunId: string | null;
  };
  answerQuick: (text: string, surface: "voice" | "chat") => Promise<void>;
};
const inner = brain as unknown as Inner;

const cognition = {
  taskId: "t",
  prompt: "p",
  mode: "auto",
  system: "sys",
  modelIds: [],
  routing: "test",
  context: [],
  tools: [],
  sources: [],
  notes: [],
  dispatch: {},
  startedAt: 0,
  useKnowledge: true,
  useProjectMemory: true,
  autoLearn: true,
} as never;

beforeEach(() => {
  sentChats.length = 0;
  inner.state.runs = [];
  inner.state.messages = [];
  inner.state.activeRunId = null;
  vi.spyOn(modelRegistry, "getSnapshot").mockImplementation(
    () =>
      ({
        models: [
          { id: "ollama/qwen3", type: "local", access: "free", available: true, eligible: true },
        ],
        routeMode: "auto",
        selected: [],
        policy: "free-only",
      }) as never,
  );
});
afterEach(() => {
  brain.stop("all");
  vi.restoreAllMocks();
});

describe("the lane reaches the router and the kernel", () => {
  it("main.cjs keeps only quick or full, in the route options, the plan and the kernel call", () => {
    const main = read("electron/main.cjs");
    const lane = /request\.lane === "quick" \|\| request\.lane === "full"/g;
    expect(main.match(lane)?.length).toBe(2);
    expect(main).toMatch(/extraOptions\.lane === "quick" \|\| extraOptions\.lane === "full"/);
    const call = main.slice(main.indexOf('method: "chat.stream"'));
    expect(call.slice(0, call.indexOf("runId: request.runId"))).toContain("{ lane: request.lane }");
  });

  it("the kernel hands router.stream a lane only when it is quick or full", () => {
    const kernel = read("kernel/main.py");
    expect(kernel).toContain(
      'lane=params.get("lane") if params.get("lane") in ("quick", "full") else None,',
    );
  });

  it("the bridge type and the one-shot ask both carry the lane", () => {
    const bridge = read("src/lib/friday/bridge.ts");
    expect(bridge.slice(bridge.indexOf("sendChat?: (request: {"))).toMatch(
      /lane\?: "quick" \| "full";/,
    );
    expect(read("src/lib/friday/ask.ts")).toContain(
      "...(options.lane ? { lane: options.lane } : {}),",
    );
  });
});

describe("the chat plan is warmed at boot and when the hardware is probed again", () => {
  const main = read("electron/main.cjs");

  it("warmChatPlan calls refreshChatPlan best effort and never awaits it", () => {
    const body = main.slice(main.indexOf("function warmChatPlan("));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    expect(fn).toContain("modelsApi.refreshChatPlan?.(force ? { force: true } : {})");
    expect(fn).toContain(".catch(() => {})");
    expect(fn).toContain("catch {");
    expect(fn).not.toMatch(/\bawait\b/);
  });

  it("boot fires it with the hardware probe and a forced probe fires it again", () => {
    const boot = main.slice(main.indexOf("  warmChatPlan();"));
    expect(boot.slice(0, 300)).toContain("hardwareBoot = detectHardware(hardwareProbeOptions())");
    const cached = main.slice(main.indexOf("function detectHardwareCached("));
    expect(cached.slice(0, 700)).toContain("if (force) warmChatPlan(true);");
    expect(main.match(/warmChatPlan\(/g)?.length).toBe(3);
  });
});

describe("a spoken quick answer takes the fast model; the real turn keeps the main one", () => {
  it("answerQuick sends the voice surface and the quick lane; a typed one stays plain", async () => {
    await inner.answerQuick("capital of France?", "voice");
    await inner.answerQuick("capital of France?", "chat");
    const [spoken, typed] = sentChats;
    expect(spoken).toMatchObject({ routingSurface: "voice", lane: "quick", draft: true });
    expect(typed).not.toHaveProperty("lane");
    expect(typed).not.toHaveProperty("routingSurface");
  });

  it("the real voice turn sends lane full, a chat turn sends none", async () => {
    vi.spyOn(coreBrain, "cognize").mockResolvedValue(cognition);
    brain.send("explain why the sky is blue in some detail", { routingSurface: "voice" });
    await vi.waitFor(() => expect(sentChats.length).toBe(1));
    brain.stop("all");
    sentChats.length = 0;
    brain.send("explain why the sky is blue in some detail", { routingSurface: "chat" });
    await vi.waitFor(() => expect(sentChats.length).toBe(1));
    expect(sentChats[0]).not.toHaveProperty("lane");
  });

  it("the sent requests choose the right model with two local brains", async () => {
    await inner.answerQuick("capital of France?", "voice");
    const quick = sentChats[0]!;
    expect(first(routeOf([MAIN(), FAST()], quick))).toBe("ollama:qwen3.5:2b");
    vi.spyOn(coreBrain, "cognize").mockResolvedValue(cognition);
    brain.send("explain why the sky is blue in some detail", { routingSurface: "voice" });
    await vi.waitFor(() => expect(sentChats.length).toBe(2));
    const full = sentChats[1]!;
    expect(full["lane"]).toBe("full");
    expect(first(routeOf([MAIN(), FAST()], full))).toBe("ollama:qwen3.5:9b");
  });
});

describe("a PC whose only model is a voice tag keeps it for everything", () => {
  const cloud = {
    id: "openrouter:free/model",
    type: "cloud" as const,
    contextK: 32,
    providerId: "openrouter",
    access: "free",
    meta: { providerId: "openrouter", kind: "cloud", modelName: "free/model", connected: true },
  };
  const voice = (lane: string) => ({ routingSurface: "voice", lane });

  it("the quick and the full lane both answer on the one local model", () => {
    for (const lane of ["quick", "full"]) {
      expect(first(routeOf([FAST()], voice(lane))), lane).toBe("ollama:qwen3.5:2b");
    }
  });

  it("the full lane never steps back from the one local model, even next to a cloud route", () => {
    const plan = routeOf([FAST(), cloud], voice("full"), { mode: "auto", policy: "free-first" });
    expect(first(plan)).toBe("ollama:qwen3.5:2b");
  });

  it("a quick line on that PC does not outrank a main-model plan: the lane only orders within the voice score", () => {
    const withLane = routeOf([FAST(), cloud], voice("quick"), {
      mode: "auto",
      policy: "free-first",
    });
    const without = routeOf(
      [FAST(), cloud],
      { routingSurface: "voice" },
      {
        mode: "auto",
        policy: "free-first",
      },
    );
    expect(first(withLane)).toBe(first(without));
  });
});

describe("a long task says at most three status lines a minute, and only in Auto mode", () => {
  type Driver = {
    state: Record<string, unknown> & { mode: string };
    statusLineTick: (now: number) => void;
    statusTask: unknown;
    ackHeld: () => boolean;
    announceTask: (text: string, meta?: Record<string, unknown>) => void;
  };
  const d = assistantMode as unknown as Driver;
  const T0 = 1_000_000;
  const run = (prompt: string) => ({
    activeRunId: "r1",
    approval: null,
    runs: [{ id: "r1", state: "running", prompt, startedAt: T0 }],
  });
  let said: string[];
  const settle = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  /** Five-second beats over `seconds`, as the supervisor runs them. */
  async function runFor(seconds: number) {
    for (let t = 5; t <= seconds; t += 5) {
      d.statusLineTick(T0 + t * 1000);
      await settle();
    }
  }

  beforeEach(() => {
    said = [];
    d.statusTask = null;
    vi.spyOn(d, "ackHeld").mockReturnValue(false);
    // The open microphone hears nobody (with no mic running the gate would count the owner as speaking).
    vi.spyOn(voiceGate, "heardSpeechWithin").mockReturnValue(false);
    vi.spyOn(d, "announceTask").mockImplementation((text) => {
      said.push(text);
    });
    vi.spyOn(brain, "getSnapshot").mockReturnValue(run("search the web for flights") as never);
  });
  afterEach(() => {
    d.state.mode = "chat";
    d.statusTask = null;
  });

  it("Auto mode: the first line waits for the first interval, then at most three in sixty seconds", async () => {
    d.state.mode = "auto";
    await runFor(STATUS_FIRST_MS / 1000 - 1);
    expect(said).toEqual([]);
    await runFor(60);
    // Beats at 5 s: the first line at 10 s, then 30 s and 50 s; the fourth would be at 70 s.
    expect(said.length).toBe(3);
    expect(STATUS_GAP_MS).toBeGreaterThanOrEqual(20_000);
    expect(STATUS_PER_TASK).toBeGreaterThanOrEqual(said.length);
  });

  it("the model request carries only the closed verb, on the quick voice lane, never the task text", async () => {
    d.state.mode = "auto";
    await runFor(10);
    const asked = sentChats.filter((r) => String(r["sessionId"]).startsWith("ask-"));
    expect(asked.length).toBe(1);
    expect(asked[0]).toMatchObject({
      prompt: "Task: search",
      routingSurface: "voice",
      lane: "quick",
      draft: true,
    });
    expect(JSON.stringify(asked[0])).not.toMatch(/flights|web/i);
    expect(said).toEqual(["Still on it."]);
  });

  it("a private task never reaches a model and says the fixed line", async () => {
    vi.spyOn(brain, "getSnapshot").mockReturnValue(
      run("search my bank password 4821 4821") as never,
    );
    d.state.mode = "auto";
    await runFor(10);
    expect(sentChats.filter((r) => String(r["sessionId"]).startsWith("ask-"))).toEqual([]);
    expect(said).toEqual([TASK_STATUS_LINES.en.search]);
  });

  it("Chat and Manual mode never call a model or speak a status line", async () => {
    for (const mode of ["chat", "manual"]) {
      d.state.mode = mode;
      d.statusTask = null;
      await runFor(60);
      expect(said, mode).toEqual([]);
      expect(
        sentChats.filter((r) => String(r["sessionId"]).startsWith("ask-")),
        mode,
      ).toEqual([]);
    }
  });

  it("the real answer starting cancels a line that is still on its way", async () => {
    d.state.mode = "auto";
    const live = d as unknown as { voicedChars: number };
    await runFor(5);
    d.statusLineTick(T0 + 10_000);
    live.voicedChars = 12;
    await settle();
    live.voicedChars = 0;
    expect(sentChats.filter((r) => String(r["sessionId"]).startsWith("ask-")).length).toBe(1);
    expect(said).toEqual([]);
  });
});
