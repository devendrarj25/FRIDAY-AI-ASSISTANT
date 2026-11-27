/**
 * The echo window is the only guard against FRIDAY hearing her own voice, so it must be as long as her sound and no
 * longer. It used to open for two minutes the moment a clause started and close only when the play promise settled:
 * a promise that never settled left her deaf to the owner for two minutes. Now the window is the clip length (a lower
 * bound: while the sample player still has audio scheduled it stays open) plus a short tail, capped at 30 s, and
 * every stop lowers it. Fake clock, fake playback: no speaker, no microphone, no timers of the real kind.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const library = vi.hoisted(() => ({
  hooks: null as null | { onStart?: () => void; onEnd?: () => void },
  texts: [] as string[],
  backlogMs: null as number | null,
}));

vi.mock("../../src/lib/friday/voice-library", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/friday/voice-library")>();
  return {
    ...real,
    // A play promise that never settles: the engine hung after the first sound.
    speakText: vi.fn((text: string, _tuning: unknown, hooks: object = {}) => {
      library.texts.push(text);
      library.hooks = hooks;
      return new Promise<"neural">(() => undefined);
    }),
    playbackPressure: () =>
      library.backlogMs === null ? null : { backlogMs: library.backlogMs, underrunRisk: false },
    stopSpeaking: () => undefined,
  };
});

(globalThis as unknown as { window?: unknown }).window ??= globalThis;

import { assistantMode } from "../../src/lib/friday/assistant-mode";
import type { VoiceMatchResult } from "../../src/lib/friday/desktop";

type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    paused: boolean;
    muted: boolean;
    speaking: boolean;
    handsFree: boolean;
    pending: { command: string; reason: string; at: number } | null;
  };
  playSpoken: (text: string, gen: number) => Promise<void>;
  speechGen: number;
  dropPlayback: () => void;
  recentlySpeaking: () => boolean;
  handleHeard: (text: string) => void;
  acceptFinalUtterance: (utterance: { text: string; source: "local" }) => void;
  dispatch: (command: string) => void;
  speak: (text: string) => void;
  caption: (who: string, text: string) => void;
  emit: () => void;
  cancelSpeech: () => void;
  spokenText: string;
  echoUntil: number;
  awakeUntil: number;
  followUpUntil: number;
  turnVoice: VoiceMatchResult | null;
};
const d = assistantMode as unknown as Driver;

const T0 = 1_700_000_000_000;
const COMMAND = "delete my downloads folder";
let dispatched: string[] = [];

const hear = (text: string) => d.acceptFinalUtterance({ text, source: "local" });

/** Start a clause, let its first sound begin, and report that the state machine has already left SPEAKING. */
function startClause(text: string) {
  void d.playSpoken(text, d.speechGen);
  library.hooks?.onStart?.();
  d.state.speaking = false;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  library.hooks = null;
  library.texts = [];
  library.backlogMs = null;
  dispatched = [];
  Object.assign(d.state, {
    mode: "auto",
    paused: false,
    muted: false,
    speaking: false,
    handsFree: false,
    pending: null,
  });
  d.spokenText = "";
  d.echoUntil = 0;
  d.awakeUntil = 0;
  d.followUpUntil = 0;
  d.turnVoice = null;
  d.dispatch = (command: string) => void dispatched.push(command);
  d.speak = () => undefined;
  d.caption = () => undefined;
  d.emit = () => undefined;
  d.cancelSpeech = () => undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the echo window is bounded by the clip", () => {
  it("closes after a play promise that never settles (was open for two minutes)", () => {
    startClause("Shall I go ahead with that");
    expect(library.texts).toEqual(["Shall I go ahead with that"]);
    expect(d.recentlySpeaking()).toBe(true);
    vi.setSystemTime(T0 + 30_000);
    expect(d.recentlySpeaking()).toBe(false);
  });

  it("is the clip length plus a short tail, not minutes", () => {
    startClause("one two three four five");
    // five words are about 2 s of speech; the window ends a tail after that.
    expect(d.echoUntil - T0).toBeGreaterThanOrEqual(2000);
    expect(d.echoUntil - T0).toBeLessThanOrEqual(2000 + 1500 + 500);
    vi.setSystemTime(T0 + 6000);
    expect(d.recentlySpeaking()).toBe(false);
  });

  it("stays open while the sample player still has audio scheduled, up to a 30 s cap", () => {
    library.backlogMs = 40_000;
    startClause("hi");
    vi.setSystemTime(T0 + 10_000);
    expect(d.recentlySpeaking()).toBe(true);
    vi.setSystemTime(T0 + 29_000);
    expect(d.recentlySpeaking()).toBe(true);
    // A player whose clock froze still reports a backlog: the hard cap closes the window.
    vi.setSystemTime(T0 + 31_000);
    expect(d.recentlySpeaking()).toBe(false);
  });

  it("a longer clause than the word estimate is still covered while the player has it", () => {
    startClause("ok");
    expect(d.echoUntil - T0).toBeLessThanOrEqual(3000);
    library.backlogMs = 6000;
    vi.setSystemTime(T0 + 4000);
    expect(d.recentlySpeaking()).toBe(true);
    library.backlogMs = 0;
    vi.setSystemTime(T0 + 4000 + 6000 + 1600);
    expect(d.recentlySpeaking()).toBe(false);
  });

  it("every stop lowers the window to about a second and a half", () => {
    library.backlogMs = 20_000;
    startClause("this clause is stopped by the owner");
    vi.setSystemTime(T0 + 1000);
    library.backlogMs = null;
    const before = d.speechGen;
    d.dropPlayback();
    expect(d.speechGen).toBe(before + 1);
    expect(d.echoUntil).toBe(T0 + 1000 + 1500);
    vi.setSystemTime(T0 + 1000 + 1600);
    expect(d.recentlySpeaking()).toBe(false);
  });

  it("each new clause refreshes the window from its own start", () => {
    startClause("first part of the answer");
    vi.setSystemTime(T0 + 20_000);
    library.backlogMs = null;
    void d.playSpoken("second part of the answer", d.speechGen);
    library.hooks?.onStart?.();
    d.state.speaking = false;
    expect(d.recentlySpeaking()).toBe(true);
    vi.setSystemTime(T0 + 20_000 + 8000);
    expect(d.recentlySpeaking()).toBe(false);
  });

  it("an end of the clause lowers it to the short tail", () => {
    library.backlogMs = null;
    startClause("a long reply that is read out for the owner today");
    vi.setSystemTime(T0 + 1000);
    library.hooks?.onEnd?.();
    d.state.speaking = false;
    expect(d.echoUntil).toBe(T0 + 1000 + 1500);
  });
});

