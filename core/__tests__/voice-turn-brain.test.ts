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

  it("no source file except the Brain engine imports the hint rules", () => {
    const importers = walk(root)
      .filter((file) => /from\s+["'][^"']*brain\/turn-hints["']/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(root.length + 1).replaceAll("\\", "/"));
    expect(importers).toEqual(["lib/friday/brain-engine.ts"]);
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
