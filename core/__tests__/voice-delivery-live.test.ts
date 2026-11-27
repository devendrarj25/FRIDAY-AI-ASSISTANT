/**
 * Delivery tags, live: what the model writes for a spoken turn keeps its tags only on the way to the voice.
 *
 *  1. Pure helpers: a tag split across stream chunks is held back until whole, anchors put the tags back into the
 *     sentences cut from the shown text, and nothing is put back when the shown words were rewritten.
 *  2. The Brain: every place the reply is shown, kept or remembered gets the stripped text, while the script of a
 *     spoken run stays readable for the speech path only.
 *  3. The conductor: tags reach the voice for the assistant's own reply in Auto mode only (source-pinned; the
 *     speaker cannot run here).
 *  4. The clause rule: the first clause and an almost-dry speaker choose the short cut.
 *
 * `window.friday` is a fake bridge and nothing here reads the clock, the network or a model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OPEN_TAG_HOLD_CHARS,
  alignedAnchors,
  reinsertParts,
  reinsertTags,
  stripDeliveryTags,
  stripDeliveryTagsLive,
  tagAnchors,
  tagsForSpeech,
  wordChars,
} from "../../src/lib/friday/voice-engine/delivery-tags";
import { pickClauseRule } from "../../src/lib/friday/voice-engine/streaming-speak";
import { firstClauseCut } from "../../src/lib/friday/voice-engine/clause-chunker";
import { takeSpeakable } from "../../src/lib/friday/voice-session";

const root = resolve(import.meta.dirname, "../..");
const source = (rel: string) => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");

describe("a tag split across stream chunks", () => {
  it("is held off the screen until it closes", () => {
    expect(stripDeliveryTagsLive("Hello [wa")).toBe("Hello ");
    expect(stripDeliveryTagsLive("Hello [warm")).toBe("Hello ");
    expect(stripDeliveryTagsLive("Hello [warm] there")).toBe("Hello there");
  });

  it("never shows a bracket at any split point of a tagged reply", () => {
    const reply = "[warm] Namaste, kaise hain aap. [pause:300] Main yahin hoon. [soft] Boliye.";
    for (let at = 1; at <= reply.length; at += 1) {
      const shown = stripDeliveryTagsLive(reply.slice(0, at));
      expect(shown, `cut at ${at}`).not.toMatch(/\[(?:warm|soft|pause)/);
    }
  });

  it("shows more text as it arrives, never less than before a tag closes", () => {
    const reply = "Hello there. [warm] How are you today? [pause:200] Good.";
    let before = "";
    for (let at = 1; at <= reply.length; at += 1) {
      const shown = stripDeliveryTagsLive(reply.slice(0, at));
      // trailing space may come and go while a tag is open; the words never go backwards
      expect(shown.replace(/\s+/g, "").startsWith(before.replace(/\s+/g, ""))).toBe(true);
      before = shown;
    }
    expect(stripDeliveryTagsLive(reply)).toBe("Hello there. How are you today? Good.");
  });

  it("shows an unfinished bracket once it is longer than the hold, because it is not a tag", () => {
    const long = `See [${"x".repeat(OPEN_TAG_HOLD_CHARS)}`;
    expect(stripDeliveryTagsLive(long)).toBe(long);
    expect(stripDeliveryTagsLive("a [1]")).toBe("a [1]");
    expect(stripDeliveryTagsLive("a [note] b")).toBe("a [note] b");
  });

  it("flushes a bracket that never closed once the reply is over", () => {
    expect(stripDeliveryTagsLive("Cost is [about")).toBe("Cost is ");
    expect(stripDeliveryTags("Cost is [about")).toBe("Cost is [about");
  });

  it("leaves text with no bracket alone, with no work", () => {
    expect(stripDeliveryTagsLive("plain words")).toBe("plain words");
    expect(stripDeliveryTagsLive("")).toBe("");
  });
});

describe("anchors put the tags back where the model wrote them", () => {
  const raw = "[warm] Namaste, kaise hain aap. [pause:300] Main yahin hoon. Boliye.";

  it("count the non-space characters before each tag of the stripped text", () => {
    const shown = stripDeliveryTags(raw);
    expect(shown).toBe("Namaste, kaise hain aap. Main yahin hoon. Boliye.");
    expect(tagAnchors(raw)).toEqual([
      { at: 0, tag: "[warm]" },
      { at: wordChars("Namaste, kaise hain aap."), tag: "[pause:300]" },
    ]);
  });

  it("fit the sentences cut from the shown text", () => {
    const shown = stripDeliveryTags(raw);
    const anchors = alignedAnchors(raw, shown);
    const sentences = shown.match(/[^.]+\./g)?.map((part) => part.trim()) ?? [];
    expect(sentences).toHaveLength(3);
    let before = "";
    const back: string[] = [];
    for (const sentence of sentences) {
      back.push(...reinsertParts([sentence], before, anchors));
      before = `${before}${before ? " " : ""}${sentence}`;
    }
    expect(back).toEqual([
      "[warm] Namaste, kaise hain aap.",
      "[pause:300] Main yahin hoon.",
      "Boliye.",
    ]);
  });

  it("a tag in the middle of a sentence goes back in the middle", () => {
    const text = "Hello [pause:250] there my friend.";
    const shown = stripDeliveryTags(text);
    expect(shown).toBe("Hello there my friend.");
    expect(reinsertTags(shown, 0, tagAnchors(text))).toBe("Hello [pause:250] there my friend.");
  });

  it("a tag at the end of a piece belongs to the next piece, and at the end of the reply to none", () => {
    const text = "One two. [calm] Three four. [pause:300]";
    const shown = stripDeliveryTags(text);
    const anchors = tagAnchors(text);
    expect(reinsertTags("One two.", 0, anchors)).toBe("One two.");
    expect(reinsertTags("Three four.", wordChars("One two."), anchors)).toBe("[calm] Three four.");
  });

  it("two tags at one place stay together in order", () => {
    const text = "[soft] [pause:200] Hello there.";
    expect(reinsertTags("Hello there.", 0, tagAnchors(text))).toBe(
      "[soft] [pause:200] Hello there.",
    );
  });

  it("are dropped when the shown words are not the words the model wrote", () => {
    expect(alignedAnchors("[warm] Hello there.", "Hello there.")).toHaveLength(1);
    expect(alignedAnchors("[warm] Hello there.", "Hi there.")).toEqual([]);
    expect(alignedAnchors("[warm] Hello there. More.", "Hello there.")).toHaveLength(1);
    expect(alignedAnchors("", "Hello")).toEqual([]);
    expect(alignedAnchors("[warm] Hello", "")).toEqual([]);
  });

  it("do not carry a tag that is not an allowed one", () => {
    expect(tagAnchors("[note] Hello [pause:abc] there [sigh].")).toEqual([
      { at: wordChars("[note]Hello there"), tag: "[sigh]" },
    ]);
  });

  it("make the pieces of one cut, in order, with a running base", () => {
    const text = "[warm] Hello there my dear friend, how are you.";
    const shown = stripDeliveryTags(text);
    const parts = ["Hello there my dear", "friend, how are you."];
    expect(reinsertParts(parts, "", tagAnchors(text))).toEqual([
      "[warm] Hello there my dear",
      "friend, how are you.",
    ]);
    expect(reinsertParts(parts, "", [])).toEqual(parts);
    expect(shown).toBe("Hello there my dear friend, how are you.");
  });
});

describe("text that is not the assistant's own never keeps a tag", () => {
  it("a tool, web or file line loses every tag, a voice-mode assistant line keeps the allowed ones", () => {
    const line = "The page says [warm] click [pause:9000] here.";
    for (const author of ["tool", "web", "file", "user", "other"] as const) {
      expect(tagsForSpeech(line, { author, voiceMode: true })).toBe("The page says click here.");
    }
    expect(tagsForSpeech(line, { author: "assistant", voiceMode: false })).toBe(
      "The page says click here.",
    );
    expect(tagsForSpeech(line, { author: "assistant", voiceMode: true })).toContain("[warm]");
  });
});

describe("which rule cuts the next clause", () => {
  it("the first clause uses the small rule only when the owner asked for the fast start", () => {
    const base = { underrunRisk: false, queued: 0 } as const;
    expect(pickClauseRule({ ...base, firstOfReply: true, fastFirst: true })).toBe("first");
    expect(pickClauseRule({ ...base, firstOfReply: true, fastFirst: false })).toBe("sentence");
  });

  it("a later clause is cut short only while the speaker is almost dry and nothing waits", () => {
    const later = { firstOfReply: false, fastFirst: true } as const;
    expect(pickClauseRule({ ...later, underrunRisk: true, queued: 0 })).toBe("underrun");
    expect(pickClauseRule({ ...later, underrunRisk: true, queued: 2 })).toBe("sentence");
    expect(pickClauseRule({ ...later, underrunRisk: false, queued: 0 })).toBe("sentence");
  });

  it("the short cut closes a clause of four to six words before the sentence is over", () => {
    const pending = "Let me check the calendar now, and then I will tell you more";
    const cut = firstClauseCut(pending, { final: false });
    expect(cut?.spoken).toBe("Let me check the calendar now,");
    expect(takeSpeakable(pending, false).spoken).toBe("");
    // a comma past the sixth word is not taken: the cut steps back from "for" to the last word that can end a clause
    const late = "Let me check the calendar for that, and then I will tell you more";
    expect(firstClauseCut(late, { final: false })?.spoken).toBe("Let me check the calendar");
    expect(takeSpeakable(late, false).spoken).toBe("");
  });
});

describe("the Brain shows and keeps only the stripped text", () => {
  type Handler = (event: Record<string, unknown>) => void;
  const handlers: Record<"delta" | "tool" | "done" | "error", Handler[]> = {
    delta: [],
    tool: [],
    done: [],
    error: [],
  };
  const g = globalThis as unknown as { window?: unknown; friday?: unknown };
  g.window ??= globalThis;
  for (const name of ["addEventListener", "removeEventListener"] as const) {
    (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
  }
  const listen = (kind: keyof typeof handlers) => (cb: Handler) => {
    handlers[kind].push(cb);
    return () => undefined;
  };
  g.friday = {
    sendChat: (request: Record<string, unknown>) => String(request["requestId"]),
    abortChat: () => undefined,
    onChatDelta: listen("delta"),
    onChatTool: listen("tool"),
    onChatDone: listen("done"),
    onChatError: listen("error"),
  };

  type Run = {
    id: string;
    answer: string;
    agents: unknown[];
    stages: unknown[];
    trace?: unknown[];
  };
  type Inner = {
    state: {
      runs: Run[];
      messages: Array<{ role: string; text: string; runId?: string }>;
      activeRunId: string | null;
    };
    activeRequestId: string | null;
    bindDesktopChat: () => void;
    newRun: (text: string, surface: "voice" | "chat", found: unknown, agents: string[]) => Run;
    flushAnswer: (run: Run) => void;
    replaceAnswer: (run: Run, text: string) => void;
  };
  const found = { rule: { id: "chat", label: "Chat", agents: [] }, score: 1, matched: [] };
  let brain: Inner & { deliveryScript: (runId: string) => string };
  let run: Run;

  const delta = (text: string, replace = false) => {
    for (const handler of handlers.delta) handler({ requestId: "r1", text, replace });
  };
  const shown = () =>
    brain.state.messages
      .filter((m) => m.role === "friday" && m.runId === run.id)
      .map((m) => m.text);

  async function start(surface: "voice" | "chat") {
    const mod = await import("../../src/lib/friday/brain-engine");
    brain = mod.brain as unknown as typeof brain;
    brain.bindDesktopChat();
    brain.state.runs = [];
    brain.state.messages = [];
    run = brain.newRun("hello there", surface, found, ["developer"]);
    brain.state.runs = [run];
    brain.state.activeRunId = run.id;
    brain.activeRequestId = "r1";
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("a tag split across two chunks never reaches the message or the run", async () => {
    await start("voice");
    delta("[warm] Hello the");
    delta("re [pau");
    expect(shown().join("")).not.toContain("[");
    expect(run.answer).not.toContain("[");
    delta("se:300] my friend. [so");
    delta("ft] Done.");
    expect(shown()).toEqual(["Hello there my friend. Done."]);
    expect(run.answer).toBe("Hello there my friend. Done.");
  });

  it("the script of a spoken run keeps the tags, for the speech path only", async () => {
    await start("voice");
    delta("[warm] Hello there. ");
    delta("[pause:300] Done.");
    expect(brain.deliveryScript(run.id)).toBe("[warm] Hello there. [pause:300] Done.");
    expect(shown()).toEqual(["Hello there. Done."]);
  });

  it("a typed run has no script at all", async () => {
    await start("chat");
    delta("[warm] Hello there.");
    expect(brain.deliveryScript(run.id)).toBe("");
    expect(shown()).toEqual(["Hello there."]);
  });

  it("a replaced stream (replace: true) is stripped the same way", async () => {
    await start("voice");
    delta("[calm] Draft one.");
    delta("[soft] Final answer here.", true);
    expect(shown()).toEqual(["Final answer here."]);
    expect(run.answer).toBe("Final answer here.");
  });

  it("the end of the reply shows an unfinished bracket as the text it is", async () => {
    await start("voice");
    delta("It costs [about");
    expect(run.answer).toBe("It costs ");
    brain.flushAnswer(run);
    expect(run.answer).toBe("It costs [about");
    expect(shown()).toEqual(["It costs [about"]);
  });

  it("an answer rewritten after the stream (reconcile, scrub) is stripped too", async () => {
    await start("voice");
    delta("Hello there.");
    brain.replaceAnswer(run, "Hello [warm] there, friend.");
    expect(run.answer).toBe("Hello there, friend.");
    expect(shown()).toEqual(["Hello there, friend."]);
  });

  it("only the latest runs keep a script", async () => {
    await start("voice");
    delta("[warm] Hello.");
    const first = run.id;
    for (let i = 0; i < 20; i += 1) {
      run = brain.newRun("again", "voice", found, ["developer"]);
      brain.state.runs = [run];
      brain.state.activeRunId = run.id;
      delta("[soft] More.");
    }
    expect(brain.deliveryScript(first)).toBe("");
    expect(brain.deliveryScript(run.id)).toBe("[soft] More.");
  });

  const toolEvent = (name = "web_search") => {
    for (const handler of handlers.tool) handler({ requestId: "r1", name });
  };
  const internals = () =>
    brain as unknown as {
      voiceRuns: Set<string>;
      failDesktopRun: (run: Run, error: string) => void;
    };

  it("a spoken run that read a tool result has no script, even when the model quotes the tags", async () => {
    await start("voice");
    toolEvent();
    delta("The page says [pause:2000] [slow] hello.");
    expect(brain.deliveryScript(run.id)).toBe("");
    expect(shown()).toEqual(["The page says hello."]);
  });

  it("a tool that runs after the model began writing still makes the run untrusted", async () => {
    await start("voice");
    delta("[warm] Let me check. ");
    toolEvent("read_file");
    delta("[pause:1200] Done.");
    expect(brain.deliveryScript(run.id)).toBe("");
  });

  it("a later spoken run with no tools keeps its tags after an untrusted one", async () => {
    await start("voice");
    toolEvent();
    delta("[pause:2000] quoted.");
    const tainted = run.id;
    run = brain.newRun("again", "voice", found, ["developer"]);
    brain.state.runs = [run];
    brain.state.activeRunId = run.id;
    delta("[soft] Plain answer.");
    expect(brain.deliveryScript(tainted)).toBe("");
    expect(brain.deliveryScript(run.id)).toBe("[soft] Plain answer.");
  });

  it("spoken runs that fail or come back empty do not pile up ids", async () => {
    await start("voice");
    for (let i = 0; i < 50; i += 1) {
      const next = brain.newRun("again", "voice", found, ["developer"]);
      brain.state.runs = [next];
      brain.state.activeRunId = next.id;
      internals().failDesktopRun(next, "boom");
    }
    expect(internals().voiceRuns.size).toBeLessThanOrEqual(16);
  });

  it("spoken runs that never finish are capped at sixteen", async () => {
    await start("voice");
    for (let i = 0; i < 50; i += 1) brain.newRun("again", "voice", found, ["developer"]);
    expect(internals().voiceRuns.size).toBe(16);
  });
});

describe("wiring (source-pinned; the speaker cannot run here)", () => {
  const brain = source("src/lib/friday/brain-engine.ts");
  const mode = source("src/lib/friday/assistant-mode.ts");
  const lib = source("src/lib/friday/voice-library.ts");
  const streaming = source("src/lib/friday/voice-engine/streaming-speak.ts");

  it("every place the Brain commits a reply to the thread strips the tags first", () => {
    // the phone line, the stream, a rewrite, a failure line, the quick answer, the parallel answer and the local one
    expect(brain).toContain("stripDeliveryTags(event.text)");
    expect(brain).toContain("stripDeliveryTagsLive(raw)");
    expect(brain).toMatch(/const text = stripDeliveryTags\(written\)/);
    expect(brain).toMatch(/const spoken = stripDeliveryTags\(reply\)/);
    expect(brain).toMatch(/const answer = stripDeliveryTags\(result\.answer/);
    expect(brain).toMatch(/text = stripDeliveryTags\(text\);\s*this\.state\.messages = \[/);
    expect(brain).toMatch(/failureText\(error[\s\S]{0,80}\),\s*\);/);
    // the end of a reply and a failure show the whole text
    expect(brain.match(/this\.flushAnswer\(run\)/g)?.length).toBe(2);
  });

  it("the voice-mode block describes the tags for a spoken turn only", () => {
    // one helper builds the block, and only for a spoken surface
    expect(brain).toMatch(
      /options\.voice \? voiceModeBlock\(\{ deliveryTags: options\.deliveryTags \}\) : ""/,
    );
    // the full turn asks for the tags only on the voice surface; the quick lane never (its reply is stripped)
    expect(brain).toMatch(
      /turnVoiceParts\(hints, \{\s*voice: surface === "voice",\s*deliveryTags: true,?\s*\}\)/,
    );
    expect(brain).toMatch(/voice: surface === "voice",\s*deliveryTags: false,?\s*\}\)/);
    expect(brain).toMatch(/if \(surface === "voice"\) this\.voiceRuns\.add\(runId\)/);
    expect(brain).toMatch(/return this\.voiceRuns\.has\(runId\)/);
    expect(brain).toMatch(/stripDeliveryTags\(sight\.text\)/);
    expect(brain).toMatch(/this\.untrustedRuns\.add\(run\.id\)/);
  });

  it("the conductor keeps tags for the reply of an Auto turn and strips every other spoken line", () => {
    expect(mode).toMatch(/meta\.reply === true && this\.state\.mode === "auto"/);
    expect(mode).toMatch(/\.\.\.\(tagged \? \{ deliveryTags: true \} : \{\}\)/);
    expect(mode).toContain("if (!stripDeliveryTags(prepared).trim())");
    expect(mode).toContain("this.taggedLines.add(prepared)");
    expect(mode).toMatch(/const tagged = this\.taggedLines\.delete\(spoken\)/);
    expect(mode).toMatch(/this\.spokenText = stripDeliveryTags\(spoken\)/);
    expect(mode).toMatch(/this\.speak\(piece, \{ reply: true,/);
    // only the streamed reply is marked as one
    expect(mode.match(/reply: true/g)?.length).toBe(1);
  });

  it("the voice receives the first clause marked, and a plan carries trusted, first and pauseMs", () => {
    expect(mode).toMatch(/\.\.\.\(first \? \{ first: true \} : \{\}\)/);
    expect(lib).toMatch(/plan\.trusted && !plan\.engine \? \{ trusted: true \}/);
    expect(lib).toMatch(/plan\.first \? \{ first: true \}/);
    expect(lib).toMatch(/plan\.pauseMs > 0 \? \{ pauseMs: plan\.pauseMs \}/);
    expect(lib).toContain("join: true,");
    expect(lib).toMatch(/gapMs > 0 \? \{ gapMs \} : \{\}/);
  });

  it("the driver reads the player's backlog and takes the short cut when it is almost dry", () => {
    expect(mode).toMatch(/underrunRisk: playbackPressure\(\)\?\.underrunRisk === true/);
    expect(mode).toMatch(/queued: this\.arbiter\.size\(\)/);
    expect(streaming).toContain("export function pickClauseRule");
    expect(lib).toMatch(/export function playbackPressure/);
  });

  it("an acknowledgement that has not sounded is dropped once the first clause is ready, so it never delays it", () => {
    expect(mode).toMatch(
      /private ackFirstClause\(\): boolean \{\s*return this\.voicedChars > 0 \|\| this\.turnStages\.at\("firstClauseReady"\) !== null;/,
    );
    expect(mode).toMatch(
      /const wanted = \(\) => speechGen === this\.speechGen && this\.ackDue\(ack\.gen\);/,
    );
  });

  it("a cloud voice never reads a tag aloud", () => {
    expect(streaming).toMatch(/text: stripDeliveryTags\(asked\.text\)/);
    expect(lib).toContain("cloudClip(plan.plain,");
  });
});
