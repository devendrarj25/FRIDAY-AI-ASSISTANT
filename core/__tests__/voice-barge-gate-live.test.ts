/**
 * The backchannel gate on the real conductor: fake clock, fake playback (no speaker, no microphone). While she
 * speaks, the owner's voice only ducks her; real words, a stop word or an answer to her question stop her; a nod,
 * a cough or her own voice coming back lets the volume return. The history is cut at what was played, the
 * foreground reply is the only thing cancelled (never a background task), and no speaker match is ever consulted.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const library = vi.hoisted(() => ({
  duck: [] as boolean[],
  levels: [] as Array<number | undefined>,
  stops: 0,
  cut: null as null | Record<string, unknown>,
}));

vi.mock("../../src/lib/friday/voice-library", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/friday/voice-library")>();
  return {
    ...real,
    duckSpeech: (on: boolean, level?: number) => {
      library.duck.push(on);
      library.levels.push(level);
    },
    stopSpeaking: () => {
      library.stops += 1;
    },
    playedReplyCut: () => library.cut,
    playedReplySnapshot: () => ({
      runId: "run-1",
      text: "",
      words: 0,
      wholeClips: 0,
      interrupted: true,
    }),
  };
});

const win = globalThis as unknown as { window?: unknown; friday?: unknown };
win.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}
(globalThis as unknown as { document?: unknown }).document ??= {
  hidden: false,
  documentElement: { classList: { toggle: () => undefined } },
  addEventListener: () => undefined,
  hasFocus: () => true,
  head: { appendChild: () => undefined },
  getElementsByTagName: () => [{ appendChild: () => undefined }],
  createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined }),
  createTextNode: () => ({}),
};
type PartialHandler = (payload: { text?: string }) => void;
const partialHandlers: PartialHandler[] = [];
win.friday = {
  onVoicePartial: (cb: PartialHandler) => {
    partialHandlers.push(cb);
    return () => undefined;
  },
};

const { assistantMode } = await import("../../src/lib/friday/assistant-mode");
const { brain } = await import("../../src/lib/friday/brain-engine");
const { preferences } = await import("../../src/lib/friday/preferences");
const { voiceGate } = await import("../../src/lib/friday/voice-audio");
assistantMode.subscribe(() => undefined);

type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    paused: boolean;
    muted: boolean;
    speaking: boolean;
    pending: { command: string; reason: string; at: number } | null;
  };
  voicedRunId: string;
  spokenText: string;
  interruptHold: unknown;
  interruptGate: { active: boolean };
  gateEnabled: () => boolean;
  beginInterruptCandidate: () => void;
  holdForInterruption: () => void;
  settleInterruption: (text: string) => boolean;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;

const root = resolve(import.meta.dirname, "../..");
const modeSource = readFileSync(resolve(root, "src/lib/friday/assistant-mode.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

let speech = false;
let stopCalls: unknown[] = [];
let truncated: Array<[string, string, number | undefined]> = [];
let approval: unknown = null;

/** The newest partial handler is the conductor's (the one that also plans drafts); it feeds the gate too. */
function partial(text: string) {
  const handler = partialHandlers[partialHandlers.length - 1];
  if (!handler) throw new Error("no partial handler registered");
  handler({ text });
}

