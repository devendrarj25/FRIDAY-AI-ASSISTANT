/**
 * Voice turns carry owner provenance only when the ear tagged the speaker "owner" (the Brain's `send` is a spy, the
 * clock is fake; no microphone, speaker, model or network). The tag only marks the turn's origin for learning:
 * it never reaches an approval, a confirmation or an authority check.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { brain, type Run } from "../../src/lib/friday/brain-engine";
import { composer } from "../../src/lib/friday/composer";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { promptAuthorOf } from "../../src/lib/friday/self/turn-provenance";

type SendOptions = { promptOrigin?: string; lane?: string; context?: string };
type Driver = {
  state: { mode: string; paused: boolean; muted: boolean; speaking: boolean; pending: unknown };
  dispatch: (command: string) => boolean;
  emit: () => void;
  speak: (text: string) => void;
  heardSpeaker: string | null;
  turnRecord: unknown;
  turnRecordLive: boolean;
  heardTurnId: string;
  replayTurn: unknown;
  queuedCommands: string[];
  stopQueueTimer: () => void;
  pendingUserEcho: number;
  dropPlayback: (hold?: boolean) => void;
  trimReplyToHeard: (heard: unknown) => void;
  clearHoldLines: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;
const root = resolve(import.meta.dirname, "../..");
const modeSource = readFileSync(resolve(root, "src/lib/friday/assistant-mode.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const inner = brain as unknown as {
  state: { runs: Run[]; messages: unknown[]; activeRunId: string | null; approval: unknown };
};

const QUESTION = "what is the capital of France?";
const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
let sends: Array<{ text: string; options: SendOptions }> = [];
let queue: Array<Record<string, unknown>> = [];

function injectRun() {
  inner.state.runs = [
    {
      id: "run-1",
      prompt: "summarise the quarterly report",
      intent: "general",
      intentLabel: "General",
      confidence: 1,
      matched: [],
      stages: [],
      agents: [],
      recalled: [],
      state: "running",
      answer: "",
      startedAt: T0,
      ms: 0,
    } as unknown as Run,
  ];
  inner.state.activeRunId = "run-1";
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  sends = [];
  queue = [];
  inner.state.runs = [];
  inner.state.messages = [];
  inner.state.activeRunId = null;
  inner.state.approval = null;
  autonomy.reset();
  autonomy.update({ approvalLevel: "balanced", halted: false });
  Object.assign(d.state, {
    mode: "auto",
    paused: false,
    muted: false,
    speaking: false,
    pending: null,
  });
  d.queuedCommands = [];
  d.turnRecord = null;
  d.turnRecordLive = false;
  d.heardTurnId = "";
  d.heardSpeaker = null;
  d.replayTurn = null;
  d.pendingUserEcho = 0;
  d.emit = () => undefined;
  vi.spyOn(d, "speak").mockImplementation(() => undefined);
  vi.spyOn(d, "dropPlayback").mockImplementation(() => undefined);
  vi.spyOn(d, "trimReplyToHeard").mockImplementation(() => undefined);
  vi.spyOn(d, "clearHoldLines").mockImplementation(() => undefined);
  vi.spyOn(composer, "directive").mockReturnValue({ extra: "", modelIds: [] });
  vi.spyOn(brain, "send").mockImplementation(((text: string, options: SendOptions = {}) => {
    sends.push({ text, options });
    return queue.shift() ?? { accepted: true, reason: "accepted", message: null, runId: "r1" };
  }) as unknown as typeof brain.send);
  vi.spyOn(brain, "stop").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  d.stopQueueTimer();
  d.turnRecord = null;
  d.turnRecordLive = false;
  d.heardSpeaker = null;
  d.state.pending = null;
  inner.state.runs = [];
  inner.state.activeRunId = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a whole voice turn", () => {
  it("carries the owner-voice origin when the ear tagged the owner", () => {
    d.heardSpeaker = "owner";
    expect(d.dispatch(QUESTION)).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.options.promptOrigin).toBe("owner-voice");
    expect(promptAuthorOf(sends[0]?.options.promptOrigin)).toBe("owner");
  });

  it.each(["other", "unknown", null])("carries no origin for the speaker tag %s", (tag) => {
    d.heardSpeaker = tag;
    expect(d.dispatch(QUESTION)).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.options).not.toHaveProperty("promptOrigin");
    expect(promptAuthorOf(sends[0]?.options.promptOrigin)).toBe("unknown");
  });

  it("carries no origin when the field holds anything but a known tag", () => {
    (d as unknown as { heardSpeaker: unknown }).heardSpeaker = "Owner ";
    d.dispatch(QUESTION);
    expect(sends[0]?.options).not.toHaveProperty("promptOrigin");
  });

  it("carries no origin while a stored command is replayed (the tag belongs to another turn)", () => {
    d.heardSpeaker = "owner";
    d.replayTurn = { hints: undefined };
    d.dispatch(QUESTION);
    expect(sends[0]?.options).not.toHaveProperty("promptOrigin");
  });
});

describe("a side question", () => {
  it("carries the owner-voice origin on the quick lane when the ear tagged the owner", () => {
    injectRun();
    d.heardSpeaker = "owner";
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    d.dispatch(QUESTION);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.options.lane).toBe("quick");
    expect(sends[0]?.options.promptOrigin).toBe("owner-voice");
  });

  it("carries no origin for another voice", () => {
    injectRun();
    d.heardSpeaker = "other";
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    d.dispatch(QUESTION);
    expect(sends[0]?.options.lane).toBe("quick");
    expect(sends[0]?.options).not.toHaveProperty("promptOrigin");
  });

  it("a side question the Brain turns into a real run keeps the owner origin on both sends", () => {
    injectRun();
    d.heardSpeaker = "owner";
    queue = [
      { accepted: true, reason: "accepted", message: null, runId: "r-side" },
      { accepted: true, reason: "accepted", message: null, runId: "r-full" },
    ];
    d.dispatch(QUESTION);
    expect(sends).toHaveLength(2);
    expect(sends.map((s) => s.options.promptOrigin)).toEqual(["owner-voice", "owner-voice"]);
  });
});

describe("where the tag comes from", () => {
  it("is set from the final's speaker tag, never for a TV, music or noise scene, and cleared when the voice begins", () => {
    expect(modeSource).toMatch(/private heardSpeaker: .*= null;/);
    expect(modeSource).toMatch(
      /this\.heardSpeaker =\s*record\.speaker && \(!record\.env \|\| record\.env\.kind === "speech"\)\s*\? record\.speaker\.tag\s*: null;/,
    );
    expect(modeSource).toContain(
      "this.turnRecordLive = false;\n        this.heardSpeaker = null;\n        // A draft started",
    );
  });

  it("the tag is spread into the whole and the side payload only, never into a yes or approval path", () => {
    expect(modeSource.match(/\.\.\.this\.voiceOriginOption\(\)/g)).toHaveLength(2);
    expect(modeSource.match(/heardSpeaker/g)?.length).toBe(4);
    const yes = modeSource.indexOf("private yesRefusal(");
    const body = modeSource.slice(yes, modeSource.indexOf("\n  }\n", yes));
    expect(body).not.toContain("heardSpeaker");
    expect(body).not.toContain("promptOrigin");
  });
});
