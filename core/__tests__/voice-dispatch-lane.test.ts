/**
 * How a spoken command reaches the Brain while a turn already runs, and how an approved command is replayed.
 *
 *  - L1: a short side question goes to the quick lane (`lane: "quick"`) with the voice facts as `context`, never as an
 *    attachment, and a lane refusal queues the question; `send` never stops the foreground, and this controller stops
 *    it only for a real new request.
 *  - L5: the playback of the running reply is torn down only for a real new run: a question between two clauses leaves
 *    the reply cursor and the heard-so-far bookkeeping alone.
 *  - L2: a command the owner approved by voice or on screen is dispatched with the hints it was heard with, not with
 *    those of the "yes" or "haan" turn (reply language follows the command, a doubtful "haan" asks nothing).
 *  - P1-J: one whole-reply sensitivity flag, set once per reply, rides on every cloud clause of that reply.
 *
 * Nothing here opens a microphone, a speaker, a model or the network: the Brain's `send` and `stop` are spies, the
 * speech output is dropped and the clock is fake.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { brain, VOICE_SEND, type Run } from "../../src/lib/friday/brain-engine";
import { cleanTurnHints, needsClarification } from "../../src/lib/friday/brain/turn-hints";
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
vi.mock("../../src/lib/friday/brain/conversation-state", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/lib/friday/brain/conversation-state")>();
  return { ...real, conversationDigest: () => "topic: the quarterly report; last ask: the totals" };
});

type Hints = {
  lang: string;
  mix: number;
  confidence: number | null;
  eager: boolean;
  clipped: boolean;
};
type SendOptions = {
  extra?: string;
  context?: string;
  lane?: "quick" | "full";
  turnId?: string;
  routingSurface?: string;
  turn?: Hints;
};
type SendResultLike = {
  accepted: boolean;
  reason?: string;
  message?: string | null;
  runId?: string;
  refused?: true;
  foregroundUntouched?: true;
};
type Driver = {
  state: {
    mode: string;
    paused: boolean;
    muted: boolean;
    speaking: boolean;
    handsFree: boolean;
    pending: { command: string; reason: string; at: number; hints?: Hints } | null;
  };
  dispatch: (command: string) => boolean;
  handleHeard: (text: string) => void;
  confirmPending: (ok: boolean) => void;
  askToConfirm: (command: string) => void;
  speak: (text: string) => void;
  emit: () => void;
  dropPlayback: (hold?: boolean) => void;
  trimReplyToHeard: (heard: unknown) => void;
  markTurnAccepted: () => void;
  turnRecord: unknown;
  turnRecordLive: boolean;
  heardTurnId: string;
  turnHints: () => Hints | undefined;
  replayTurn: unknown;
  queuedCommands: string[];
  stopQueueTimer: () => void;
  voicedRunId: string;
  voicedChars: number;
  voicedPrefix: string;
  pendingUserEcho: number;
  pendingHeard: unknown;
  supersedeOnConfirm: unknown;
  noteReplySensitivity: (runId: string, text: string) => void;
  replySensitive: boolean;
  cloudClipFor: () =>
    | ((
        text: string,
        lang: string,
        tone: { rate: number; pitch: number; volume: number },
      ) => Promise<unknown>)
    | undefined;
  cloudSpeechBlockedUntil: number;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;
const root = resolve(import.meta.dirname, "../..");
const modeSource = readFileSync(resolve(root, "src/lib/friday/assistant-mode.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const dispatchSource = (() => {
  const from = modeSource.indexOf("  private dispatch(command: string");
  return modeSource.slice(from, modeSource.indexOf("\n  private armHoldLines(", from));
})();

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

let sends: Array<{ text: string; options: SendOptions }> = [];
let queue: SendResultLike[] = [];
let spoken: string[] = [];
let stops: unknown[] = [];

function recordOf(text: string, language: string, confidence: number | null) {
  return buildTurnRecord({
    text,
    textRaw: text,
    declaredLanguage: language,
    confidence,
    facts: null,
    interruptedPlayedMs: null,
  });
}

/** A run in the real Brain state, as `startRun` leaves it while a turn works. */
function injectRun(id = "run-1") {
  const run = {
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
  } as unknown as Run;
  inner.state.runs = [run];
  inner.state.activeRunId = id;
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  sends = [];
  queue = [];
  spoken = [];
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
  d.voicedRunId = "";
  d.voicedChars = 0;
  d.voicedPrefix = "";
  d.pendingUserEcho = 0;
  d.replySensitive = false;
  d.cloudSpeechBlockedUntil = 0;
  d.emit = () => undefined;
  vi.spyOn(d, "speak").mockImplementation((text: string) => void spoken.push(text));
  vi.spyOn(composer, "directive").mockReturnValue({ extra: "", modelIds: [] });
  vi.spyOn(brain, "send").mockImplementation(((text: string, options: SendOptions = {}) => {
    sends.push({ text, options });
    return queue.shift() ?? { accepted: true, reason: "accepted", message: null, runId: "r1" };
  }) as unknown as typeof brain.send);
  vi.spyOn(brain, "stop").mockImplementation(((scope?: unknown) => {
    stops.push(scope);
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

describe("L1: a side question takes the quick lane and never stops the running turn", () => {
  it("is sent as lane quick on the voice surface", () => {
    injectRun();
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    expect(d.dispatch(QUESTION)).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.options.lane).toBe("quick");
    expect(sends[0]?.options.routingSurface).toBe(VOICE_SEND.routingSurface);
    expect(stops).toEqual([]);
  });

  it("sends the voice digest as scrubbed context, never as an attachment", () => {
    injectRun();
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    d.dispatch(QUESTION);
    const options = sends[0]?.options;
    expect(options?.context).toContain("the quarterly report");
    expect((options?.context ?? "").length).toBeLessThanOrEqual(800);
    expect(options?.extra ?? "").not.toContain("quarterly");
    expect(options?.extra ?? "").not.toContain("VOICE SESSION");
  });

  it("keeps a real attachment in extra and out of the context", () => {
    injectRun();
    vi.spyOn(composer, "directive").mockReturnValue({ extra: "File: notes.txt", modelIds: [] });
    queue = [
      {
        accepted: false,
        reason: "lane-refused",
        message: null,
        refused: true,
        foregroundUntouched: true,
      },
    ];
    d.dispatch(QUESTION);
    expect(sends[0]?.options.extra).toBe("File: notes.txt");
    expect(sends[0]?.options.context ?? "").not.toContain("notes.txt");
  });

  it("carries the heard turn's id", () => {
    injectRun();
    d.heardTurnId = "turn-42";
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    d.dispatch(QUESTION);
    expect(sends[0]?.options.turnId).toBe("turn-42");
  });

  it("puts the reply language of the heard turn into the quick lane's context", () => {
    injectRun();
    d.turnRecord = recordOf("फ्रांस की राजधानी क्या है?", "hi", 0.9);
    d.turnRecordLive = true;
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    d.dispatch("फ्रांस की राजधानी क्या है?");
    expect(sends[0]?.options.context).toContain("Hindi");
    expect((sends[0]?.options.context ?? "").length).toBeLessThanOrEqual(800);
  });

  it("queues the question when the Brain refuses the lane, and stops nothing", () => {
    injectRun();
    queue = [
      {
        accepted: false,
        reason: "lane-refused",
        message: null,
        refused: true,
        foregroundUntouched: true,
      },
    ];
    expect(d.dispatch(QUESTION)).toBe(true);
    expect(sends).toHaveLength(1);
    expect(d.queuedCommands).toEqual([QUESTION]);
    expect(stops).toEqual([]);
    expect(d.pendingUserEcho).toBe(0);
    expect(spoken.length).toBe(1);
  });

  it("never stops the foreground for any refusal that left it untouched", () => {
    injectRun();
    for (const reason of ["lane-refused", "busy"]) {
      queue = [
        { accepted: false, reason, message: null, refused: true, foregroundUntouched: true },
      ];
      stops = [];
      d.queuedCommands = [];
      d.dispatch(QUESTION);
      expect(stops, reason).toEqual([]);
    }
  });

  it("a real new request still interrupts the foreground once and goes again on the voice surface", () => {
    injectRun();
    queue = [
      {
        accepted: false,
        reason: "busy",
        message: "busy",
        refused: true,
        foregroundUntouched: true,
      },
      { accepted: true, reason: "accepted", message: null, runId: "r2" },
    ];
    expect(d.dispatch("open the calendar and the mail")).toBe(true);
    expect(stops).toEqual(["foreground"]);
    expect(sends).toHaveLength(2);
    for (const call of sends) {
      expect(call.options.routingSurface).toBe("voice");
      expect(call.options.lane).toBe("full");
    }
  });

  it("a real request keeps the awareness blocks in extra for the full turn", () => {
    queue = [{ accepted: true, reason: "accepted", message: null, runId: "r2" }];
    d.dispatch("open the calendar and the mail");
    expect(sends[0]?.options.extra).toContain("VOICE SESSION");
  });

  it("a quick-lane answer is not announced as a new turn", () => {
    injectRun();
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    d.dispatch(QUESTION);
    expect(d.state.pending).toBeNull();
    expect(spoken).toEqual([]);
  });

  it("a doubtful side question is answered with the Brain's one clarifying question, not a failure", () => {
    injectRun();
    queue = [
      {
        accepted: false,
        reason: "clarify",
        message: "Did you say that?",
        refused: true,
        foregroundUntouched: true,
      },
    ];
    expect(d.dispatch(QUESTION)).toBe(true);
    expect(spoken).toEqual(["Did you say that?"]);
    expect(stops).toEqual([]);
    expect(d.queuedCommands).toEqual([]);
  });

  it("with the side-question lane switched off the question is a whole turn and never a lane request", () => {
    injectRun();
    const voice = preferences.getSnapshot().voice as unknown as Record<string, unknown>;
    const saved = voice["tasks"];
    voice["tasks"] = { sideQuestionLane: false };
    queue = [{ accepted: true, reason: "accepted", message: null, runId: "r2" }];
    try {
      d.dispatch(QUESTION);
    } finally {
      voice["tasks"] = saved;
    }
    expect(sends[0]?.options.lane).toBe("full");
    expect(sends[0]?.options.context).toBeUndefined();
  });

  it("a side question that finds the work already over is a normal new run", () => {
    injectRun();
    d.voicedRunId = "old";
    d.voicedChars = 12;
    queue = [{ accepted: true, reason: "accepted", message: null, runId: "r2" }];
    expect(d.dispatch(QUESTION)).toBe(true);
    expect(d.voicedChars).toBe(0);
    expect(d.voicedRunId).toBe("");
  });

  it("the turn id is made once, at the intake, and not read from the record anywhere else", () => {
    expect(modeSource).toContain("this.heardTurnId = this.turnRecord.turnId;");
    expect(modeSource).toMatch(/const id = this\.replayTurn \? "" : this\.heardTurnId;/);
  });

  it("spreads the one voice-surface constant instead of a literal", () => {
    expect(dispatchSource).toContain("...VOICE_SEND");
    expect(dispatchSource).not.toContain('routingSurface: "voice"');
    expect(dispatchSource).toContain('lane: "quick"');
    expect(dispatchSource).toContain("result.refused && result.foregroundUntouched");
  });
});

describe("L5: the reply is torn down only for a real new run", () => {
  it("a side question between two clauses keeps the cursor of the live reply", () => {
    injectRun();
    d.voicedRunId = "run-1";
    d.voicedChars = 42;
    d.voicedPrefix = "Here is the first clause. And a second";
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    d.dispatch(QUESTION);
    expect(d.voicedRunId).toBe("run-1");
    expect(d.voicedChars).toBe(42);
    expect(d.voicedPrefix).toBe("Here is the first clause. And a second");
  });

  it("does not stop playback, mark the reply cut or move to Thinking for a quick-lane question", () => {
    injectRun();
    const drop = vi.spyOn(d, "dropPlayback");
    const trim = vi.spyOn(d, "trimReplyToHeard");
    const accepted = vi.spyOn(d, "markTurnAccepted");
    queue = [{ accepted: true, reason: "quick-lane", message: null }];
    d.dispatch(QUESTION);
    expect(drop).not.toHaveBeenCalled();
    expect(trim).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
  });

  it("a refused lane leaves the playback and the cursor alone as well", () => {
    injectRun();
    d.voicedRunId = "run-1";
    d.voicedChars = 10;
    const drop = vi.spyOn(d, "dropPlayback");
    queue = [
      {
        accepted: false,
        reason: "lane-refused",
        message: null,
        refused: true,
        foregroundUntouched: true,
      },
    ];
    d.dispatch(QUESTION);
    expect(drop).not.toHaveBeenCalled();
    expect(d.voicedChars).toBe(10);
  });

  it("a real new run tears the playback down before it asks the Brain, and restarts the cursor", () => {
    d.voicedRunId = "old";
    d.voicedChars = 30;
    const order: string[] = [];
    vi.spyOn(d, "dropPlayback").mockImplementation(() => void order.push("drop"));
    sends.length = 0;
    vi.mocked(brain.send).mockImplementation(((text: string, options: SendOptions = {}) => {
      order.push("send");
      sends.push({ text, options });
      return { accepted: true, reason: "accepted", message: null, runId: "r2" };
    }) as never);
    d.dispatch("open the calendar and the mail");
    expect(order).toEqual(["drop", "send"]);
    expect(d.voicedChars).toBe(0);
    expect(d.voicedRunId).toBe("");
  });

  it("a refused real request does not leave the reply half torn down: it is reported, the cursor restarts only on accept", () => {
    d.voicedRunId = "old";
    d.voicedChars = 30;
    queue = [
      {
        accepted: false,
        reason: "empty",
        message: "I didn't catch anything.",
        refused: true,
        foregroundUntouched: true,
      },
    ];
    expect(d.dispatch("open the calendar and the mail")).toBe(false);
    expect(stops).toEqual([]);
  });

  it("the source guards the whole teardown with the side-question decision", () => {
    const guardAt = dispatchSource.indexOf("if (!side) {");
    const dropAt = dispatchSource.indexOf("this.dropPlayback()");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(dropAt);
    expect(dispatchSource.indexOf("this.trimReplyToHeard(heard)")).toBeGreaterThan(dropAt);
    expect(dispatchSource.indexOf("this.markTurnAccepted()")).toBeGreaterThan(dropAt);
    // The one stop of the foreground sits behind the real-request busy answer, after the side-question refusal.
    expect(dispatchSource.indexOf("result.refused && result.foregroundUntouched")).toBeLessThan(
      dispatchSource.indexOf('brain.stop("foreground")'),
    );
  });
});

describe("L2: an approved command runs with the hints it was heard with", () => {
  const hindiHints: Hints = { lang: "hi", mix: 0, confidence: 0.9, eager: false, clipped: false };

  it("stores the hints of the command's own turn when it asks to confirm", () => {
    d.turnRecord = recordOf("ब्राउज़र खोलो", "hi", 0.9);
    d.turnRecordLive = true;
    d.askToConfirm("ब्राउज़र खोलो");
    expect(d.state.pending?.command).toBe("ब्राउज़र खोलो");
    expect(d.state.pending?.hints?.lang).toBe("hi");
    expect(d.state.pending?.hints?.confidence).toBeCloseTo(0.9, 5);
  });

  it("stores nothing when no turn was heard (a typed or UI command)", () => {
    d.turnRecord = null;
    d.askToConfirm("open the calendar");
    expect(d.state.pending?.hints).toBeUndefined();
  });

  it("a spoken yes in another language runs the command with the command's language", () => {
    d.state.pending = { command: "ब्राउज़र खोलो", reason: "x", at: Date.now(), hints: hindiHints };
    d.turnRecord = recordOf("yes", "en", 0.9);
    d.turnRecordLive = true;
    d.handleHeard("yes");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe("ब्राउज़र खोलो");
    expect(sends[0]?.options.turn?.lang).toBe("hi");
  });

  it("a doubtful haan neither asks 'did you say' nor carries its own score", () => {
    d.state.pending = {
      command: "open the calendar",
      reason: "x",
      at: Date.now(),
      hints: { lang: "en", mix: 0, confidence: 0.8, eager: false, clipped: false },
    };
    d.turnRecord = recordOf("haan", "hi", 0.2);
    d.turnRecordLive = true;
    d.handleHeard("haan");
    expect(sends).toHaveLength(1);
    const turn = sends[0]?.options.turn;
    expect(turn?.confidence ?? null).toBeNull();
    expect(turn?.clipped).toBe(false);
    expect(needsClarification(cleanTurnHints(turn))).toBe(false);
  });

  it("a command stored without hints replays with none, never the yes turn's", () => {
    d.state.pending = { command: "open the calendar", reason: "x", at: Date.now() };
    d.turnRecord = recordOf("yes", "en", 0.2);
    d.turnRecordLive = true;
    d.handleHeard("yes");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.options.turn).toBeUndefined();
  });

  it("the confirm button on screen replays the stored hints too", () => {
    d.state.pending = { command: "ब्राउज़र खोलो", reason: "x", at: Date.now(), hints: hindiHints };
    d.turnRecord = recordOf("something else", "en", 0.3);
    d.turnRecordLive = true;
    d.confirmPending(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.options.turn?.lang).toBe("hi");
    expect(sends[0]?.options.turn?.confidence ?? null).toBeNull();
  });

  it("the replay scope ends after the command: the next turn reads its own record again", () => {
    d.state.pending = { command: "ब्राउज़र खोलो", reason: "x", at: Date.now(), hints: hindiHints };
    d.turnRecord = recordOf("yes", "en", 0.9);
    d.turnRecordLive = true;
    d.handleHeard("yes");
    expect(d.replayTurn).toBeNull();
    expect(d.turnHints()?.lang).toBe("en");
  });

  it("a no or an expired confirmation sends nothing", () => {
    d.state.pending = {
      command: "open the calendar",
      reason: "x",
      at: Date.now(),
      hints: hindiHints,
    };
    d.confirmPending(false);
    expect(sends).toEqual([]);
    d.state.pending = { command: "open the calendar", reason: "x", at: Date.now() - 10 * 60_000 };
    d.confirmPending(true);
    expect(sends).toEqual([]);
  });

  it("the source runs the approved command inside the replay scope", () => {
    expect(modeSource).toMatch(/private runApproved\(command: string, hints\?: TurnHints\)/);
    expect(modeSource).toContain("this.runApproved(cmd, cmdHints);");
    expect(modeSource).toContain("this.runApproved(pending.command, pending.hints);");
    expect(modeSource).toMatch(
      /\{ \.\.\.hints, confidence: null, clipped: false \}[\s\S]{0,80}this\.replayWith\(heardWith/,
    );
  });
});

describe("P1-J: the whole-reply sensitivity flag", () => {
  const tone = { rate: 1, pitch: 1, volume: 1 };
  const enableCloudVoice = () => {
    const voice = preferences.getSnapshot().voice as unknown as Record<string, unknown>;
    voice["cloudVoice"] = {
      cloudEnabled: true,
      speakWith: "sarvam",
      allowedProviders: ["sarvam"],
    };
  };

  it("is set once a sensitive part of the reply is seen and stays set for the reply", () => {
    d.noteReplySensitivity("r1", "Here is the summary.");
    expect(d.replySensitive).toBe(false);
    d.noteReplySensitivity("r1", "Here is the summary. Your password is hunter2.");
    expect(d.replySensitive).toBe(true);
    d.noteReplySensitivity("r1", "Here is the summary. Your password is hunter2. Anything else?");
    expect(d.replySensitive).toBe(true);
  });

  it("resets for the next reply", () => {
    d.noteReplySensitivity("r1", "Your password is hunter2.");
    d.noteReplySensitivity("r2", "It is sunny today.");
    expect(d.replySensitive).toBe(false);
  });

  it("rides on a harmless clause of a sensitive reply", async () => {
    enableCloudVoice();
    d.noteReplySensitivity("r1", "Your password is hunter2. Anything else?");
    const clip = d.cloudClipFor();
    expect(clip).toBeDefined();
    await clip?.("Anything else?", "en", tone);
    expect(cloud.calls).toHaveLength(1);
    expect(cloud.calls[0]?.["sensitiveReply"]).toBe(true);
  });

  it("is absent on an ordinary reply and a refusal for it does not block the cloud voice", async () => {
    enableCloudVoice();
    d.noteReplySensitivity("r1", "It is sunny today.");
    const clip = d.cloudClipFor();
    await clip?.("It is sunny today.", "en", tone);
    expect(cloud.calls).toHaveLength(1);
    expect("sensitiveReply" in (cloud.calls[0] ?? {})).toBe(false);
  });

  it("a sensitive refusal does not start the 60 s cloud-voice cool-down", async () => {
    enableCloudVoice();
    d.noteReplySensitivity("r1", "Your password is hunter2. Anything else?");
    await d.cloudClipFor()?.("Anything else?", "en", tone);
    expect(d.cloudSpeechBlockedUntil).toBe(0);
  });

  it("is computed where the streamed reply is spoken", () => {
    expect(modeSource).toContain("this.noteReplySensitivity(runId, text)");
  });
});