/** Advance the fake clock in the live timer's own 100 ms steps. */
function run(ms: number) {
  for (let spent = 0; spent < ms; spent += 100) vi.advanceTimersByTime(100);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  library.duck = [];
  library.levels = [];
  library.stops = 0;
  library.cut = {
    runId: "run-1",
    text: "First open the report.",
    words: 4,
    wholeClips: 1,
    interrupted: true,
    playedMs: 1100,
    cutMs: 1000,
  };
  // A candidate or a hold left by an earlier case must not leak into this one.
  (d as unknown as { endInterruptCandidate: () => void }).endInterruptCandidate();
  speech = false;
  stopCalls = [];
  truncated = [];
  approval = null;
  preferences.setVoice({ interruptGate: { enabled: true } as never, trimHistoryToPlayed: true });
  Object.assign(d.state, {
    mode: "auto",
    paused: false,
    muted: false,
    speaking: true,
    pending: null,
  });
  Object.assign(d, { voicedRunId: "run-1", spokenText: "", interruptHold: null });
  d.emit = () => undefined;
  vi.spyOn(voiceGate, "heardSpeechWithin").mockImplementation(() => speech);
  const snapshot = brain.getSnapshot.bind(brain);
  vi.spyOn(brain, "getSnapshot").mockImplementation((() => ({
    ...snapshot(),
    activeRunId: "run-1",
    approval,
  })) as never);
  vi.spyOn(brain, "stop").mockImplementation(((scope?: unknown) => {
    stopCalls.push(scope);
  }) as never);
  vi.spyOn(brain, "truncateAssistantReply").mockImplementation(((
    runId: string,
    text: string,
    playedMs?: number,
  ) => {
    truncated.push([runId, text, playedMs]);
    return true;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  preferences.setVoice({ interruptGate: { enabled: true } as never });
});

describe("a nod, a cough and her own voice never stop her", () => {
  it("her volume goes down at once, the voice keeps playing, and a nod brings it back", () => {
    speech = true;
    d.beginInterruptCandidate();
    expect(library.duck).toEqual([true]);
    expect(d.interruptGate.active).toBe(true);
    run(200);
    partial("haan");
    run(100);
    speech = false;
    run(1300);
    expect(library.stops).toBe(0);
    expect(library.duck).toEqual([true, false]);
    expect(d.interruptHold).toBeNull();
    expect(stopCalls).toEqual([]);
    expect(d.interruptGate.active).toBe(false);
  });

  it("a short noise burst is judged false after the timeout and the volume returns", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(100);
    speech = false;
    run(1100);
    expect(library.duck).toEqual([true]);
    run(200);
    expect(library.duck).toEqual([true, false]);
    expect(library.stops).toBe(0);
  });

  it("the final transcript of a nod ends the candidate at once and is not a turn", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(300);
    speech = false;
    expect(d.settleInterruption("Haan, theek hai")).toBe(true);
    expect(library.duck).toEqual([true, false]);
    expect(library.stops).toBe(0);
    expect(stopCalls).toEqual([]);
  });

  it("her own voice coming back is never an interruption, however long it lasts", () => {
    d.spokenText = "the report is ready for you";
    speech = true;
    d.beginInterruptCandidate();
    partial("the report is ready for you");
    run(3500);
    expect(library.stops).toBe(0);
    expect(stopCalls).toEqual([]);
    speech = false;
    run(1400);
    expect(library.duck).toEqual([true, false]);
  });

  it("speech that resumes inside the timeout keeps her ducked and restarts the silence clock", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(100);
    speech = false;
    run(1000);
    expect(library.duck).toEqual([true]);
    speech = true;
    run(200);
    speech = false;
    run(1000);
    expect(library.duck).toEqual([true]);
    run(400);
    expect(library.duck).toEqual([true, false]);
    expect(library.stops).toBe(0);
  });

  it("the volume also returns when she finishes by herself while the candidate waits", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(200);
    d.state.speaking = false;
    run(100);
    expect(library.duck).toEqual([true, false]);
    expect(d.interruptGate.active).toBe(false);
  });
});

