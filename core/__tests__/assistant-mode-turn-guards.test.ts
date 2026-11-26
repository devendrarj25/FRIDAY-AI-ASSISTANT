/**
 * Four guards of the Auto-mode conductor's turn path (the Brain's `send` and `stop` are spies, speech output is dropped,
 * the clock is fake; no microphone, speaker, model or network):
 *
 *  - G4-3: a reply to a SENSITIVE question is kept off the cloud voice even when its own text looks plain;
 *  - G4-4: a spoken background task's send carries the voice surface, so it never runs as chat;
 *  - G4-5: a side question that the Brain turns into a real run (the work ended meanwhile) tears the old reply down and
 *    goes out with the full payload (pinned models, awareness text), not the side-question payload;
 *  - G4-7: the eager draft carries the heard turn's hints, and the side-question send names the voice surface.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { brain, VOICE_SEND, type Run } from "../../src/lib/friday/brain-engine";
import { composer } from "../../src/lib/friday/composer";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { buildTurnRecord } from "../../src/lib/friday/voice-engine/stream-session";
import { voiceNotes } from "../../src/lib/friday/voice-notes";

const cloud = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("../../src/lib/friday/voice-engine/voice-cloud-client", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/lib/friday/voice-engine/voice-cloud-client")>();
  return {
    ...real,
    speakWithCloud: async (_provider: string, input: Record<string, unknown>) => {
      cloud.calls.push(input);
      return { ok: false, error: "refused in this test" };
    },
  };
});

type SendOptions = {
  extra?: string;
  context?: string;
  modelIds?: string[];
  lane?: "quick" | "full";
  routingSurface?: string;
  turn?: unknown;
};
type SendResultLike = {
  accepted: boolean;
  reason?: string;
  message?: string | null;
  runId?: string;
};
type Driver = {
  state: { mode: string; paused: boolean; muted: boolean; speaking: boolean; pending: unknown };
  dispatch: (command: string) => boolean;
  emit: () => void;
  speak: (text: string) => void;
  markTurnAccepted: (command?: string) => void;
  noteReplySensitivity: (runId: string, text: string) => void;
  replySensitive: boolean;
  turnRecord: unknown;
  turnRecordLive: boolean;
  heardTurnId: string;
  replayTurn: unknown;
  queuedCommands: string[];
  stopQueueTimer: () => void;
  pendingUserEcho: number;
  pendingHeard: unknown;
  supersedeOnConfirm: unknown;
  heardOfReply: () => unknown;
  dropPlayback: (hold?: boolean) => void;
  trimReplyToHeard: (heard: unknown) => void;
  clearHoldLines: () => void;
  cloudSpeechBlockedUntil: number;
  startDraftRun: (command: string, viaTurn?: boolean) => void;
  cloudClipFor: () =>
    | ((
        text: string,
        lang: string,
        tone: { rate: number; pitch: number; volume: number },
      ) => Promise<unknown>)
    | undefined;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;
const root = resolve(import.meta.dirname, "../..");
const modeSource = readFileSync(resolve(root, "src/lib/friday/assistant-mode.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

type BrainInner = {
  state: {
    runs: Run[];
    messages: Record<string, unknown>[];
    activeRunId: string | null;
    approval: unknown;
  };
};
const inner = brain as unknown as BrainInner;

const QUESTION = "what is the capital of France?";
const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
const tone = { rate: 1, pitch: 1, volume: 1 };

let sends: Array<{ text: string; options: SendOptions }> = [];
let queue: SendResultLike[] = [];
let calls: string[] = [];
let stops: unknown[] = [];

function injectRun(id = "run-1") {
  inner.state.runs = [
    {
      id,
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
  inner.state.activeRunId = id;
}

function enableCloudVoice() {
  const voice = preferences.getSnapshot().voice as unknown as Record<string, unknown>;
  voice["cloudVoice"] = {
    cloudEnabled: true,
    speakWith: "sarvam",
    allowedProviders: ["sarvam"],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  sends = [];
  queue = [];
  calls = [];
  stops = [];
  cloud.calls = [];
  voiceNotes.clear();
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
  d.pendingHeard = null;
  d.supersedeOnConfirm = null;
  d.replayTurn = null;
  d.pendingUserEcho = 0;
  d.replySensitive = false;
  d.cloudSpeechBlockedUntil = 0;
  d.emit = () => undefined;
  vi.spyOn(d, "speak").mockImplementation(() => undefined);
  vi.spyOn(d, "dropPlayback").mockImplementation(() => void calls.push("dropPlayback"));
  vi.spyOn(d, "trimReplyToHeard").mockImplementation(() => void calls.push("trimReplyToHeard"));
  vi.spyOn(d, "clearHoldLines").mockImplementation(() => void calls.push("clearHoldLines"));
  vi.spyOn(composer, "directive").mockReturnValue({ extra: "", modelIds: ["model-a"] });
  vi.spyOn(brain, "send").mockImplementation(((text: string, options: SendOptions = {}) => {
    sends.push({ text, options });
    calls.push("send");
    return queue.shift() ?? { accepted: true, reason: "accepted", message: null, runId: "r1" };
  }) as unknown as typeof brain.send);
  vi.spyOn(brain, "stop").mockImplementation(((scope?: unknown) => {
    stops.push(scope);
    calls.push("stop");
  }) as never);
});

afterEach(() => {
  d.stopQueueTimer();
  d.turnRecord = null;
  d.turnRecordLive = false;
  d.state.pending = null;
  inner.state.runs = [];
  inner.state.activeRunId = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("G4-3: a sensitive question keeps its whole reply off the cloud voice", () => {
  it("a plain answer to a PIN question makes no cloud voice request", async () => {
    enableCloudVoice();
    d.markTurnAccepted("my PIN is 4821, say it back to me");
    d.noteReplySensitivity("r1", "It is the four digits you set last spring.");
    expect(d.replySensitive).toBe(true);
    const clip = d.cloudClipFor();
    expect(clip).toBeDefined();
    await clip?.("It is the four digits you set last spring.", "en", tone);
    expect(cloud.calls).toHaveLength(0);
  });

  it("the next ordinary turn clears it, and the cloud voice is asked again", async () => {
    enableCloudVoice();
    d.markTurnAccepted("my PIN is 4821, say it back to me");
    d.noteReplySensitivity("r1", "It is four digits.");
    d.markTurnAccepted(QUESTION);
    d.noteReplySensitivity("r2", "Paris.");
    expect(d.replySensitive).toBe(false);
    await d.cloudClipFor()?.("Paris.", "en", tone);
    expect(cloud.calls).toHaveLength(1);
    expect("sensitiveReply" in (cloud.calls[0] ?? {})).toBe(false);
  });

  it("the dispatch of a sensitive command marks the turn before the Brain is asked", async () => {
    enableCloudVoice();
    d.dispatch("my PIN is 4821, say it back to me");
    d.noteReplySensitivity("r1", "Four digits.");
    await d.cloudClipFor()?.("Four digits.", "en", tone);
    expect(cloud.calls).toHaveLength(0);
  });
});

describe("G4-4: a spoken background task is a voice send", () => {
  it("ownedBrain.send spreads the voice surface next to the task owner", () => {
    const from = modeSource.indexOf("function ownedBrain(");
    const body = modeSource.slice(from, modeSource.indexOf("\n}\n", from));
    expect(body).toMatch(
      /brain\.send\(prompt, \{ \.\.\.VOICE_SEND, owner: \{ kind: "task", taskId \} \}\)/,
    );
    expect(VOICE_SEND.routingSurface).toBe("voice");
  });
});

describe("G4-5: a side question that becomes a real run is a whole new turn", () => {
  it("tears the old reply down and sends the full payload", () => {
    injectRun();
    queue = [
      { accepted: true, reason: "accepted", message: null, runId: "r-side" },
      { accepted: true, reason: "accepted", message: null, runId: "r-full" },
    ];
    expect(d.dispatch(QUESTION)).toBe(true);
    expect(sends).toHaveLength(2);
    expect(sends[0]?.options.lane).toBe("quick");
    // The second send is the whole turn: the pinned models travel, and it is not a quick-lane request.
    expect(sends[1]?.options.modelIds).toEqual(["model-a"]);
    expect(sends[1]?.options.lane).not.toBe("quick");
    expect(sends[1]?.options.routingSurface).toBe(VOICE_SEND.routingSurface);
    expect(calls).toContain("dropPlayback");
    expect(calls).toContain("trimReplyToHeard");
    expect(calls).toContain("clearHoldLines");
    expect(calls.indexOf("dropPlayback")).toBeLessThan(calls.lastIndexOf("send"));
  });

  it("a real quick-lane answer keeps the playback and sends once", () => {
    injectRun();
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    expect(d.dispatch(QUESTION)).toBe(true);
    expect(sends).toHaveLength(1);
    expect(calls).not.toContain("dropPlayback");
    expect(calls).not.toContain("trimReplyToHeard");
    expect(stops).toEqual([]);
  });
});

describe("G4-7: the call sites that use the heard turn's hints and the voice surface", () => {
  it("the eager draft carries the heard turn's hints", () => {
    const seen: Array<{ onlyLocal?: boolean; turn?: unknown }> = [];
    vi.spyOn(brain, "startDraft").mockImplementation(((_text: string, options = {}) => {
      seen.push(options);
      return { started: false };
    }) as never);
    const voice = preferences.getSnapshot().voice as unknown as Record<string, unknown>;
    voice["eagerTurn"] = true;
    d.turnRecord = buildTurnRecord({
      text: QUESTION,
      textRaw: QUESTION,
      declaredLanguage: "en",
      confidence: 0.9,
      facts: null,
      interruptedPlayedMs: null,
    });
    d.turnRecordLive = true;
    d.startDraftRun(QUESTION, true);
    d.startDraftRun(QUESTION, false);
    voice["eagerTurn"] = false;
    expect(seen).toHaveLength(2);
    expect(seen[0]?.onlyLocal).toBe(true);
    expect(seen[0]?.turn).toMatchObject({ lang: "en" });
    expect(seen[1]?.onlyLocal).toBeUndefined();
    expect(seen[1]?.turn).toMatchObject({ lang: "en" });
  });

  it("the side-question send names the voice surface and the heard turn", () => {
    injectRun();
    d.turnRecord = buildTurnRecord({
      text: QUESTION,
      textRaw: QUESTION,
      declaredLanguage: "en",
      confidence: 0.9,
      facts: null,
      interruptedPlayedMs: null,
    });
    d.turnRecordLive = true;
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    d.dispatch(QUESTION);
    expect(sends[0]?.options.routingSurface).toBe("voice");
    expect(sends[0]?.options.turn).toMatchObject({ lang: "en" });
  });
});
