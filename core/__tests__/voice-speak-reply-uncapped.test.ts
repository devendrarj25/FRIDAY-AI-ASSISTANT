/**
 * A spoken reply, an approval prompt and a digest line are said whole: the two-sentence cap is for stray lines
 * only. A multi-sentence reply piece is handed to the speech queue one sentence at a time, and a reply that comes
 * back empty still gets one short line instead of silence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Driver = {
  state: Record<string, unknown> & { mode: string; muted: boolean };
  arbiter: SpeechArbiter;
  speak: (text: string, meta?: Record<string, unknown>) => void;
  speakStreamed: (runId: string, text: string, final: boolean) => void;
  speakNewReplies: () => void;
  drainSpeech: () => Promise<void>;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

let said: string[] = [];

beforeEach(async () => {
  await preferences.hydrate();
  preferences.setVoice({ hinglish: false, speechLang: "en-US", speakReplies: true });
  autonomy.reset();
  Object.assign(d.state, { mode: "auto", muted: false, paused: false });
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  said = [];
  const enqueue = d.arbiter.enqueue.bind(d.arbiter);
  vi.spyOn(d.arbiter, "enqueue").mockImplementation(((item: { text: string }) => {
    said.push(item.text);
    return enqueue(item as never);
  }) as never);
  d.drainSpeech = async () => undefined;
  d.emit = () => undefined;
});

afterEach(() => {
  autonomy.reset();
  vi.restoreAllMocks();
});

const FOUR = "Alpha is first. Bravo is second. Charlie is third. Delta is fourth.";

describe("what is said whole", () => {
  it("a reply piece of four sentences is fully spoken, one queue item per sentence", () => {
    d.speakStreamed("run-1", FOUR, true);
    const all = said.join(" ");
    expect(all).toContain("Delta is fourth");
    expect(said.length).toBe(4);
    for (const line of said) expect(line.split(/[.!?]/).filter((p) => p.trim()).length).toBe(1);
  });

  it("an approval prompt keeps every sentence", () => {
    d.speak("Delete the folder. It has twelve files. Say yes or no. I will wait.", {
      priority: "approval",
    });
    expect(said.join(" ")).toContain("I will wait");
  });

  it("a digest line keeps every sentence", () => {
    d.speak("Two things finished. One needs you. Another failed. Check the desk.", {
      uncapped: true,
    });
    expect(said.join(" ")).toContain("Check the desk");
  });

  it("a stray line without the option stays at two sentences", () => {
    d.speak("One. Two. Three. Four.");
    const all = said.join(" ");
    expect(all).toContain("Two");
    expect(all).not.toContain("Four");
  });
});

describe("an empty reply", () => {
  it("speaks one short line instead of silence", () => {
    vi.spyOn(brain, "getSnapshot").mockReturnValue({
      messages: [{ id: "m1", role: "assistant", text: "   ", runId: "run-e" }],
      activeRunId: null,
      runs: [{ id: "run-e", state: "done", prompt: "hi", trace: [] }],
      approval: null,
    } as never);
    d.speakNewReplies();
    expect(said.length).toBe(1);
    expect(said[0]?.length ?? 0).toBeLessThan(60);
  });
});
