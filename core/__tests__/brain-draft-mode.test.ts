/**
 * Draft mode of the Brain: a text-only guess at the answer, made while the owner is still finishing.
 *
 * A draft has NO tools, NO approval, NO memory write, NO history row, NO run row in the transcript, and it
 * reaches only a local or proven-free model (never a cloud model in privacy mode or for a sensitive line,
 * never a paid or unknown-cost model). It becomes a real run only when the final transcript equals the words
 * it started from; anything else throws it away without a trace. One draft at most, and it dies after 10 s.
 *
 * `window.friday` is a fake bridge that records what the Brain asks and lets the test play the stream back;
 * the registry and preferences are fed fixed rows; time is a fake clock. No model, network or real date.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DRAFT_SYSTEM,
  DRAFT_TTL_MS,
  draftPool,
  sameTranscript,
  type DraftModelRow,
} from "../../src/lib/friday/self/brain-draft";

const globals = globalThis as unknown as { window?: unknown; friday?: unknown };
globals.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}

type Handler = (event: Record<string, unknown>) => void;
const handlers: Record<"delta" | "tool" | "done" | "error", Handler[]> = {
  delta: [],
  tool: [],
  done: [],
  error: [],
};
const sentChats: Array<Record<string, unknown>> = [];
const aborted: string[] = [];
const listen = (kind: keyof typeof handlers) => (cb: Handler) => {
  handlers[kind].push(cb);
  return () => undefined;
};
globals.friday = {
  sendChat: (request: Record<string, unknown>) => {
    sentChats.push(request);
    return String(request["requestId"]);
  },
  abortChat: (requestId: string) => {
    aborted.push(requestId);
  },
  onChatDelta: listen("delta"),
  onChatTool: listen("tool"),
  onChatDone: listen("done"),
  onChatError: listen("error"),
};

const { brain } = await import("../../src/lib/friday/brain-engine");
const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
const { modelRegistry } = await import("../../src/lib/friday/model-registry");
const { preferences } = await import("../../src/lib/friday/preferences");
const { autonomy } = await import("../../src/lib/friday/self/autonomy");

// The chat events are bound on first hydrate; do it directly, once, with the fake bridge in place.
(brain as unknown as { bindDesktopChat: () => void }).bindDesktopChat();

type Inner = {
  state: Record<string, unknown> & {
    runs: unknown[];
    messages: unknown[];
    activeRunId: string | null;
    approval: unknown;
  };
  draft: unknown;
};
const inner = brain as unknown as Inner;

const row = (over: Partial<DraftModelRow> & { id: string }): DraftModelRow => ({
  type: "local",
  access: "free",
  available: true,
  eligible: true,
  ...over,
});
const LOCAL = row({ id: "ollama/llama", type: "local" });
const FREE_CLOUD = row({ id: "openrouter/free", type: "cloud", access: "free" });
const PAID_CLOUD = row({ id: "openai/gpt", type: "cloud", access: "paid" });
const UNKNOWN_CLOUD = row({ id: "mystery/model", type: "cloud", access: "unknown" });

let rows: DraftModelRow[] = [];
let privacyMode = false;

const QUESTION = "what is a prime number?";

function emit(kind: keyof typeof handlers, event: Record<string, unknown>) {
  for (const handler of handlers[kind]) handler(event);
}
const lastRequestId = () => String(sentChats[sentChats.length - 1]?.["requestId"]);

/** Everything a draft must leave exactly as it found it. */
function trace() {
  return JSON.stringify({
    messages: inner.state.messages,
    runs: inner.state.runs,
    activeRunId: inner.state.activeRunId,
    approval: inner.state.approval,
    stats: inner.state["stats"],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  rows = [LOCAL];
  privacyMode = false;
  sentChats.length = 0;
  aborted.length = 0;
  autonomy.reset();
  inner.state.runs = [];
  inner.state.messages = [];
  inner.state.activeRunId = null;
  inner.state.approval = null;
  inner.draft = null;
  vi.spyOn(modelRegistry, "getSnapshot").mockImplementation(
    () => ({ models: rows, routeMode: "auto", selected: [], policy: "free-only" }) as never,
  );
  const snapshot = preferences.getSnapshot();
  vi.spyOn(preferences, "getSnapshot").mockImplementation(
    () => ({ ...snapshot, voice: { ...snapshot.voice, privacyMode } }) as never,
  );
  vi.spyOn(coreBrain, "cognize").mockImplementation((() => {
    throw new Error("a draft must never run the Core Brain pass (memory, tools)");
  }) as never);
});

afterEach(() => {
  brain.stop("all");
  vi.restoreAllMocks();
  vi.useRealTimers();
  autonomy.reset();
});

describe("draftPool (the billing and privacy rule)", () => {
  it("keeps local and proven-free rows, drops paid, unknown, absent and ineligible ones", () => {
    const all = [
      LOCAL,
      FREE_CLOUD,
      PAID_CLOUD,
      UNKNOWN_CLOUD,
      row({ id: "x", available: false }),
      row({ id: "y", eligible: false }),
    ];
    expect(draftPool(all, false).map((m) => m.id)).toEqual(["ollama/llama", "openrouter/free"]);
    expect(draftPool(all, true).map((m) => m.id)).toEqual(["ollama/llama"]);
  });

  it("adoption compares the words exactly, trimming only the ends", () => {
    expect(sameTranscript("  kya haal hai? ", "kya haal hai?")).toBe(true);
    expect(sameTranscript("kya haal hai?", "kya haal hai")).toBe(false);
    expect(sameTranscript("What is it?", "what is it?")).toBe(false);
    expect(sameTranscript("नमस्ते दोस्त।", "नमस्ते दोस्त।")).toBe(true);
  });
});

describe("a draft is a text-only call that leaves no trace", () => {
  it("starts on a local model with a free-only, tool-less, session-less request", () => {
    const before = trace();
    const snapshotBefore = brain.getSnapshot();
    const result = brain.startDraft(QUESTION);
    expect(result.started).toBe(true);
    expect(sentChats).toHaveLength(1);
    const request = sentChats[0]!;
    expect(String(request["requestId"])).toMatch(/^draft-/);
    expect(request["sessionId"]).not.toBe("main");
    expect(request["prompt"]).toBe(QUESTION);
    expect(request["system"]).toBe(DRAFT_SYSTEM);
    expect(request["draft"]).toBe(true);
    expect(request["routingSurface"]).toBe("voice");
    const contract = request["routingContract"] as {
      costPolicy: string;
      requirements: { tools?: boolean };
    };
    expect(contract.costPolicy).toBe("free-only");
    expect(contract.requirements.tools).toBe(false);
    // no run, no row, no echo, nothing re-rendered
    expect(trace()).toBe(before);
    expect(brain.getSnapshot()).toBe(snapshotBefore);
    expect(coreBrain.cognize).not.toHaveBeenCalled();
  });

  it("send(prompt, { draft: true }) is that same path and never starts a run", () => {
    const before = trace();
    const result = brain.send(QUESTION, { draft: true });
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe("draft");
    expect(result.draft).toMatchObject({ started: true });
    expect(result.runId).toBeUndefined();
    expect(sentChats).toHaveLength(1);
    expect(trace()).toBe(before);
  });

  it("a model the words name does not pin the draft (a draft takes the free-only pool)", () => {
    brain.startDraft("what is a prime number, ask gpt-4o?");
    expect(sentChats[0]?.["modelIds"]).toBeUndefined();
  });

  it("the handle fills as the answer streams; the transcript, history and runs stay untouched", () => {
    const before = trace();
    const started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    expect(started.draft.text).toBe("");
    expect(started.draft.firstTokenAt).toBeUndefined();
    vi.setSystemTime(1_700_000_000_400);
    emit("delta", { requestId: lastRequestId(), modelId: "ollama/llama", text: "A number " });
    emit("delta", {
      requestId: lastRequestId(),
      modelId: "ollama/llama",
      text: "with two divisors.",
    });
    expect(started.draft.text).toBe("A number with two divisors.");
    expect(started.draft.firstTokenAt).toBe(1_700_000_000_400);
    expect(trace()).toBe(before);
  });

  it("a tool event in a draft ends it at once: nothing runs on a guess", () => {
    const started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    emit("tool", { requestId: lastRequestId(), name: "web.search" });
    expect(aborted).toEqual([lastRequestId()]);
    expect(brain.adoptDraft(started.draft.draftId, QUESTION)).toBe(false);
  });

  it("a model error ends the draft with no trace and no spoken failure", () => {
    const before = trace();
    const started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    emit("error", { requestId: lastRequestId(), error: "boom" });
    expect(brain.adoptDraft(started.draft.draftId, QUESTION)).toBe(false);
    expect(trace()).toBe(before);
    // and a new draft may start
    expect(brain.startDraft(QUESTION).started).toBe(true);
  });
});

describe("a draft reaches only a local or proven-free model", () => {
  it("is not started when only paid, unknown-cost or unavailable models exist", () => {
    rows = [PAID_CLOUD, UNKNOWN_CLOUD, row({ id: "off", available: false })];
    expect(brain.startDraft(QUESTION)).toEqual({
      started: false,
      reason: "no-local-or-free-model",
    });
    expect(sentChats).toEqual([]);
    rows = [];
    expect(brain.startDraft(QUESTION)).toEqual({
      started: false,
      reason: "no-local-or-free-model",
    });
    expect(sentChats).toEqual([]);
  });

  it("with a proven-free cloud model the draft goes out under free-only", () => {
    rows = [FREE_CLOUD];
    expect(brain.startDraft(QUESTION).started).toBe(true);
    const contract = sentChats[0]?.["routingContract"] as { routeMode: string };
    expect(contract.routeMode).not.toBe("cloud-only");
  });

  it("in privacy mode the route is local-only and private, and a free cloud model alone is not enough", () => {
    privacyMode = true;
    rows = [FREE_CLOUD];
    expect(brain.startDraft(QUESTION)).toEqual({
      started: false,
      reason: "no-local-or-free-model",
    });
    expect(sentChats).toEqual([]);
    rows = [FREE_CLOUD, LOCAL];
    expect(brain.startDraft(QUESTION).started).toBe(true);
    const request = sentChats[0]!;
    const contract = request["routingContract"] as {
      routeMode: string;
      costPolicy: string;
      requirements: { privacy?: string; locality?: string };
    };
    expect(contract.routeMode).toBe("local-only");
    expect(contract.costPolicy).toBe("free-only");
    expect(contract.requirements).toMatchObject({ privacy: "private", locality: "local" });
    expect(request["routeMode"]).toBe("local-only");
  });

  it("a sensitive line is never drafted, on any model", () => {
    rows = [LOCAL, FREE_CLOUD];
    expect(brain.startDraft("is my card number 4111 1111 1111 1111 valid?")).toEqual({
      started: false,
      reason: "sensitive",
    });
    expect(brain.startDraft("my password is hunter2, what is a prime number?")).toEqual({
      started: false,
      reason: "sensitive",
    });
    expect(sentChats).toEqual([]);
  });

  it("an order, a live-data question and an empty line are refused", () => {
    expect(brain.startDraft("delete my downloads folder?")).toMatchObject({
      started: false,
      reason: "not-a-plain-question",
    });
    expect(brain.startDraft("what is the weather in Jaipur today?")).toEqual({
      started: false,
      reason: "needs-live-data",
    });
    expect(brain.startDraft("   ")).toEqual({ started: false, reason: "empty" });
    expect(sentChats).toEqual([]);
  });

  it("is refused while a run is going, while an approval waits, and under Stop everything", () => {
    inner.state.activeRunId = "run-1";
    expect(brain.startDraft(QUESTION)).toEqual({ started: false, reason: "busy" });
    inner.state.activeRunId = null;
    inner.state.approval = { id: "a1" };
    expect(brain.startDraft(QUESTION)).toEqual({ started: false, reason: "approval-pending" });
    inner.state.approval = null;
    autonomy.stopEverything();
    expect(brain.startDraft(QUESTION)).toEqual({ started: false, reason: "stopped" });
    expect(sentChats).toEqual([]);
  });
});

describe("one draft at most, ten seconds to live", () => {
  it("a second draft is refused while one is live, allowed once it is discarded", () => {
    const first = brain.startDraft(QUESTION);
    if (!first.started) throw new Error("expected a draft");
    expect(brain.startDraft("what is an even number?")).toEqual({
      started: false,
      reason: "draft-live",
    });
    expect(sentChats).toHaveLength(1);
    expect(brain.discardDraft(first.draft.draftId)).toBe(true);
    expect(brain.startDraft("what is an even number?").started).toBe(true);
    expect(sentChats).toHaveLength(2);
  });

  it("dies after 10 s: the chat is aborted and nothing is left", () => {
    const before = trace();
    const first = brain.startDraft(QUESTION);
    if (!first.started) throw new Error("expected a draft");
    vi.advanceTimersByTime(DRAFT_TTL_MS - 1);
    expect(aborted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(aborted).toEqual([lastRequestId()]);
    expect(brain.adoptDraft(first.draft.draftId, QUESTION)).toBe(false);
    expect(trace()).toBe(before);
    expect(brain.startDraft(QUESTION).started).toBe(true);
  });

  it("an adoption after the time has run out is refused even if the timer never fired", () => {
    const first = brain.startDraft(QUESTION);
    if (!first.started) throw new Error("expected a draft");
    vi.setSystemTime(1_700_000_000_000 + DRAFT_TTL_MS + 1);
    expect(brain.adoptDraft(first.draft.draftId, QUESTION)).toBe(false);
  });
});

describe("discard leaves the state identical", () => {
  it("aborts the chat, drops late events, and the transcript and runs are as before", () => {
    const before = trace();
    const snapshotBefore = brain.getSnapshot();
    const started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    const requestId = lastRequestId();
    emit("delta", { requestId, modelId: "ollama/llama", text: "Half an ans" });
    expect(brain.discardDraft(started.draft.draftId)).toBe(true);
    expect(aborted).toEqual([requestId]);
    // late events of the aborted stream change nothing
    emit("delta", { requestId, modelId: "ollama/llama", text: "wer" });
    emit("done", { requestId, cancelled: true });
    expect(trace()).toBe(before);
    expect(brain.getSnapshot()).toBe(snapshotBefore);
    expect(brain.discardDraft(started.draft.draftId)).toBe(false);
  });

  it("Stop (all or foreground) and a real turn discard a live draft; a task stop does not", () => {
    const first = brain.startDraft(QUESTION);
    if (!first.started) throw new Error("expected a draft");
    brain.stop({ taskId: "t1" });
    expect(aborted).toEqual([]);
    brain.stop("foreground");
    expect(aborted).toEqual([lastRequestId()]);
    aborted.length = 0;
    expect(brain.startDraft(QUESTION).started).toBe(true);
    brain.stop();
    expect(aborted).toEqual([lastRequestId()]);
    aborted.length = 0;
    expect(brain.startDraft(QUESTION).started).toBe(true);
    // a real turn takes the lane: the guess is dropped
    vi.spyOn(coreBrain, "cognize").mockReturnValue(new Promise(() => undefined) as never);
    brain.send("explain how a transformer attention head works in detail please");
    expect(aborted).toHaveLength(1);
  });
});

describe("adoption: only the exact words, only when nothing else changed", () => {
  it("the same words promote the draft to a real run with the streamed answer", () => {
    const started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    const requestId = lastRequestId();
    emit("delta", { requestId, modelId: "ollama/llama", text: "A prime has two " });
    expect(brain.adoptDraft(started.draft.draftId, `  ${QUESTION}`)).toBe(true);
    const state = brain.getSnapshot();
    const run = state.runs[0]!;
    expect(state.activeRunId).toBe(run.id);
    expect(run.prompt).toBe(QUESTION);
    expect(run.owner).toBeUndefined();
    expect(state.messages.map((m) => [m.role, m.text, m.runId])).toEqual([
      ["user", QUESTION, run.id],
      ["friday", "A prime has two ", run.id],
    ]);
    // the rest of the stream lands in the real run through the ordinary handlers
    emit("delta", { requestId, modelId: "ollama/llama", text: "divisors." });
    emit("done", { requestId, modelId: "ollama/llama" });
    const finished = brain.getSnapshot();
    expect(finished.runs[0]!.answer).toBe("A prime has two divisors.");
    expect(finished.messages[finished.messages.length - 1]!.text).toBe("A prime has two divisors.");
    expect(sentChats).toHaveLength(1); // no second model call
    expect(aborted).toEqual([]);
  });

  it("a draft that finished before the owner did is adopted whole", () => {
    const started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    const requestId = lastRequestId();
    emit("delta", { requestId, modelId: "ollama/llama", text: "Two divisors." });
    emit("done", { requestId, modelId: "ollama/llama" });
    expect(brain.adoptDraft(started.draft.draftId, QUESTION)).toBe(true);
    const state = brain.getSnapshot();
    expect(state.runs[0]!.answer).toBe("Two divisors.");
    expect(state.messages.map((m) => m.text)).toEqual([QUESTION, "Two divisors."]);
  });

  it("different words discard the draft: false, aborted, no trace", () => {
    const before = trace();
    const started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    emit("delta", { requestId: lastRequestId(), text: "Two divisors." });
    expect(brain.adoptDraft(started.draft.draftId, "what is a prime number")).toBe(false);
    expect(aborted).toEqual([lastRequestId()]);
    expect(trace()).toBe(before);
    expect(brain.adoptDraft(started.draft.draftId, QUESTION)).toBe(false);
  });

  it("an unknown draft id is false and discards nothing", () => {
    const started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    expect(brain.adoptDraft("draft-nope", QUESTION)).toBe(false);
    expect(aborted).toEqual([]);
    expect(brain.discardDraft(started.draft.draftId)).toBe(true);
  });

  it("is refused (and the draft dropped) when privacy mode came on, or Stop everything, or a run took the lane", () => {
    rows = [FREE_CLOUD];
    let started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    privacyMode = true;
    expect(brain.adoptDraft(started.draft.draftId, QUESTION)).toBe(false);
    privacyMode = false;

    started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    autonomy.stopEverything();
    expect(brain.adoptDraft(started.draft.draftId, QUESTION)).toBe(false);
    autonomy.reset();

    started = brain.startDraft(QUESTION);
    if (!started.started) throw new Error("expected a draft");
    inner.state.activeRunId = "run-1";
    expect(brain.adoptDraft(started.draft.draftId, QUESTION)).toBe(false);
    expect(inner.state.runs).toEqual([]);
    expect(aborted).toHaveLength(3);
  });

  it("Hindi and Unicode words adopt on equality only", () => {
    const hindi = "भारत की राजधानी क्या है?";
    const started = brain.startDraft(hindi);
    if (!started.started) throw new Error("expected a draft");
    expect(brain.adoptDraft(started.draft.draftId, hindi)).toBe(true);
  });
});

describe("the source keeps the draft branch ahead of any run", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../src/lib/friday/brain-engine.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("send() leaves for the draft before startRun, with the privacy, sensitive and local-or-free checks in it", () => {
    const sendAt = source.indexOf("\n  send(");
    const body = source.slice(sendAt, source.indexOf("this.startRun(", sendAt));
    const draftAt = body.indexOf("rawOptions.draft");
    expect(draftAt).toBeGreaterThan(-1);
    const branch = body.slice(draftAt);
    expect(branch).toMatch(/privacyMode/);
    expect(branch).toMatch(/looksSensitive\(/);
    expect(branch).toMatch(/local/);
    expect(branch).toMatch(/return/);
    // it comes before the prompt-named model pin, the task preference and the busy check
    expect(draftAt).toBeLessThan(body.indexOf("promptRouting("));
  });

  it("the draft path never reaches the memory, history, approval or Core Brain writers (adoption is the one place that makes a run)", () => {
    const methodBody = (declaration: RegExp) => {
      const at = source.search(declaration);
      expect(at, String(declaration)).toBeGreaterThan(-1);
      const open = source.indexOf("{", source.indexOf(")", at));
      let depth = 0;
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}" && (depth -= 1) === 0) return source.slice(open, i + 1);
      }
      return "";
    };
    const bodies = [
      /\n {2}startDraft\(/,
      /\n {2}discardDraft\(/,
      /\n {2}private dropDraft\(/,
      /\n {2}private noteDraftEvent\(/,
      /\n {2}private beginDraft\(/,
    ].map(methodBody);
    for (const body of bodies) {
      for (const forbidden of [
        "this.persist(",
        "this.recordTurn(",
        "memoryStore",
        "pendingAction",
        "state.approval =",
        "this.state.messages =",
        "this.state.runs =",
        "this.emit(",
        "coreBrain.cognize",
        "writeState(",
        "this.startRun(",
      ]) {
        expect(body, forbidden).not.toContain(forbidden);
      }
    }
    expect(bodies.join("\n")).toContain("quickLaneEligible(");
  });
});
