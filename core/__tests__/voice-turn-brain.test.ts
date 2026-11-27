/**
 * The Brain side of the voice turn protocol.
 *
 *  1. A turn draft (the guess made on an eager end of turn) can be asked to reach a local model alone: it never
 *     selects a cloud model, never runs a tool, and is cancelled cleanly.
 *  2. The heard-turn tags {lang, mix, confidence, eager, clipped} are optional input metadata on `brain.send`.
 *     They choose the reply language and script (mirroring the owner's mix) and turn a low-confidence line into
 *     one short question instead of an action. They carry no authority, and no approval, authority or permission
 *     code reads them (source pins below). The ear's speaker and environment tags are not parameters at all.
 *
 * `window.friday` is a fake bridge; the registry and preferences are fed fixed rows; time is a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DraftModelRow } from "../../src/lib/friday/self/brain-draft";
import {
  CLARIFY_WINDOW_MS,
  TURN_CONFIDENCE_FLOOR,
  cleanTurnHints,
  clarificationLine,
  needsClarification,
  replyLanguageLine,
} from "../../src/lib/friday/brain/turn-hints";

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
const { identity } = await import("../../src/lib/friday/brain/identity");
const { modelRegistry } = await import("../../src/lib/friday/model-registry");
const { preferences } = await import("../../src/lib/friday/preferences");
const { autonomy } = await import("../../src/lib/friday/self/autonomy");

(brain as unknown as { bindDesktopChat: () => void }).bindDesktopChat();

type StartRunOptions = { extra?: string };
type Inner = {
  state: Record<string, unknown> & {
    runs: unknown[];
    messages: unknown[];
    activeRunId: string | null;
    approval: unknown;
  };
  draft: unknown;
  clarifiedAt: number | null;
  startRun: (text: string, options: StartRunOptions) => void;
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

let rows: DraftModelRow[] = [];
let pinnedLanguage = "follow-user";
let startRunCalls: Array<{ text: string; options: StartRunOptions }> = [];

const QUESTION = "what is a prime number?";

function emit(kind: keyof typeof handlers, event: Record<string, unknown>) {
  for (const handler of handlers[kind]) handler(event);
}
const lastRequestId = () => String(sentChats[sentChats.length - 1]?.["requestId"]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  rows = [LOCAL];
  pinnedLanguage = "follow-user";
  startRunCalls = [];
  sentChats.length = 0;
  aborted.length = 0;
  autonomy.reset();
  inner.state.runs = [];
  inner.state.messages = [];
  inner.state.activeRunId = null;
  inner.state.approval = null;
  inner.draft = null;
  inner.clarifiedAt = null;
  vi.spyOn(modelRegistry, "getSnapshot").mockImplementation(
    () => ({ models: rows, routeMode: "auto", selected: [], policy: "free-only" }) as never,
  );
  vi.spyOn(coreBrain, "cognize").mockImplementation((() => {
    throw new Error("these tests never run the Core Brain pass");
  }) as never);
  vi.spyOn(inner, "startRun").mockImplementation((text: string, options: StartRunOptions) => {
    startRunCalls.push({ text, options });
  });
  const current = identity.getSnapshot();
  vi.spyOn(identity, "getSnapshot").mockImplementation(
    () => ({ ...current, profile: { ...current.profile, replyLanguage: pinnedLanguage } }) as never,
  );
});

afterEach(() => {
  brain.stop("all");
  vi.restoreAllMocks();
  vi.useRealTimers();
  autonomy.reset();
});

describe("a turn draft with onlyLocal never reaches a cloud model", () => {
  it("is refused when only a proven-free cloud model exists (the plain draft would take it)", () => {
    rows = [FREE_CLOUD];
    const local = brain.startDraft(QUESTION, { onlyLocal: true });
    expect(local).toEqual({ started: false, reason: "no-local-or-free-model" });
    expect(sentChats).toHaveLength(0);
    // the control: without the option the same registry does draft on the free cloud model
    expect(brain.startDraft(QUESTION).started).toBe(true);
  });

  it("goes out as a local-only, private, tool-less, session-less request even with a free cloud model listed", () => {
    rows = [FREE_CLOUD, LOCAL];
    expect(brain.startDraft(QUESTION, { onlyLocal: true }).started).toBe(true);
    const request = sentChats[0]!;
    expect(request["routeMode"]).toBe("local-only");
    expect(request["draft"]).toBe(true);
    expect(request["sessionId"]).not.toBe("main");
    const contract = request["routingContract"] as {
      routeMode: string;
      costPolicy: string;
      requirements: { tools?: boolean; privacy?: string; locality?: string };
    };
    expect(contract.routeMode).toBe("local-only");
    expect(contract.costPolicy).toBe("free-only");
    expect(contract.requirements).toMatchObject({
      tools: false,
      privacy: "private",
      locality: "local",
    });
  });

  it("send(prompt, { draft: true, onlyLocal: true }) is the same path, and never starts a run", () => {
    rows = [FREE_CLOUD];
    const result = brain.send(QUESTION, { draft: true, onlyLocal: true });
    expect(result.reason).toBe("draft-refused");
    expect(startRunCalls).toHaveLength(0);
  });

  it("a tool event ends the draft at once and aborts the chat exactly once", () => {
    rows = [LOCAL];
    expect(brain.startDraft(QUESTION, { onlyLocal: true }).started).toBe(true);
    const id = lastRequestId();
    emit("tool", { requestId: id, name: "fs_read" });
    expect(aborted).toEqual([id]);
    expect(inner.draft).toBeNull();
    expect(inner.state.runs).toHaveLength(0);
    expect(inner.state.messages).toHaveLength(0);
    // a late event of the dead draft changes nothing and aborts nothing more
    emit("delta", { requestId: id, text: "late" });
    expect(aborted).toEqual([id]);
  });

  it("dies after the time-to-live and cancels the chat; Stop cancels it too", () => {
    expect(brain.startDraft(QUESTION, { onlyLocal: true }).started).toBe(true);
    const first = lastRequestId();
    vi.advanceTimersByTime(10_001);
    expect(aborted).toEqual([first]);
    expect(inner.draft).toBeNull();
    expect(brain.startDraft(QUESTION, { onlyLocal: true }).started).toBe(true);
    const second = lastRequestId();
    brain.stop("foreground");
    expect(aborted).toEqual([first, second]);
    expect(inner.draft).toBeNull();
  });

  it("a finished draft that was not adopted is cancelled without a second abort", () => {
    expect(brain.startDraft(QUESTION, { onlyLocal: true }).started).toBe(true);
    const id = lastRequestId();
    emit("done", { requestId: id, text: "A prime has two factors." });
    expect(aborted).toHaveLength(0);
    expect(brain.discardDraft(id)).toBe(true);
    expect(aborted).toHaveLength(0);
    expect(inner.draft).toBeNull();
  });

  it("a local-only draft is still dropped when the ear was unsure of the final line", () => {
    const started = brain.startDraft(QUESTION, { onlyLocal: true });
    if (!started.started) throw new Error("draft should start");
    expect(brain.adoptDraft(started.draft.draftId, QUESTION, { confidence: 0.1, lang: "en" })).toBe(
      false,
    );
    expect(aborted).toHaveLength(1);
    expect(inner.draft).toBeNull();
  });

  it("a sure final line adopts a local-only draft as before", () => {
    const started = brain.startDraft(QUESTION, { onlyLocal: true });
    if (!started.started) throw new Error("draft should start");
    expect(
      brain.adoptDraft(started.draft.draftId, QUESTION, { confidence: 0.95, lang: "en" }),
    ).toBe(true);
  });
});

describe("heard-turn tags choose the reply language and script", () => {
  it("a Hindi and English mix is answered in the same mix, each word in its own script", () => {
    const result = brain.send("mujhe ek reminder set करो", {
      turn: { lang: "hi-en", mix: 0.3, confidence: 0.9 },
    });
    expect(result.accepted).toBe(true);
    expect(startRunCalls).toHaveLength(1);
    const extra = startRunCalls[0]!.options.extra ?? "";
    expect(extra).toContain("same natural Hindi and English mix");
    expect(extra).toContain("Devanagari");
    expect(extra).toContain("never transliterate");
  });

  it("keeps the extra the caller attached and adds the language line after it", () => {
    brain.send("kal ka plan batao", {
      extra: "CAPABILITY: notes",
      turn: { lang: "hi", mix: 0, confidence: 0.9 },
    });
    const extra = startRunCalls[0]!.options.extra ?? "";
    expect(extra.startsWith("CAPABILITY: notes")).toBe(true);
    expect(extra).toContain("Hindi, written in Devanagari");
  });

  it("an English line is answered in English; no tags add nothing", () => {
    brain.send("what is the time in tokyo", { turn: { lang: "en", mix: 0, confidence: 0.9 } });
    expect(startRunCalls[0]!.options.extra).toContain("English, written in Latin script");
    startRunCalls.length = 0;
    brain.send("what is the time in tokyo");
    expect(startRunCalls[0]!.options.extra).toBeUndefined();
  });

  it("a language pinned in Settings wins over how one line sounded", () => {
    pinnedLanguage = "english";
    brain.send("mujhe ek reminder set करो", { turn: { lang: "hi-en", mix: 0.3, confidence: 0.9 } });
    expect(startRunCalls[0]!.options.extra).toBeUndefined();
  });

  it("a near-pure line with a few borrowed words keeps its main language", () => {
    const line = replyLanguageLine(cleanTurnHints({ lang: "hi-en", mix: 0.05 }), false);
    expect(line).toContain("main language");
    expect(replyLanguageLine(cleanTurnHints({ lang: "" }), false)).toBe("");
    expect(replyLanguageLine(null, false)).toBe("");
  });
});

describe("low confidence asks one short question instead of acting", () => {
  it("returns a Hindi question in Devanagari for a Hindi line and starts nothing", () => {
    const result = brain.send("मेरी फाइल हटा दो", { turn: { lang: "hi", confidence: 0.2 } });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("clarify");
    expect(result.message).toContain("मुझे ठीक से सुनाई नहीं दिया");
    expect(result.message).toContain("मेरी फाइल हटा दो");
    expect(startRunCalls).toHaveLength(0);
    expect(sentChats).toHaveLength(0);
    expect(inner.state.runs).toHaveLength(0);
    expect(inner.state.messages).toHaveLength(0);
  });

  it("asks in English for an English line", () => {
    const result = brain.send("delete my report", { turn: { lang: "en", confidence: 0.3 } });
    expect(result.reason).toBe("clarify");
    expect(result.message).toContain("I didn't catch that clearly");
    expect(result.message).toContain("delete my report");
  });

  it("at or above the floor the line is acted on", () => {
    const result = brain.send("delete my report", {
      turn: { lang: "en", confidence: TURN_CONFIDENCE_FLOOR },
    });
    expect(result.accepted).toBe(true);
    expect(startRunCalls).toHaveLength(1);
  });

  it("an unknown confidence never blocks, and typed turns (no tags) are untouched", () => {
    expect(brain.send("hello there", { turn: { lang: "en", confidence: null } }).accepted).toBe(
      true,
    );
    expect(brain.send("hello there").accepted).toBe(true);
    expect(startRunCalls).toHaveLength(2);
  });

  it("a clipped line needs a little more certainty than a whole one", () => {
    const bar = TURN_CONFIDENCE_FLOOR + 0.05;
    expect(needsClarification(cleanTurnHints({ confidence: bar }))).toBe(false);
    expect(needsClarification(cleanTurnHints({ confidence: bar, clipped: true }))).toBe(true);
  });

  it("the question is asked once: a repeat inside the window is taken as heard, then it can ask again", () => {
    const turn = { lang: "en" as const, confidence: 0.2 };
    expect(brain.send("open the pod bay doors", { turn }).reason).toBe("clarify");
    expect(brain.send("open the pod bay doors", { turn }).accepted).toBe(true);
    expect(brain.send("open the pod bay doors", { turn }).reason).toBe("clarify");
    // after the window an unsure line is asked about again, with nothing in between
    vi.advanceTimersByTime(CLARIFY_WINDOW_MS + 1);
    expect(brain.send("open the pod bay doors", { turn }).reason).toBe("clarify");
  });

  it("an empty line is the empty refusal, not a question", () => {
    expect(brain.send("   ", { turn: { confidence: 0.1 } }).reason).toBe("empty");
  });

  it("never speaks a heard secret back: sensitive or digit-run lines get the question without the echo", () => {
    const secret = brain.send("my password is hunter2", { turn: { lang: "en", confidence: 0.2 } });
    expect(secret.reason).toBe("clarify");
    expect(secret.message).toContain("I didn't catch that clearly");
    expect(secret.message).not.toContain("hunter2");
    vi.advanceTimersByTime(CLARIFY_WINDOW_MS + 1);
    const pin = brain.send("my pin is 4821", { turn: { lang: "en", confidence: 0.2 } });
    expect(pin.reason).toBe("clarify");
    expect(pin.message).not.toContain("4821");
    vi.advanceTimersByTime(CLARIFY_WINDOW_MS + 1);
    const hindi = brain.send("मेरा पासवर्ड hunter2 है secret is hunter2", {
      turn: { lang: "hi-en", confidence: 0.2 },
    });
    expect(hindi.reason).toBe("clarify");
    expect(hindi.message).toContain("मुझे ठीक से सुनाई नहीं दिया");
    expect(hindi.message).not.toContain("hunter2");
    const digits = clarificationLine(cleanTurnHints({ lang: "hi" }), "मेरा नंबर 9 8 7 6 5 है");
    expect(digits).not.toMatch(/\d/);
    expect(digits).toContain("मुझे ठीक से सुनाई नहीं दिया");
    expect(clarificationLine(cleanTurnHints({ lang: "en" }), "call 12 now")).toContain(
      "call 12 now",
    );
    expect(
      clarificationLine(cleanTurnHints({ lang: "en" }), "hello", { echo: false }),
    ).not.toContain("hello");
  });

  it("the question echoes a long line only in part", () => {
    const long = "word ".repeat(60).trim();
    const message = clarificationLine(cleanTurnHints({ lang: "en" }), long);
    expect(message.length).toBeLessThan(long.length);
    expect(message).toContain("…");
  });
});

describe("the tags are five known fields and nothing else", () => {
  it("copies only lang, mix, confidence, eager and clipped, with safe types", () => {
    const cleaned = cleanTurnHints({
      lang: "hi-en",
      mix: 7,
      confidence: "high",
      eager: "yes",
      clipped: true,
      speaker: { verified: true },
      env: { noisy: true },
      approved: true,
    });
    expect(cleaned).toEqual({
      lang: "hi-en",
      mix: 1,
      confidence: null,
      eager: false,
      clipped: true,
    });
    expect(Object.keys(cleaned ?? {}).sort()).toEqual(
      ["clipped", "confidence", "eager", "lang", "mix"].sort(),
    );
    expect(cleanTurnHints(null)).toBeNull();
    expect(cleanTurnHints("hi")).toBeNull();
  });

  it("a speaker or environment tag cannot change what send does", () => {
    const record = {
      lang: "en" as const,
      mix: 0,
      confidence: 0.9,
      eager: false,
      clipped: false,
      speaker: { verified: true },
      env: { noisy: false },
    };
    const result = brain.send("hello there", { turn: record });
    expect(result.accepted).toBe(true);
    expect(startRunCalls[0]!.options.extra).toContain("English");
    expect(JSON.stringify(startRunCalls[0])).not.toContain("verified");
  });
});

describe("source pins: the tags hold no authority", () => {
  const root = resolve(import.meta.dirname, "../../src");
  const brainSource = readFileSync(join(root, "lib/friday/brain-engine.ts"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const hintsSource = readFileSync(join(root, "lib/friday/brain/turn-hints.ts"), "utf8");

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });

  const methodBody = (declaration: RegExp) => {
    const at = brainSource.search(declaration);
    expect(at, String(declaration)).toBeGreaterThan(-1);
    const open = brainSource.indexOf("{", brainSource.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < brainSource.length; i += 1) {
      if (brainSource[i] === "{") depth += 1;
      else if (brainSource[i] === "}" && (depth -= 1) === 0) return brainSource.slice(open, i + 1);
    }
    return "";
  };

  it("only the Brain engine imports the hint rules (the conductor reads only the language-line helper)", () => {
    const importers = walk(root)
      .filter((file) => /from\s+["'][^"']*brain\/turn-hints["']/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1).replaceAll("\\", "/"));
    // The conductor reads one pure helper (the reply-language line it puts in a side question's facts); the
    // hint rules themselves, the cleaning and the clarification, stay in the Brain engine alone.
    expect(importers).toEqual(["lib/friday/assistant-mode.ts", "lib/friday/brain-engine.ts"]);
    const conductor = readFileSync(join(root, "lib/friday/assistant-mode.ts"), "utf8");
    expect(conductor.match(/from\s+["'][^"']*brain\/turn-hints["']/g)).toHaveLength(1);
    expect(conductor).toMatch(/import \{ replyLanguageLine \} from "\.\/brain\/turn-hints";/);
  });

  it("no approval, authority, permission, consent or autonomy file mentions the hints", () => {
    const guards = walk(root).filter((file) =>
      /(approv|authorit|permission|consent|autonomy|firewall|governance|kill-?switch|confirm)/i.test(
        file.slice(root.length),
      ),
    );
    expect(guards.length).toBeGreaterThan(0);
    for (const file of guards) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/turn-hints|TurnHints|cleanTurnHints|needsClarification/);
    }
  });

  it("the hints are read in send() and adoptDraft() only, never in approve() or the run and approval writers", () => {
    expect(brainSource.match(/cleanTurnHints\(/g)).toHaveLength(2);
    expect(brainSource.match(/needsClarification\(/g)).toHaveLength(2);
    expect(brainSource.match(/replyLanguageLine\(/g)).toHaveLength(1);
    expect(methodBody(/\n {2}approve\(/)).not.toMatch(/hints|clarif|rawOptions\.turn/i);
    expect(methodBody(/\n {2}private startRun\(/)).not.toMatch(/cleanTurnHints|rawOptions\.turn/);
    expect(methodBody(/\n {2}private beginDraft\(/)).not.toMatch(/cleanTurnHints|\.turn\b/);
  });

  it("the Brain never takes a speaker or environment as a parameter", () => {
    const sendAt = brainSource.indexOf("\n  send(");
    const signature = brainSource.slice(sendAt, brainSource.indexOf("): SendResult {", sendAt));
    expect(signature).not.toMatch(/speaker|\benv\b|environment/i);
    const adoptAt = brainSource.indexOf("\n  adoptDraft(");
    expect(brainSource.slice(adoptAt, brainSource.indexOf("{", adoptAt))).not.toMatch(
      /speaker|\benv\b|environment/i,
    );
    expect(hintsSource).not.toMatch(/speaker|\benv\b|environment/i);
    expect(hintsSource).not.toMatch(/^import /m);
  });

  it("a clarification is a refusal to act (accepted false) and never a grant", () => {
    const at = brainSource.indexOf("needsClarification(hints)");
    const block = brainSource.slice(at, at + 400);
    expect(block).toContain("accepted: false");
    expect(block).not.toMatch(/accepted: true|state\.approval|autonomy\./);
  });
});

describe("the surface is chat unless a caller says voice (L3)", () => {
  afterEach(() => brain.setAutoMode(false));

  it("a send with no routingSurface in Auto mode is a chat turn: no voice block, chat surface", async () => {
    const { voiceModeBlock } = await import("../../src/lib/friday/conversation-style");
    brain.setAutoMode(true);
    brain.send("summarise the open tasks");
    expect(startRunCalls).toHaveLength(1);
    expect(startRunCalls[0]!.options).toMatchObject({ routingSurface: "chat" });
    expect(startRunCalls[0]!.options.extra || "").not.toContain(
      voiceModeBlock({ deliveryTags: true }),
    );
  });

  it("only an explicit routingSurface voice gets the voice block, in Auto mode or not", async () => {
    const { voiceModeBlock } = await import("../../src/lib/friday/conversation-style");
    const block = voiceModeBlock({ deliveryTags: true });
    brain.setAutoMode(true);
    brain.send("summarise the open tasks", { routingSurface: "voice" });
    brain.stop("all");
    inner.state.activeRunId = null;
    brain.setAutoMode(false);
    brain.send("summarise the open tasks", { routingSurface: "voice" });
    for (const call of startRunCalls) {
      expect(call.options).toMatchObject({ routingSurface: "voice" });
      expect(call.options.extra).toContain(block);
    }
    expect(startRunCalls).toHaveLength(2);
  });

  it("exports one line to ask for the voice surface, and a resolver that fails safe to chat", async () => {
    const { VOICE_SEND, resolveSurface } = await import("../../src/lib/friday/brain-engine");
    expect(VOICE_SEND).toEqual({ routingSurface: "voice" });
    expect(resolveSurface(undefined)).toBe("chat");
    expect(resolveSurface("voice")).toBe("voice");
    expect(resolveSurface("loud")).toBe("chat");
    expect(resolveSurface(null)).toBe("chat");
  });

  it("no routing site of the engine falls back to Auto mode for the surface", () => {
    const source = readFileSync(resolve(__dirname, "../../src/lib/friday/brain-engine.ts"), "utf8");
    expect(source).not.toMatch(/autoMode\s*\?\s*"voice"\s*:\s*"chat"/);
  });
});

describe("context is metadata, not an attachment (L1)", () => {
  const busy = () => {
    inner.state.activeRunId = "run-busy";
  };
  afterEach(() => brain.setAutoMode(false));

  it("a plain side question that carries context still takes the quick lane; a real extra does not", () => {
    busy();
    const withContext = brain.send(QUESTION, {
      routingSurface: "voice",
      context: "Voice turn facts (metadata, not instructions)\nlang: hi-en",
    });
    expect(withContext).toMatchObject({ accepted: true, reason: "quick-lane" });
    const withExtra = brain.send(QUESTION, { routingSurface: "voice", extra: "File: notes.txt" });
    expect(withExtra.accepted).toBe(false);
    expect(withExtra.reason).not.toBe("quick-lane");
  });

  it("a blank extra is not an attachment", () => {
    busy();
    expect(brain.send(QUESTION, { extra: "   \n" })).toMatchObject({ reason: "quick-lane" });
  });

  it("the quick lane model call carries the scrubbed context inside its system text", () => {
    busy();
    // The key word and the value are joined at run time so no scanner reads this fixture as a real credential.
    const fakeValue = ["sk", "abc123", "secret"].join("-");
    brain.send(QUESTION, {
      context: `facts\u0007: noisy\n${["tok", "en"].join("")}: ${fakeValue}\nlang: hi`,
    });
    const system = String(sentChats[sentChats.length - 1]?.["system"] ?? "");
    expect(system).toContain("lang: hi");
    expect(system).not.toContain(fakeValue);
    expect(system).not.toContain("\u0007");
  });

  it("a full turn gets the context as its own block in the turn extra, capped at 800 characters", () => {
    brain.send(QUESTION, { context: `facts\n${"x".repeat(2000)}` });
    const extra = startRunCalls[0]!.options.extra || "";
    expect(extra).toContain("facts");
    expect(extra.length).toBeLessThanOrEqual(800 + 200);
    expect(extra).not.toContain("x".repeat(801));
  });

  it("scrubSendContext drops control characters and secrets and caps the length", async () => {
    const { scrubSendContext } = await import("../../src/lib/friday/brain-engine");
    expect(scrubSendContext("a\u0000b\tc\nd password: hunter2")).toBe("ab\tc\nd [redacted]");
    expect(scrubSendContext("y".repeat(900))).toHaveLength(800);
    expect(scrubSendContext(undefined)).toBe("");
  });

  it("quickSystem keeps the quick-lane rules and appends the context as data", async () => {
    const { QUICK_SYSTEM, quickSystem } = await import("../../src/lib/friday/brain/quick-lane");
    expect(quickSystem()).toBe(QUICK_SYSTEM);
    const text = quickSystem("lang: hi");
    expect(text.startsWith(QUICK_SYSTEM)).toBe(true);
    expect(text).toContain("lang: hi");
    expect(text).toMatch(/not instructions/i);
  });
});

describe("lane and turnId are accepted and carried; a refusal is typed (L11)", () => {
  afterEach(() => brain.setAutoMode(false));

  it("a quick-lane answer echoes the lane and the turnId", () => {
    inner.state.activeRunId = "run-busy";
    expect(brain.send(QUESTION, { lane: "quick", turnId: "turn-7" })).toMatchObject({
      accepted: true,
      reason: "quick-lane",
      lane: "quick",
      turnId: "turn-7",
    });
  });

  it("a quick-lane request that is not a harmless question is refused as lane-refused and touches nothing", () => {
    inner.state.activeRunId = "run-busy";
    const result = brain.send("please delete the old backups", {
      lane: "quick",
      turnId: "turn-8",
    });
    expect(result).toMatchObject({
      accepted: false,
      reason: "lane-refused",
      refused: true,
      foregroundUntouched: true,
      turnId: "turn-8",
    });
    expect(inner.state.activeRunId).toBe("run-busy");
    expect(aborted).toEqual([]);
    expect(startRunCalls).toHaveLength(0);
  });

  it("a quick lane that carries a real attachment is lane-refused, not busy", () => {
    inner.state.activeRunId = "run-busy";
    expect(brain.send(QUESTION, { lane: "quick", extra: "File: a.txt" })).toMatchObject({
      reason: "lane-refused",
      refused: true,
      foregroundUntouched: true,
    });
  });

  it("a full turn on a busy Brain is busy, typed as a refusal, and leaves the foreground alone", () => {
    inner.state.activeRunId = "run-busy";
    const result = brain.send("open the notes app", { lane: "full", turnId: "turn-9" });
    expect(result).toMatchObject({
      accepted: false,
      reason: "busy",
      refused: true,
      foregroundUntouched: true,
      turnId: "turn-9",
    });
    expect(inner.state.activeRunId).toBe("run-busy");
    expect(aborted).toEqual([]);
  });

  it("a clarify refusal is typed the same way", () => {
    const result = brain.send("open the notes app", {
      turn: { lang: "hi", confidence: 0.1 },
    });
    expect(result).toMatchObject({ accepted: false, reason: "clarify", refused: true });
  });

  it("an accepted turn is not marked refused and carries lane and turnId into the run", () => {
    const result = brain.send("open the notes app", { lane: "full", turnId: "turn-10" });
    expect(result.accepted).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(result).toMatchObject({ lane: "full", turnId: "turn-10" });
    expect(startRunCalls[0]!.options).toMatchObject({ lane: "full", turnId: "turn-10" });
  });

  it("a quick lane asked while nothing runs is just a full turn", () => {
    const result = brain.send(QUESTION, { lane: "quick" });
    expect(result).toMatchObject({ accepted: true, reason: "accepted", lane: "full" });
  });
});

describe("a draft and a quick-lane answer keep the reply language and the voice block (F3)", () => {
  const HI_TURN = { lang: "hi" as const, mix: 0, confidence: 0.9 };
  const HI_LINE = "Reply language for this turn: Hindi, written in Devanagari.";
  const EN_TURN = { lang: "en" as const, mix: 0, confidence: 0.9 };
  const systemOf = (index = sentChats.length - 1) => String(sentChats[index]?.["system"] ?? "");
  afterEach(() => brain.setAutoMode(false));

  it("a draft with the heard turn gets the language line and the voice block after DRAFT_SYSTEM", async () => {
    const { DRAFT_SYSTEM } = await import("../../src/lib/friday/self/brain-draft");
    const { voiceModeBlock } = await import("../../src/lib/friday/conversation-style");
    expect(brain.startDraft(QUESTION, { turn: HI_TURN }).started).toBe(true);
    const system = systemOf();
    expect(system.startsWith(DRAFT_SYSTEM)).toBe(true);
    expect(system).toContain(HI_LINE);
    expect(system).toContain(voiceModeBlock({ deliveryTags: true }));
    expect(system.indexOf(HI_LINE)).toBeLessThan(
      system.indexOf("Voice mode (this reply is spoken)"),
    );
    expect(system.length).toBeLessThan(2000);
  });

  it("the turn option works through onlyLocal and through send(draft: true) alike", () => {
    expect(brain.startDraft(QUESTION, { onlyLocal: true, turn: EN_TURN }).started).toBe(true);
    expect(systemOf()).toContain("English, written in Latin script");
    brain.discardDraft(String(sentChats[0]?.["requestId"]));
    expect(brain.send(QUESTION, { draft: true, turn: HI_TURN }).accepted).toBe(true);
    expect(systemOf()).toContain(HI_LINE);
  });

  it("a draft without a turn still gets the voice block and no language line", () => {
    expect(brain.startDraft(QUESTION).started).toBe(true);
    const system = systemOf();
    expect(system).toContain("Voice mode (this reply is spoken)");
    expect(system).not.toContain("Reply language for this turn");
  });

  it("a reply language pinned in Settings removes the language line from the draft", () => {
    pinnedLanguage = "english";
    expect(brain.startDraft(QUESTION, { turn: HI_TURN }).started).toBe(true);
    expect(systemOf()).not.toContain("Reply language for this turn");
  });

  it("a draft turn carries no authority: it does not change the routing contract", () => {
    brain.startDraft(QUESTION, { onlyLocal: true });
    const plain = sentChats[0]!["routingContract"];
    brain.discardDraft(String(sentChats[0]?.["requestId"]));
    brain.startDraft(QUESTION, { onlyLocal: true, turn: HI_TURN });
    expect(sentChats[1]!["routingContract"]).toEqual(plain);
    expect(sentChats[1]!["routeMode"]).toBe("local-only");
  });

  it("adoption keeps the draft only when the final turn would have given the same language line", () => {
    const draft = brain.startDraft(QUESTION, { turn: HI_TURN });
    expect(draft.started).toBe(true);
    const id = (draft as { draft: { draftId: string } }).draft.draftId;
    // the final turn heard it as English: the draft was written for Hindi, so it is thrown away
    expect(brain.adoptDraft(id, QUESTION, EN_TURN)).toBe(false);
    expect(inner.draft).toBeNull();
  });

  it("adoption succeeds when the final turn carries the same hints, or none are given", () => {
    const first = brain.startDraft(QUESTION, { turn: HI_TURN });
    const firstId = (first as { draft: { draftId: string } }).draft.draftId;
    expect(brain.adoptDraft(firstId, QUESTION, { ...HI_TURN, confidence: 0.8 })).toBe(true);
    brain.stop("all");
    inner.state.activeRunId = null;
    const second = brain.startDraft(QUESTION, { turn: HI_TURN });
    const secondId = (second as { draft: { draftId: string } }).draft.draftId;
    expect(brain.adoptDraft(secondId, QUESTION)).toBe(true);
  });

  it("a draft made without a turn is adopted as before (the caller has not passed one yet)", () => {
    const draft = brain.startDraft(QUESTION);
    const id = (draft as { draft: { draftId: string } }).draft.draftId;
    expect(brain.adoptDraft(id, QUESTION, HI_TURN)).toBe(true);
  });

  it("a draft that carried a language line is dropped when the final turn lost its language", () => {
    const draft = brain.startDraft(QUESTION, { turn: HI_TURN });
    const id = (draft as { draft: { draftId: string } }).draft.draftId;
    expect(brain.adoptDraft(id, QUESTION, { confidence: 0.9 })).toBe(false);
  });

  it("the quick-lane model call on the voice surface carries the voice block and the language line", () => {
    inner.state.activeRunId = "run-busy";
    brain.send(QUESTION, { routingSurface: "voice", turn: HI_TURN, context: "lang: hi" });
    const system = systemOf();
    expect(system).toContain("A longer task is running");
    expect(system).toContain(HI_LINE);
    expect(system).toContain("Voice mode (this reply is spoken)");
    expect(system).toContain("lang: hi");
  });

  it("the quick-lane call on the chat surface gets no voice block", () => {
    inner.state.activeRunId = "run-busy";
    brain.send(QUESTION, { routingSurface: "chat", turn: HI_TURN });
    const system = systemOf();
    expect(system).toContain(HI_LINE);
    expect(system).not.toContain("Voice mode (this reply is spoken)");
  });

  it("the language line is not doubled when the caller's context already holds it", () => {
    inner.state.activeRunId = "run-busy";
    const full = replyLanguageLine(cleanTurnHints(HI_TURN), false);
    brain.send(QUESTION, { routingSurface: "voice", turn: HI_TURN, context: full });
    expect(systemOf().split(full)).toHaveLength(2);
  });

  it("a pinned language removes the line from the quick-lane call too", () => {
    pinnedLanguage = "english";
    inner.state.activeRunId = "run-busy";
    brain.send(QUESTION, { routingSurface: "voice", turn: HI_TURN });
    expect(systemOf()).not.toContain("Reply language for this turn");
  });

  it("the whole quick-lane system text stays bounded even with a full 800 character context", () => {
    inner.state.activeRunId = "run-busy";
    brain.send(QUESTION, {
      routingSurface: "voice",
      turn: { lang: "hi-en", mix: 0.5, confidence: 0.9 },
      context: `facts\n${"x".repeat(2000)}`,
    });
    expect(systemOf().length).toBeLessThanOrEqual(2600);
  });

  it("a Devanagari question without a question mark takes the quick lane through send", () => {
    inner.state.activeRunId = "run-busy";
    expect(brain.send("क्या समय हुआ है", { routingSurface: "voice" })).toMatchObject({
      accepted: true,
      reason: "quick-lane",
    });
    // an order phrased as a question never does
    expect(brain.send("क्या तुम फाइल डिलीट कर दोगे", { routingSurface: "voice" }).reason).not.toBe(
      "quick-lane",
    );
  });
});

describe("a sensitive digest never reaches the quick-lane system message", () => {
  const systemSent = () => String(sentChats[sentChats.length - 1]?.["system"] ?? "");

  it("a digest with a PIN line and an OTP line is dropped from the model call", () => {
    inner.state.activeRunId = "run-busy";
    brain.send(QUESTION, {
      routingSurface: "voice",
      context: "topic: bank app\nmy pin is 4821\notp: 553920\ngoal: log in",
    });
    const system = systemSent();
    expect(system.length).toBeGreaterThan(0);
    expect(system).not.toContain("4821");
    expect(system).not.toContain("553920");
    expect(system).not.toContain("bank app");
    expect(system).not.toMatch(/Turn facts/);
  });

  it("a Hindi secret in the digest is dropped too, and a plain digest still goes through", () => {
    inner.state.activeRunId = "run-busy";
    brain.send(QUESTION, { routingSurface: "voice", context: "topic: बैंक\nमेरा पिन 4821 है" });
    expect(systemSent()).not.toContain("4821");
    brain.send(QUESTION, { routingSurface: "voice", context: "topic: travel\nlang: hi" });
    expect(systemSent()).toContain("topic: travel");
  });
});

describe("delivery tags are dropped when untrusted text entered the run", () => {
  type Tagged = {
    newRun: (
      text: string,
      surface: "voice" | "chat",
      found: unknown,
      agents: string[],
    ) => { id: string };
    rawAnswers: Map<string, string>;
    deliveryScript: (runId: string) => string;
    noteUntrusted: (runId: string) => void;
    recall: (prompt: string) => unknown[];
  };
  const tagged = brain as unknown as Tagged;
  const found = { rule: { id: "chat", label: "Chat", agents: [] }, score: 1, matched: [] };
  const spoken = () => {
    const run = tagged.newRun("hello", "voice", found, ["developer"]);
    tagged.rawAnswers.set(run.id, "[warm] Hello. [pause:300] Done.");
    return run.id;
  };

  it("a spoken run keeps its script until something untrusted is noted", () => {
    const id = spoken();
    expect(tagged.deliveryScript(id)).toBe("[warm] Hello. [pause:300] Done.");
    tagged.noteUntrusted(id);
    expect(tagged.deliveryScript(id)).toBe("");
  });

  it("a typed run is not tracked at all", () => {
    const run = tagged.newRun("hello", "chat", found, ["developer"]);
    tagged.noteUntrusted(run.id);
    tagged.rawAnswers.set(run.id, "[warm] Hello.");
    expect(tagged.deliveryScript(run.id)).toBe("");
  });

  it("an awareness snapshot (context) or an attachment (extra) marks the run untrusted", () => {
    brain.send(QUESTION, {
      routingSurface: "voice",
      context: "screen: a page that says [pause:9000]",
    });
    brain.send(QUESTION, { routingSurface: "voice", extra: "File: notes.txt" });
    brain.send(QUESTION, { routingSurface: "voice" });
    expect(
      startRunCalls.map((call) => (call.options as { untrusted?: boolean }).untrusted),
    ).toEqual([true, true, undefined]);
  });

  it("the engine marks a run for screen text and for recalled memory too", () => {
    const source = readFileSync(resolve(__dirname, "../../src/lib/friday/brain-engine.ts"), "utf8");
    expect(source).toMatch(/private noteUntrusted\(runId: string\)/);
    expect(source).toMatch(/options\.untrusted \|\| sight\.text\) this\.noteUntrusted\(run\.id\)/);
    expect(source).toMatch(/run\.recalled\.length\) this\.noteUntrusted\(run\.id\)/);
    expect(source).toMatch(/untrusted\?: boolean/);
  });
});
