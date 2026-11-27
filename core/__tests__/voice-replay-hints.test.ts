/**
 * A command that is replayed later (a confirmed read-back, a queued request) goes to the Brain with the language
 * hints captured WITH that command, never with the hints of the "yes" that confirmed it or of whatever turn
 * happened to be the latest when the queue drained. A confirmed read-back also drops the doubt it was asked for,
 * so the Brain does not ask "did you say ..." about words the owner just confirmed. Nothing here approves anything.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { brain } from "../../src/lib/friday/brain-engine";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { voiceNotes } from "../../src/lib/friday/voice-notes";
import { buildTurnRecord } from "../../src/lib/friday/voice-engine/stream-session";

type Hints = {
  lang: string;
  mix: number;
  confidence: number | null;
  eager: boolean;
  clipped: boolean;
};
type Driver = {
  state: { mode: string; paused: boolean; muted: boolean; speaking: boolean; pending: unknown };
  handleHeard: (text: string) => void;
  cancelSpeech: () => void;
  speak: (text: string) => void;
  emit: () => void;
  pendingHeard: { command: string; at: number; turn?: Hints | undefined } | null;
  queuedCommands: string[];
  queuedHints: Map<string, Hints>;
  turnRecord: unknown;
  turnRecordLive: boolean;
  queueTimer: unknown;
  drainQueuedCommands: () => void;
  stopQueueTimer: () => void;
  lastReadBackAt: number;
  lastHeardQuality: unknown;
  turnHints: () => Hints | undefined;
};
const drive = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

let sends: Array<{ text: string; turn: Hints | undefined }> = [];

const yesRecord = (text: string, confidence: number) =>
  buildTurnRecord({
    text,
    textRaw: text,
    declaredLanguage: "en",
    confidence,
    facts: null,
    interruptedPlayedMs: null,
  });

beforeEach(() => {
  vi.useFakeTimers();
  sends = [];
  voiceNotes.clear();
  autonomy.update({ approvalLevel: "balanced", halted: false });
  drive.state.mode = "auto";
  drive.state.paused = false;
  drive.state.muted = false;
  drive.state.speaking = false;
  drive.state.pending = null;
  drive.pendingHeard = null;
  drive.lastReadBackAt = 0;
  drive.lastHeardQuality = null;
  drive.queuedCommands = [];
  drive.queuedHints.clear();
  drive.cancelSpeech = () => undefined;
  drive.speak = () => undefined;
  drive.emit = () => undefined;
  vi.spyOn(brain, "send").mockImplementation(((text: string, options?: { turn?: Hints }) => {
    sends.push({ text, turn: options?.turn });
    return { accepted: true, runId: "r1" };
  }) as unknown as typeof brain.send);
  vi.spyOn(brain, "stop").mockImplementation(() => undefined);
});

afterEach(() => {
  drive.stopQueueTimer();
  drive.turnRecord = null;
  drive.turnRecordLive = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a confirmed read-back replays the command with the hints it was captured with", () => {
  it("a Devanagari command confirmed by a Latin yes is not told to answer in English", () => {
    drive.pendingHeard = {
      command: "ब्राउज़र खोलो",
      at: Date.now(),
      turn: { lang: "hi", mix: 0, confidence: 0.4, eager: false, clipped: false },
    };
    drive.turnRecord = yesRecord("yes", 0.9); // the confirming utterance: English, Latin
    drive.turnRecordLive = true;
    drive.handleHeard("yes");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe("ब्राउज़र खोलो");
    expect(sends[0]?.turn?.lang).toBe("hi");
  });

  it("a low-confidence yes does not turn the confirmed command into a clarification", () => {
    drive.pendingHeard = {
      command: "open the calendar",
      at: Date.now(),
      turn: { lang: "en", mix: 0, confidence: 0.3, eager: false, clipped: true },
    };
    drive.turnRecord = yesRecord("yes", 0.4); // under the 0.45 floor
    drive.turnRecordLive = true;
    drive.handleHeard("yes");
    expect(sends).toHaveLength(1);
    // The owner confirmed the words: neither the old doubt nor the yes's own score may reach the Brain.
    expect(sends[0]?.turn?.confidence ?? null).toBeNull();
    expect(sends[0]?.turn?.clipped).toBe(false);
  });

  it("a read-back stored with no hints replays with none, never the yes's", () => {
    drive.pendingHeard = { command: "open the calendar", at: Date.now() };
    drive.turnRecord = yesRecord("yes", 0.4);
    drive.turnRecordLive = true;
    drive.handleHeard("yes");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.turn).toBeUndefined();
  });

  it("the replay scope ends: the next turn uses its own record again", () => {
    drive.pendingHeard = {
      command: "open the calendar",
      at: Date.now(),
      turn: { lang: "hi", mix: 0, confidence: null, eager: false, clipped: false },
    };
    drive.turnRecord = yesRecord("yes", 0.9);
    drive.turnRecordLive = true;
    drive.handleHeard("yes");
    expect(drive.turnHints()?.lang).toBe("en");
  });
});

describe("a queued request replays with the hints captured when it was queued", () => {
  it("the drained command carries its own hints, not the latest turn's", () => {
    drive.queuedCommands = ["कल का मौसम बताओ"];
    drive.queuedHints.set("कल का मौसम बताओ", {
      lang: "hi",
      mix: 0,
      confidence: 0.9,
      eager: false,
      clipped: false,
    });
    drive.turnRecord = yesRecord("what time is it", 0.9); // the latest turn: English
    drive.turnRecordLive = true;
    drive.drainQueuedCommands();
    vi.advanceTimersByTime(800);
    expect(sends.map((row) => row.text)).toEqual(["कल का मौसम बताओ"]);
    expect(sends[0]?.turn?.lang).toBe("hi");
    expect(drive.queuedHints.size).toBe(0);
  });

  it("a queued command with no stored hints goes with none", () => {
    drive.queuedCommands = ["open mail"];
    drive.turnRecord = yesRecord("what time is it", 0.2);
    drive.turnRecordLive = true;
    drive.drainQueuedCommands();
    vi.advanceTimersByTime(800);
    expect(sends.map((row) => row.text)).toEqual(["open mail"]);
    expect(sends[0]?.turn).toBeUndefined();
  });
});
