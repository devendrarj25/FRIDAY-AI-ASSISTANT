/**
 * A finished background task graph is announced through the voice desk (announceBackgroundTask) and is marked
 * announced only after the voice took the line (spoken or queued). Held lines (pause, quiet hours) are kept for the
 * digest, never dropped. Driven with injected state: no speech engine, microphone or network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { announceBackgroundTask } from "../../src/lib/friday/voice-engine/voice-tasks";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Driver = {
  state: Record<string, unknown> & { mode: string; paused: boolean; muted: boolean };
  arbiter: SpeechArbiter;
  narration: { held: string[] };
  callHold: boolean;
  drainSpeech: () => Promise<void>;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

let queued: string[] = [];

beforeEach(async () => {
  await preferences.hydrate();
  preferences.setVoice({ hinglish: false, speechLang: "en-US", speakReplies: true });
  autonomy.reset();
  Object.assign(d.state, { mode: "auto", paused: false, muted: false });
  d.callHold = false;
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  d.narration.held = [];
  queued = [];
  const enqueue = d.arbiter.enqueue.bind(d.arbiter);
  vi.spyOn(d.arbiter, "enqueue").mockImplementation(((item: { text: string }) => {
    queued.push(item.text);
    return enqueue(item as never);
  }) as never);
  d.drainSpeech = async () => undefined;
  d.emit = () => undefined;
});

afterEach(() => {
  autonomy.reset();
  vi.restoreAllMocks();
});

let seq = 0;
const update = (kind: "completed" | "failed" | "needs-approval", text: string) => ({
  taskId: `graph:g-${kind}-${(seq += 1)}`,
  kind,
  text,
});

describe("a finished graph reaches the voice desk", () => {
  it("a completed graph is spoken once, with its name", () => {
    expect(
      announceBackgroundTask(update("completed", "Built the report."), "build the report"),
    ).toBe(true);
    expect(queued.join(" ")).toMatch(/report/i);
    expect(queued.length).toBe(1);
  });

  it("a failed graph is spoken", () => {
    announceBackgroundTask(update("failed", "The download failed."), "fetch files");
    expect(queued.join(" ")).toMatch(/couldn't finish|fail/i);
  });
});

describe("a line the voice cannot say now is kept, not lost", () => {
  it("a paused session shows it and keeps it for the digest", () => {
    d.state.paused = true;
    announceBackgroundTask(update("completed", "Built the report."), "build the report");
    expect(queued).toEqual([]);
    expect(d.narration.held.join(" ")).toMatch(/report/i);
  });
});
