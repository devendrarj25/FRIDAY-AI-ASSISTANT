/**
 * Privacy follows a line into the speech queue: a clause of a reply that was classified private, or of a private
 * turn, is marked in the queue and played on a local voice, whatever the words of that clause say. The Brain is told
 * when the heard command is private. Fake devices only: no speech engine, network or microphone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Plan = { privacy: boolean; argTuning: { allowCloud: boolean } };
type Driver = {
  state: Record<string, unknown> & { mode: string; muted: boolean; paused: boolean };
  arbiter: SpeechArbiter;
  replySensitive: boolean;
  turnSensitive: boolean;
  speak: (text: string, meta?: Record<string, unknown>) => void;
  speakPlan: (spoken: string, localOnly?: boolean, lineSensitive?: boolean) => Plan;
  playSpoken: (text: string, gen: number, sensitive?: boolean) => Promise<void>;
  drainSpeech: () => Promise<void>;
  dispatch: (command: string) => boolean;
  cancelSpeech: () => void;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

let queued: Array<{ text: string; sensitive?: boolean }> = [];

beforeEach(async () => {
  await preferences.hydrate();
  preferences.setVoice({
    hinglish: false,
    speechLang: "en-US",
    speakReplies: true,
    privacyMode: false,
  });
  autonomy.reset();
  Object.assign(d.state, { mode: "auto", muted: false, paused: false });
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  d.replySensitive = false;
  d.turnSensitive = false;
  queued = [];
  const enqueue = d.arbiter.enqueue.bind(d.arbiter);
  vi.spyOn(d.arbiter, "enqueue").mockImplementation(((item: {
    text: string;
    sensitive?: boolean;
  }) => {
    queued.push(item);
    return enqueue(item as never);
  }) as never);
  d.drainSpeech = async () => undefined;
  d.cancelSpeech = () => undefined;
  d.emit = () => undefined;
});

afterEach(() => {
  autonomy.reset();
  vi.restoreAllMocks();
});

describe("the queue keeps the privacy mark of a reply clause", () => {
  it("a clause of a private reply is marked, however harmless its words", () => {
    d.replySensitive = true;
    d.speak("The weather is mild today.", { reply: true });
    expect(queued[0]?.sensitive).toBe(true);
  });

  it("a clause of a private turn is marked too", () => {
    d.turnSensitive = true;
    d.speak("Here you go.", { reply: true });
    expect(queued[0]?.sensitive).toBe(true);
  });

  it("an ordinary clause is not", () => {
    d.speak("The weather is mild today.", { reply: true });
    expect(queued[0]?.sensitive).toBeUndefined();
  });
});

describe("the voice plan reads the mark", () => {
  it("a marked line keeps off a cloud voice", () => {
    const plain = d.speakPlan("The weather is mild today.");
    const marked = d.speakPlan("The weather is mild today.", false, true);
    expect(plain.privacy).toBe(false);
    expect(marked.privacy).toBe(true);
    expect(marked.argTuning.allowCloud).toBe(false);
  });

  it("a reply that is private as a whole keeps every later clause private", () => {
    d.replySensitive = true;
    expect(d.speakPlan("The weather is mild today.").privacy).toBe(true);
  });

  it("the queue hands the mark to the player", async () => {
    const seen: Array<boolean | undefined> = [];
    d.playSpoken = (_text: string, _gen: number, sensitive?: boolean) => {
      seen.push(sensitive);
      return Promise.resolve();
    };
    const real = Object.getPrototypeOf(d).drainSpeech as () => Promise<void>;
    d.arbiter.enqueue({ text: "Private clause here.", priority: "direct", sensitive: true });
    await real.call(d);
    expect(seen).toEqual([true]);
  });
});

describe("the Brain is told the turn is private", () => {
  it("a heard command that asks for a secret goes with turnSensitive", () => {
    const send = vi.spyOn(brain, "send").mockImplementation((() => ({ accepted: true })) as never);
    d.dispatch("what is my wifi password");
    const options = send.mock.calls[0]?.[1] as { turnSensitive?: boolean } | undefined;
    expect(options?.turnSensitive).toBe(true);
  });

  it("an ordinary command does not", () => {
    const send = vi.spyOn(brain, "send").mockImplementation((() => ({ accepted: true })) as never);
    d.dispatch("what is the weather like");
    const options = send.mock.calls[0]?.[1] as { turnSensitive?: boolean } | undefined;
    expect(options?.turnSensitive).toBeUndefined();
  });
});
