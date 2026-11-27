/**
 * A confirmation that is waiting for a yes: when it lapses it is dropped and said once, and the same line is then
 * heard as usual (a new command is not swallowed). While it is open, a line that is neither yes nor no is answered
 * with one short "still waiting" line, and a command that carries the wake word cancels it and goes on. A bare yes
 * after the lapse binds to nothing. The clock is fake; no microphone, speech engine or network is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import { routeUtterance } from "../../src/lib/friday/voice-engine/utterance-router";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Pending = { command: string; reason: string; at: number };
type Driver = {
  state: Record<string, unknown> & { mode: string; paused: boolean; pending: Pending | null };
  arbiter: SpeechArbiter;
  awakeUntil: number;
  followUpUntil: number;
  handleHeard: (text: string) => void;
  speak: (text: string, meta?: Record<string, unknown>) => void;
  cancelSpeech: () => void;
  stopRecognition: () => void;
  startRecognition: () => void;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

let spoken: string[] = [];
let sent: string[] = [];
const START = new Date("2026-03-02T10:00:00Z").getTime();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  await preferences.hydrate();
  preferences.setVoice({ hinglish: false, speechLang: "en-US", approvalTtlSec: 30 });
  autonomy.reset();
  Object.assign(d.state, { mode: "auto", paused: false, muted: false, handsFree: false });
  d.state.pending = { command: "delete my downloads", reason: "exec", at: START };
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  d.awakeUntil = START + 600_000;
  d.followUpUntil = START + 600_000;
  spoken = [];
  sent = [];
  d.speak = (text: string) => void spoken.push(text);
  d.cancelSpeech = () => undefined;
  d.stopRecognition = () => undefined;
  d.startRecognition = () => undefined;
  d.emit = () => undefined;
  vi.spyOn(brain, "send").mockImplementation(((text: string) => {
    sent.push(text);
    return { accepted: true };
  }) as never);
  vi.spyOn(brain, "stop").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  autonomy.reset();
  vi.restoreAllMocks();
});

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("a confirmation that lapsed", () => {
  it("is dropped, said once, and the same line is then heard as a new command", () => {
    later(45_000);
    d.handleHeard("Friday, open Chrome");
    expect(d.state.pending).toBeNull();
    expect(spoken.length).toBe(1);
    expect(spoken[0]).toMatch(/(timed out|lapsed|expired|too late|no longer)/i);
    expect(sent.join(" ")).toMatch(/open chrome/i);
  });

  it("a bare yes after the lapse says it lapsed and approves nothing", () => {
    later(45_000);
    d.handleHeard("yes");
    expect(d.state.pending).toBeNull();
    expect(spoken.length).toBe(1);
    expect(sent).toEqual([]);
  });
});

describe("a confirmation that is still open", () => {
  it("another line with no wake word gets one short 'still waiting' line", () => {
    later(5_000);
    d.handleHeard("what is the weather like today");
    expect(d.state.pending).not.toBeNull();
    expect(spoken).toEqual(["Still waiting for yes or no."]);
    expect(sent).toEqual([]);
  });

  it("the nudge is not repeated line after line", () => {
    later(5_000);
    d.handleHeard("what is the weather like today");
    later(2_000);
    d.handleHeard("and what about tomorrow then");
    expect(spoken.length).toBe(1);
  });

  it("a command that carries the wake word cancels it and is heard", () => {
    later(5_000);
    d.handleHeard("Friday, open Chrome");
    expect(d.state.pending).toBeNull();
    expect(sent.join(" ")).toMatch(/open chrome/i);
  });
});

describe("the router takes the owner's approval window", () => {
  const ask = (now: number, ttl?: number) =>
    routeUtterance({
      text: "yes",
      now,
      tasks: [],
      pendingApproval: { askedAt: START },
      busy: false,
      ...(ttl === undefined ? {} : { approvalTtlMs: ttl }),
    });

  it("a short window expires an answer the 30 s default would take", () => {
    expect(ask(START + 15_000).kind).toBe("approval-answer");
    expect(ask(START + 15_000, 10_000)).toMatchObject({ reason: "approval-expired" });
  });

  it("a long window takes an answer the default would drop", () => {
    expect(ask(START + 45_000)).toMatchObject({ reason: "approval-expired" });
    expect(ask(START + 45_000, 60_000).kind).toBe("approval-answer");
  });

  it("the conductor passes its own window (voice.approvalTtlSec)", () => {
    preferences.setVoice({ approvalTtlSec: 10 });
    const route = (
      d as unknown as { routeHeard: (t: string, a: { askedAt: number }) => unknown }
    ).routeHeard("yes", { askedAt: START - 15_000 });
    expect(route).toMatchObject({ reason: "approval-expired" });
  });
});
