/**
 * A spoken turn never waits for a hidden thinking trace: the renderer asks for low effort and a short reply
 * unless the route is deep-reasoning or multi-verify. Typed chat keeps the effort the route chose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capReasoningEffort, VOICE_MAX_TOKENS } from "../../src/lib/friday/brain/cognitive-route";

const globals = globalThis as unknown as { window?: unknown; friday?: unknown };
globals.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}
const sentChats: Array<Record<string, unknown>> = [];
const noop = () => () => undefined;
globals.friday = {
  isDesktop: true,
  sendChat: (request: Record<string, unknown>) => {
    sentChats.push(request);
    return String(request["requestId"]);
  },
  abortChat: () => undefined,
  onChatDelta: noop,
  onChatTool: noop,
  onChatDone: noop,
  onChatError: noop,
};

const { brain } = await import("../../src/lib/friday/brain-engine");
const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
const { modelRegistry } = await import("../../src/lib/friday/model-registry");

type Inner = {
  state: Record<string, unknown> & {
    runs: unknown[];
    messages: unknown[];
    activeRunId: string | null;
  };
};
const inner = brain as unknown as Inner;

const cognition = (over: Record<string, unknown>) =>
  ({
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
    ...over,
  }) as never;

async function sendAndRead(
  surface: "voice" | "chat",
  over: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  sentChats.length = 0;
  vi.spyOn(coreBrain, "cognize").mockResolvedValue(cognition(over));
  const result = brain.send("explain why the sky is blue in some detail", {
    routingSurface: surface,
  });
  expect(result.accepted).toBe(true);
  await vi.waitFor(() => expect(sentChats.length).toBe(1));
  return sentChats[0]!;
}

beforeEach(() => {
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

describe("capReasoningEffort (pure)", () => {
  it("lowers a voice turn to low unless the route is deep-reasoning or multi-verify", () => {
    expect(capReasoningEffort("medium", "best-single", "voice")).toBe("low");
    expect(capReasoningEffort("high", "best-single", "voice")).toBe("low");
    expect(capReasoningEffort("high", "deep-reasoning", "voice")).toBe("high");
    expect(capReasoningEffort("high", "multi-verify", "voice")).toBe("high");
    expect(capReasoningEffort("medium", "best-single", "chat")).toBe("medium");
    expect(capReasoningEffort(undefined, "best-single", "voice")).toBe("low");
    expect(capReasoningEffort(undefined, "best-single", "chat")).toBeUndefined();
  });
});

describe("the sendChat request", () => {
  it("sends reasoningEffort low and a short maxTokens for a deliberative voice turn", async () => {
    const request = await sendAndRead("voice", {
      reasoningEffort: "medium",
      routeAction: "best-single",
    });
    expect(request["reasoningEffort"]).toBe("low");
    expect(request["maxTokens"]).toBe(VOICE_MAX_TOKENS);
    expect(VOICE_MAX_TOKENS).toBeGreaterThanOrEqual(160);
    expect(VOICE_MAX_TOKENS).toBeLessThanOrEqual(200);
  });

  it("keeps high for a voice turn the route sent to deep-reasoning", async () => {
    const request = await sendAndRead("voice", {
      reasoningEffort: "high",
      routeAction: "deep-reasoning",
    });
    expect(request["reasoningEffort"]).toBe("high");
  });

  it("leaves a typed turn's effort alone and sends no token cap", async () => {
    const request = await sendAndRead("chat", {
      reasoningEffort: "medium",
      routeAction: "best-single",
    });
    expect(request["reasoningEffort"]).toBe("medium");
    expect(request["maxTokens"]).toBeUndefined();
  });
});