const match = (similarity: number): VoiceMatchResult => ({
  ok: true,
  enrolled: true,
  speaker: { enrolled: true, similarity, match: true, reason: "speaker-match" },
  wake: null,
});

describe("the source", () => {
  it("never opens the window for minutes on a clause start, and keeps the hard cap", () => {
    const source = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    expect(source).not.toMatch(/echoUntil = Date\.now\(\) \+ 120_000/);
    expect(source).toMatch(/const ECHO_CAP_MS = 30_000;/);
    expect(source).toMatch(
      /private recentlySpeaking\(\): boolean \{\s+this\.holdEchoWhilePlaying\(\);/,
    );
  });
});

describe("her own voice never approves anything", () => {
  beforeEach(() => {
    d.state.pending = { command: COMMAND, reason: "exec", at: Date.now() };
    d.awakeUntil = Date.now() + 8000;
    d.followUpUntil = Date.now() + 8000;
  });

  it("her own spoken yes played back inside the window is dropped, the command keeps waiting", () => {
    d.spokenText = "Shall I delete your downloads folder? Say yes";
    library.backlogMs = 5000;
    startClause(d.spokenText);
    expect(d.recentlySpeaking()).toBe(true);
    hear("yes");
    expect(dispatched).toEqual([]);
    expect(d.state.pending?.command).toBe(COMMAND);
  });

  it("her own spoken haan played back inside the window is dropped too", () => {
    d.spokenText = "Kya main folder delete kar doon? Bolo haan";
    library.backlogMs = 5000;
    startClause(d.spokenText);
    hear("haan");
    expect(dispatched).toEqual([]);
    expect(d.state.pending?.command).toBe(COMMAND);
  });

  it("the owner's yes after the window is over still approves (the control)", () => {
    d.spokenText = "Shall I delete your downloads folder? Say yes";
    startClause(d.spokenText);
    vi.setSystemTime(T0 + 31_000);
    d.state.pending = { command: COMMAND, reason: "exec", at: Date.now() };
    d.awakeUntil = Date.now() + 8000;
    d.followUpUntil = Date.now() + 8000;
    hear("yes");
    expect(dispatched).toEqual([COMMAND]);
  });

  it("a speaker match is never an approval: her voice with the owner's score on it still waits", () => {
    d.spokenText = "Shall I delete your downloads folder? Say yes";
    library.backlogMs = 5000;
    startClause(d.spokenText);
    d.turnVoice = match(0.99);
    hear("yes");
    expect(dispatched).toEqual([]);
    expect(d.state.pending?.command).toBe(COMMAND);
  });

  it("a strong match with nothing waiting never runs the old command", () => {
    d.state.pending = null;
    d.turnVoice = match(0.99);
    d.handleHeard("yes");
    expect(dispatched).not.toContain(COMMAND);
  });
});
