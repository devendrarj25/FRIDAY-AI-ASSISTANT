/**
 * No live model, no invented model.
 *
 * The Brain resolves a model only against the live registry rows. When no live row confirms any model
 * (no rows, only cloud rows with billing off, offline with only cloud rows, a private turn with no local row)
 * the answer is a typed `no-live-model` outcome with a null id: never the static catalogue id, never a
 * silent hang. The caller turns it into one plain line in the owner's language. Chat and voice share the
 * same pool and the same gates and differ only in ordering (voice latency first, chat quality first).
 *
 * The registry is fed fixed rows; no network, no model, no real clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_LIVE_MODEL,
  noLiveModelLine,
  resolveLiveRoute,
  type LiveRouteRow,
} from "../../src/lib/friday/model-routing-contract";

const STATIC_ID = "qwen2.5-32b";

const row = (over: Partial<LiveRouteRow> & { id: string }): LiveRouteRow => ({
  label: over.id,
  modelName: over.id,
  type: "local",
  access: "free",
  available: true,
  eligible: true,
  latencyMs: null,
  quality: null,
  ...over,
});
const LOCAL_FAST = row({ id: "ollama/fast", latencyMs: 60, quality: 0.2 });
const LOCAL_STRONG = row({ id: "ollama/strong", latencyMs: 900, quality: 0.9 });
const CLOUD_FREE = row({ id: "openrouter/free", type: "cloud" });
const CLOUD_PAID_OFF = row({
  id: "openai/gpt",
  type: "cloud",
  access: "paid",
  eligible: false,
});

const live = (models: LiveRouteRow[], over: Record<string, unknown> = {}) => ({
  models,
  selected: [] as string[],
  routeMode: "manual",
  ...over,
});
const routing = { brain: STATIC_ID, chat: STATIC_ID };

describe("resolveLiveRoute: the typed no-live-model outcome", () => {
  it("returns no-live-model with a null id when the registry has no rows (never the static id)", () => {
    for (const surface of ["chat", "voice"] as const) {
      const out = resolveLiveRoute({ live: live([]), routing, task: "chat", surface });
      expect(out.outcome).toBe(NO_LIVE_MODEL);
      expect(out.id).toBeNull();
      expect(JSON.stringify(out)).not.toContain(STATIC_ID);
      expect(out).toMatchObject({ reason: "no-rows" });
    }
  });

  it("returns no-live-model when only cloud rows exist and billing is off (rows ineligible)", () => {
    const out = resolveLiveRoute({
      live: live([CLOUD_PAID_OFF]),
      routing,
      task: "chat",
      surface: "chat",
    });
    expect(out).toMatchObject({ outcome: NO_LIVE_MODEL, id: null, reason: "none-eligible" });
  });

  it("returns no-live-model when offline and only cloud rows are left", () => {
    const out = resolveLiveRoute({
      live: live([CLOUD_FREE]),
      routing,
      task: "chat",
      surface: "voice",
      offline: true,
    });
    expect(out).toMatchObject({ outcome: NO_LIVE_MODEL, id: null, reason: "offline" });
  });

  it("a private turn never takes a cloud row, even a free one: no local row means no-live-model", () => {
    const out = resolveLiveRoute({
      live: live([CLOUD_FREE]),
      routing,
      task: "chat",
      surface: "chat",
      privacy: "private",
    });
    expect(out).toMatchObject({ outcome: NO_LIVE_MODEL, id: null, reason: "private" });
    // auto mode does not hide it behind "Auto" either
    const auto = resolveLiveRoute({
      live: live([CLOUD_FREE], { routeMode: "auto" }),
      routing,
      task: "chat",
      surface: "chat",
      privacy: "private",
    });
    expect(auto.outcome).toBe(NO_LIVE_MODEL);
  });

  it("a private turn still reaches a local row", () => {
    const out = resolveLiveRoute({
      live: live([CLOUD_FREE, LOCAL_FAST]),
      routing,
      task: "chat",
      surface: "chat",
      privacy: "private",
    });
    expect(out).toMatchObject({ outcome: "model", id: "ollama/fast" });
  });

  it("with only local rows the local row is used (no cloud needed, offline or not)", () => {
    for (const offline of [false, true]) {
      const out = resolveLiveRoute({
        live: live([LOCAL_FAST]),
        routing,
        task: "chat",
        surface: "chat",
        offline,
      });
      expect(out).toMatchObject({ outcome: "model", id: "ollama/fast" });
    }
  });

  it("a static routing id that no live row confirms is skipped for a row that is live", () => {
    const out = resolveLiveRoute({
      live: live([LOCAL_FAST]),
      routing: { brain: "some-unlisted-model" },
      task: "chat",
      surface: "chat",
    });
    expect(out.id).toBe("ollama/fast");
  });

  it("an eligible live row that matches the routing id is honoured", () => {
    const out = resolveLiveRoute({
      live: live([LOCAL_FAST, LOCAL_STRONG]),
      routing: { chat: "ollama/fast" },
      task: "chat",
      surface: "chat",
    });
    expect(out.id).toBe("ollama/fast");
  });

  it("auto with nothing picked stays Auto only while some row can answer", () => {
    const some = resolveLiveRoute({
      live: live([LOCAL_FAST], { routeMode: "auto" }),
      routing,
      task: "chat",
      surface: "chat",
    });
    expect(some).toMatchObject({ outcome: "auto", id: null });
    const none = resolveLiveRoute({
      live: live([CLOUD_PAID_OFF], { routeMode: "auto" }),
      routing,
      task: "chat",
      surface: "chat",
    });
    expect(none.outcome).toBe(NO_LIVE_MODEL);
  });

  it("chat and voice share the pool and the gates and differ only in order", () => {
    const rows = [LOCAL_STRONG, LOCAL_FAST, CLOUD_PAID_OFF];
    const chat = resolveLiveRoute({ live: live(rows), routing: {}, task: "chat", surface: "chat" });
    const voice = resolveLiveRoute({
      live: live(rows),
      routing: {},
      task: "chat",
      surface: "voice",
    });
    expect(chat.id).toBe("ollama/strong");
    expect(voice.id).toBe("ollama/fast");
    for (const [name, args] of [
      ["no rows", { live: live([]) }],
      ["billing off", { live: live([CLOUD_PAID_OFF]) }],
      ["offline", { live: live([CLOUD_FREE]), offline: true }],
      ["private", { live: live([CLOUD_FREE]), privacy: "private" as const }],
    ] as const) {
      const a = resolveLiveRoute({ routing, task: "chat", surface: "chat", ...args });
      const b = resolveLiveRoute({ routing, task: "chat", surface: "voice", ...args });
      expect(b, name).toEqual(a);
    }
  });

  it("a pinned row that is not live is not returned either", () => {
    const out = resolveLiveRoute({
      live: live([CLOUD_PAID_OFF], { selected: ["openai/gpt"], routeMode: "manual" }),
      routing,
      task: "chat",
      surface: "chat",
    });
    expect(out.outcome).toBe(NO_LIVE_MODEL);
    expect(out.id).toBeNull();
  });
});

describe("noLiveModelLine: one line in the owner's language", () => {
  const reasons = ["no-rows", "none-eligible", "offline", "private"] as const;
  it("is one plain line per language and reason, and never names a model id", () => {
    for (const reason of reasons) {
      for (const prompt of ["what is a prime number?", "यह क्या है?", "mujhe batao yaar kya hai"]) {
        const line = noLiveModelLine(prompt, reason);
        expect(line.length).toBeGreaterThan(20);
        expect(line).not.toContain("\n");
        expect(line).not.toContain(STATIC_ID);
      }
    }
  });

  it("answers Hindi in Devanagari, Hinglish in Roman Hindi and English in English", () => {
    for (const reason of reasons) {
      expect(noLiveModelLine("यह क्या है?", reason)).toMatch(/\p{Script=Devanagari}/u);
      const hinglish = noLiveModelLine("mujhe batao yaar kya hai", reason);
      expect(hinglish).not.toMatch(/\p{Script=Devanagari}/u);
      expect(hinglish).toMatch(/\b(nahi|hai|abhi|mera|model)\b/i);
      expect(hinglish).not.toBe(noLiveModelLine("what is a prime number?", reason));
      expect(noLiveModelLine("what is a prime number?", reason)).toMatch(/model/i);
    }
  });

  it("says a private line stays on this PC and an offline one needs a local model", () => {
    expect(noLiveModelLine("hello", "private")).toMatch(/private|this PC/i);
    expect(noLiveModelLine("hello", "offline")).toMatch(/offline|internet/i);
  });
});

// ------------------------------------------------------------------ the Brain wires it

const globals = globalThis as unknown as { window?: unknown; friday?: unknown };
globals.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}
const sentChats: Array<Record<string, unknown>> = [];
const noop = () => () => undefined;
globals.friday = {
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
const { models } = await import("../../src/lib/friday/models-engine");
const { preferences } = await import("../../src/lib/friday/preferences");
const { autonomy } = await import("../../src/lib/friday/self/autonomy");

type Inner = {
  state: { runs: unknown[]; messages: unknown[]; activeRunId: string | null; approval: unknown };
};
const inner = brain as unknown as Inner;

let rows: LiveRouteRow[] = [];
let privacyMode = false;
let routeMode = "manual";
let loading = false;

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  rows = [];
  privacyMode = false;
  routeMode = "manual";
  loading = false;
  sentChats.length = 0;
  autonomy.reset();
  inner.state.runs = [];
  inner.state.messages = [];
  inner.state.activeRunId = null;
  inner.state.approval = null;
  vi.spyOn(modelRegistry, "getSnapshot").mockImplementation(
    () => ({ models: rows, routeMode, selected: [], policy: "free-only", loading }) as never,
  );
  const snapshot = preferences.getSnapshot();
  vi.spyOn(preferences, "getSnapshot").mockImplementation(
    () => ({ ...snapshot, voice: { ...snapshot.voice, privacyMode } }) as never,
  );
  const modelSnap = models.getSnapshot();
  vi.spyOn(models, "getSnapshot").mockImplementation(
    () =>
      ({
        ...modelSnap,
        routing: { ...modelSnap.routing, brain: STATIC_ID, chat: STATIC_ID },
      }) as never,
  );
  // The real Core Brain echoes an owner-pinned list; anything else it leaves to the router.
  vi.spyOn(coreBrain, "cognize").mockImplementation((async (
    text: string,
    options: { pinnedModelIds?: string[] },
  ) => ({
    taskId: "test-task",
    mode: "manual",
    prompt: text,
    modelIds: options.pinnedModelIds ?? [],
    context: [],
    tools: [],
    sources: [],
    routing: "test",
    system: "",
  })) as never);
});

afterEach(() => {
  brain.stop("all");
  vi.restoreAllMocks();
  autonomy.reset();
});

const lastFriday = () => {
  const messages = brain.getSnapshot().messages.filter((m) => m.role === "friday");
  return messages[messages.length - 1]?.text ?? "";
};

describe("the Brain turns no-live-model into a clear line, on chat and on voice alike", () => {
  const QUESTION = "explain how a transformer attention head works in detail please";

  for (const surface of ["chat", "voice"] as const) {
    it(`${surface}: no live rows sends nothing, leaks no static id and shows one line`, async () => {
      const result = brain.send(QUESTION, { routingSurface: surface });
      expect(result.accepted).toBe(true);
      await settle();
      expect(sentChats).toHaveLength(0);
      const state = brain.getSnapshot();
      const run = state.runs[0]!;
      expect(run.state).toBe("failed");
      expect(run.agents.every((a) => a.modelId === null)).toBe(true);
      expect(JSON.stringify(run.agents)).not.toContain(STATIC_ID);
      expect(lastFriday()).toMatch(/model/i);
      expect(lastFriday()).not.toContain(STATIC_ID);
      expect(lastFriday()).not.toContain("\n");
    });
  }

  it("answers in Hindi and in Hinglish when the owner wrote that", async () => {
    brain.send("बताओ ट्रांसफॉर्मर कैसे काम करता है, विस्तार से समझाओ");
    await settle();
    expect(lastFriday()).toMatch(/\p{Script=Devanagari}/u);
    brain.stop("all");
    brain.send("mujhe batao yaar transformer attention kaise kaam karta hai detail mein samjhao");
    await settle();
    expect(lastFriday()).not.toMatch(/\p{Script=Devanagari}/u);
    expect(lastFriday()).toMatch(/\b(nahi|abhi|hai)\b/i);
  });

  it("only cloud rows with billing off: no send, no leak", async () => {
    rows = [CLOUD_PAID_OFF];
    brain.send(QUESTION);
    await settle();
    expect(sentChats).toHaveLength(0);
    expect(JSON.stringify(brain.getSnapshot().runs[0]!.agents)).not.toContain(STATIC_ID);
  });

  it("a private turn with only a cloud row: no send", async () => {
    rows = [CLOUD_FREE];
    privacyMode = true;
    brain.send(QUESTION);
    await settle();
    expect(sentChats).toHaveLength(0);
    expect(lastFriday()).toMatch(/private|this PC/i);
  });

  it("a live local row still goes to the model, with that row's id and never the static one", async () => {
    rows = [LOCAL_FAST];
    brain.send(QUESTION);
    await settle();
    expect(sentChats).toHaveLength(1);
    const ids = JSON.stringify(sentChats[0]!["modelIds"]);
    expect(ids).toContain("ollama/fast");
    expect(ids).not.toContain(STATIC_ID);
  });

  it("while the registry is still loading the main router decides (nothing is blocked, nothing invented)", async () => {
    loading = true;
    brain.send(QUESTION);
    await settle();
    expect(sentChats).toHaveLength(1);
    expect(JSON.stringify(sentChats[0]!["modelIds"] ?? [])).not.toContain(STATIC_ID);
  });

  it("an owner-pinned model is passed through untouched", async () => {
    brain.send(QUESTION, { modelIds: ["ollama/pinned"], routeMode: "manual" });
    await settle();
    expect(sentChats).toHaveLength(1);
    expect(JSON.stringify(sentChats[0]!["modelIds"])).toContain("ollama/pinned");
  });
});