describe("real interruptions stop her and cut the history at what was played", () => {
  it("two real words after 400 ms of speech stop the voice; the final judges the cut", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(500);
    partial("open the report");
    expect(library.stops).toBe(1);
    expect(d.interruptHold).toBeTruthy();
    expect(d.interruptGate.active).toBe(false);
    // Nothing is cancelled until the words are judged on the final transcript.
    expect(stopCalls).toEqual([]);
    expect(d.settleInterruption("open the report please")).toBe(false);
    expect(stopCalls).toEqual(["foreground"]);
    expect(truncated).toEqual([["run-1", "First open the report.", 1100]]);
  });

  it("only the foreground reply is cancelled: never Stop everything, never a task the owner started", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(500);
    partial("actually open the other report");
    d.settleInterruption("actually open the other report");
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]).toBe("foreground");
    expect(modeSource).not.toMatch(/interruptGate[\s\S]{0,400}cancelAllVoiceTasks/);
  });

  it("the history is cut at what was heard when the voice began, not at the later stop", () => {
    speech = true;
    d.beginInterruptCandidate();
    // She keeps talking, ducked, while the words arrive: the stop reads later, but the heard part is the earlier one.
    library.cut = {
      ...(library.cut as object),
      text: "First open the report. Then check it.",
      playedMs: 2600,
      cutMs: 2400,
      wholeClips: 2,
    };
    run(600);
    partial("wait no open the other one");
    d.settleInterruption("wait no open the other one");
    expect(truncated[0]?.[1]).toBe("First open the report.");
    expect(truncated[0]?.[2]).toBe(1100);
  });

  it.each(["wait", "ruko", "ek minute", "stop", "रुको"])(
    "the stop word %s stops her at once",
    (word) => {
      speech = true;
      d.beginInterruptCandidate();
      run(100);
      partial(word);
      expect(library.stops).toBe(1);
      expect(d.interruptHold).toBeTruthy();
    },
  );

  it("a bare yes while she waits for an answer reaches the approval path at once", () => {
    d.state.pending = { command: "delete the old report", reason: "asks", at: Date.now() };
    speech = true;
    d.beginInterruptCandidate();
    run(100);
    partial("yes");
    expect(library.stops).toBe(1);
    // The final yes is not swallowed as a nod: the line carries on to the approval path.
    expect(d.settleInterruption("yes")).toBe(false);
  });

  it("a bare yes with nothing asked is a nod and stops nothing", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(100);
    partial("yes");
    speech = false;
    expect(d.settleInterruption("yes")).toBe(true);
    expect(library.stops).toBe(0);
  });

  it("an open brain approval also counts as a question she is waiting on", () => {
    approval = { id: "a1" };
    speech = true;
    d.beginInterruptCandidate();
    run(100);
    partial("haan");
    expect(library.stops).toBe(1);
  });

  it("speech with no words at all is paused at 600 ms and treated as a real interruption at 2.5 s", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(500);
    expect(library.stops).toBe(0);
    run(200);
    // Paused (the audio stops, nothing is cancelled), and the candidate still waits for words.
    expect(library.stops).toBe(1);
    expect(d.interruptGate.active).toBe(true);
    run(1700);
    expect(d.interruptGate.active).toBe(true);
    run(300);
    expect(d.interruptGate.active).toBe(false);
    expect(d.interruptHold).toBeTruthy();
    expect(stopCalls).toEqual([]);
  });
});

describe("the setting and the wiring", () => {
  it("off means voice activity pauses her at once, as before; on is the default", () => {
    expect(d.gateEnabled()).toBe(true);
    preferences.setVoice({ interruptGate: { enabled: false } as never });
    expect(d.gateEnabled()).toBe(false);
    expect(modeSource).toMatch(
      /if \(this\.gateEnabled\(\)\) this\.beginInterruptCandidate\(\);\s*else \{[\s\S]{0,200}this\.holdForInterruption\(\);/,
    );
  });

  it("the gate never reads a speaker match: it cannot approve, interrupt or release anything", () => {
    const start = modeSource.indexOf("private gateEnabled()");
    const end = modeSource.indexOf("private holdForInterruption(");
    const region = modeSource.slice(start, end);
    expect(region.length).toBeGreaterThan(500);
    expect(region).not.toMatch(/speakerDecision|scoreUtterance|turnVoice|personalWake|ownerVoice/);
  });

  it("the stop of the voice and every end of the candidate also restore her volume", () => {
    expect(modeSource).toMatch(
      /private endInterruptCandidate\(restoreVolume = false\)[\s\S]{0,420}duckSpeech\(false\)/,
    );
    expect(modeSource).toMatch(
      /this\.discardEager\(\);\s*if \(!this\.gateKeep\) this\.endInterruptCandidate\(\);/,
    );
    expect(modeSource).toMatch(
      /this\.interruptHold = null;\s*this\.endInterruptCandidate\(true\);/,
    );
  });
});

describe("review fixes: pause on voice, decide on words", () => {
  it("voice that goes on for 600 ms pauses her (stops the audio, keeps the answer); the candidate stays open", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(500);
    expect(library.stops).toBe(0);
    run(200);
    expect(library.stops).toBe(1);
    expect(d.interruptHold).toBeTruthy();
    expect(d.interruptGate.active).toBe(true);
    // Paused is not cancelled: the answer keeps being written and nothing is truncated yet.
    expect(stopCalls).toEqual([]);
    expect(truncated).toEqual([]);
  });

  it("a nod that arrives as the final after the pause resumes her: nothing is cancelled or cut", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(700);
    speech = false;
    expect(d.interruptHold).toBeTruthy();
    expect(d.settleInterruption("haan")).toBe(true);
    expect(d.interruptHold).toBeNull();
    expect(d.interruptGate.active).toBe(false);
    expect(stopCalls).toEqual([]);
    expect(truncated).toEqual([]);
  });

  it("voice with no words at all and then silence resumes her after the wait for the final", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(700);
    speech = false;
    run(4300);
    expect(d.interruptHold).toBeNull();
    expect(d.interruptGate.active).toBe(false);
    expect(stopCalls).toEqual([]);
  });

  it("her own echo never pauses her", () => {
    d.spokenText = "the report is ready for you";
    speech = true;
    d.beginInterruptCandidate();
    partial("the report is ready for you");
    run(1500);
    expect(library.stops).toBe(0);
  });

  it("real words after the pause end the candidate, keep the pause, and the final confirms the cut", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(700);
    partial("open the other report");
    expect(d.interruptGate.active).toBe(false);
    expect(d.interruptHold).toBeTruthy();
    expect(stopCalls).toEqual([]);
    speech = false;
    expect(d.settleInterruption("open the other report")).toBe(false);
    expect(stopCalls).toEqual(["foreground"]);
    expect(truncated).toEqual([["run-1", "First open the report.", 1100]]);
  });

  it("the live words feed the gate while she speaks, so a stop word is known before the final", () => {
    const start = modeSource.indexOf("private startLiveWords()");
    const body = modeSource.slice(start, modeSource.indexOf("private stopLiveWords("));
    expect(body).toMatch(
      /onUpdate: \(update\) => \{(?:\s*\/\/[^\n]*)?\s*if \(this\.interruptGate\.active \|\| this\.interruptHold\) \{[\s\S]{0,120}update\.settled[\s\S]{0,200}this\.gateText = settled;[\s\S]{0,80}this\.stepInterruptGate\(false\)/,
    );
    const begin = modeSource.slice(
      modeSource.indexOf("private beginInterruptCandidate()"),
      modeSource.indexOf("private endInterruptCandidate("),
    );
    expect(begin).toMatch(/voice\.liveWords === true[\s\S]{0,160}this\.startLiveWords\(\)/);
  });
});

describe("review fixes: one-word interruptions and the approval answer", () => {
  it.each(["nahi", "no", "nahin", "nope", "cancel", "galat", "नहीं"])(
    "a final '%s' with nothing asked is not dropped: she stops and it goes on as the owner's turn",
    (word) => {
      speech = true;
      d.beginInterruptCandidate();
      run(300);
      speech = false;
      expect(d.settleInterruption(word)).toBe(false);
      expect(stopCalls).toEqual(["foreground"]);
    },
  );

  it.each(["kya", "wapas", "report"])(
    "a final single real word (%s) is a turn, never silently dropped",
    (word) => {
      speech = true;
      d.beginInterruptCandidate();
      run(300);
      speech = false;
      expect(d.settleInterruption(word)).toBe(false);
      expect(stopCalls).toEqual(["foreground"]);
    },
  );

  it("a pure nod (hmm) still only restores her volume and is consumed", () => {
    speech = true;
    d.beginInterruptCandidate();
    run(300);
    speech = false;
    expect(d.settleInterruption("hmm")).toBe(true);
    expect(stopCalls).toEqual([]);
  });

  it("a spoken yes to an app-control approval (the Brain's own approval) is not swallowed as a nod", () => {
    approval = { id: "app-restart" };
    d.holdForInterruption();
    expect(d.interruptHold).toBeTruthy();
    expect(d.settleInterruption("yes")).toBe(false);
    expect(modeSource).toMatch(
      /waitingForAnswer: this\.waitingForOwner\(\),\s*selfEcho: this\.isSelfEcho\(text\)/,
    );
    expect(modeSource).not.toMatch(
      /waitingForAnswer: Boolean\(this\.state\.pending \|\| this\.pendingHeard\)/,
    );
  });

  it("the same yes with nothing asked is a nod and resumes her", () => {
    d.holdForInterruption();
    expect(d.settleInterruption("yes")).toBe(true);
    expect(d.interruptHold).toBeNull();
  });

  it("the duck level is the setting (0.3 by default) and reaches the player", () => {
    speech = true;
    d.beginInterruptCandidate();
    expect(library.levels[0]).toBe(0.3);
    run(100);
    // end it, change the setting, begin again
    d.settleInterruption("hmm");
    preferences.setVoice({ interruptGate: { duckLevel: 0.5 } as never });
    d.beginInterruptCandidate();
    expect(library.levels.at(-1)).toBe(0.5);
    preferences.setVoice({ interruptGate: { duckLevel: 0.3 } as never });
  });
});
