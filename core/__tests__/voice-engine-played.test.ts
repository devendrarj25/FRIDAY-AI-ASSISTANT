import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  countWords,
  firstWords,
  MAX_PLAYED_CLIPS,
  PlayedTextTracker,
} from "../../src/lib/friday/voice-engine/played-text";
import { DEFAULT_PREFERENCES, preferences } from "../../src/lib/friday/preferences";

const root = resolve(import.meta.dirname, "../..");
const source = (rel: string) => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");

/** A clock that only moves when the test says so. */
function clock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("words of a clause", () => {
  it("counts words in English, Hindi and mixed text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("Open the report.")).toBe(3);
    expect(countWords("मैं रिपोर्ट खोल रही हूँ।")).toBe(5);
    expect(countWords("Kal ka meeting रद्द है, ok?")).toBe(6);
  });

  it("cuts after a whole word and keeps the spacing and marks of the original", () => {
    const text = "Sure, I can do that. Then I will open it.";
    expect(firstWords(text, 0)).toBe("");
    expect(firstWords(text, 1)).toBe("Sure,");
    expect(firstWords(text, 5)).toBe("Sure, I can do that.");
    expect(firstWords(text, 99)).toBe(text);
    expect(firstWords("मैं रिपोर्ट खोल रही हूँ।", 2)).toBe("मैं रिपोर्ट");
  });
});

describe("PlayedTextTracker (fake clock)", () => {
  it("gives the whole clauses that finished plus the words of the one playing, rounded down", () => {
    const time = clock();
    const tracker = new PlayedTextTracker(time.now);
    tracker.begin("run-1");
    tracker.openGroup();
    const first = tracker.startClip("One two three four.", 2000);
    time.advance(2000);
    first.end();
    tracker.startClip("Five six seven eight nine ten.", 6000);
    time.advance(2500); // 2500 of 6000 ms = 0.416 of 6 words = 2 words
    const heard = tracker.snapshot();
    expect(heard.text).toBe("One two three four. Five six");
    expect(heard).toMatchObject({ runId: "run-1", words: 6, wholeClips: 1, interrupted: true });
  });

  it("never ends inside a word: just under the next word is the word before", () => {
    const time = clock();
    const tracker = new PlayedTextTracker(time.now);
    tracker.begin("r");
    tracker.startClip("alpha beta gamma delta", 4000);
    time.advance(2999); // 0.749 of 4 words
    expect(tracker.snapshot().text).toBe("alpha beta");
    time.advance(1); // exactly 0.75 -> 3 words
    expect(tracker.snapshot().text).toBe("alpha beta gamma");
  });

  it("counts a clause as whole only when its time is over, with no end call needed", () => {
    const time = clock();
    const tracker = new PlayedTextTracker(time.now);
    tracker.begin("r");
    tracker.startClip("one two", 1000);
    time.advance(1000);
    const heard = tracker.snapshot();
    expect(heard).toMatchObject({ text: "one two", wholeClips: 1, interrupted: false });
  });

  it("answers an empty string, not a guess, when the stop comes before any sound", () => {
    const time = clock();
    const tracker = new PlayedTextTracker(time.now);
    tracker.begin("r");
    tracker.openGroup();
    expect(tracker.snapshot()).toMatchObject({ text: "", words: 0, interrupted: true });
    tracker.startClip("hello there", 1000);
    expect(tracker.snapshot()).toMatchObject({ text: "", words: 0, interrupted: true });
  });

  it("follows the audio element's own position and length when a probe is given", () => {
    const time = clock();
    const tracker = new PlayedTextTracker(time.now);
    tracker.begin("r");
    let currentTime = 0;
    // The clock says a lot of time passed (a stalled element), the element says 1.5 s of 3 s.
    tracker.startClip("a b c d e f", 0, () => ({ elapsedMs: currentTime * 1000, durMs: 3000 }));
    time.advance(60_000);
    currentTime = 1.5;
    expect(tracker.snapshot().text).toBe("a b c");
    currentTime = 3;
    expect(tracker.snapshot()).toMatchObject({ text: "a b c d e f", interrupted: false });
  });

  it("estimates a clip that reports no length from its words", () => {
    const time = clock();
    const tracker = new PlayedTextTracker(time.now);
    tracker.begin("r");
    tracker.startClip("one two three four five", 0); // 5 words x 400 ms = 2000 ms
    time.advance(800);
    expect(tracker.snapshot().text).toBe("one two");
    tracker.startClip("six", Number.NaN);
    expect(tracker.size()).toBe(2);
  });

  it("a stop drops the sentence that was cut and keeps the sentences before it", () => {
    const time = clock();
    const tracker = new PlayedTextTracker(time.now);
    tracker.begin("r");
    const closeOne = tracker.openGroup();
    tracker.startClip("First sentence here.", 1000).end();
    time.advance(1000);
    closeOne();
    tracker.openGroup();
    tracker.startClip("Second one goes", 1000);
    time.advance(1000);
    tracker.startClip("on and on.", 1000);
    time.advance(500);
    const stopped = tracker.stop();
    expect(stopped.text).toBe("First sentence here. Second one goes on");
    expect(stopped.interrupted).toBe(true);
    // The cut sentence is said again from its start if the reply goes on, so only the first sentence stays.
    expect(tracker.size()).toBe(1);
    expect(tracker.snapshot()).toMatchObject({ text: "First sentence here.", interrupted: false });
  });

  it("a second stop with nothing playing answers the same heard text and is not an interruption", () => {
    const time = clock();
    const tracker = new PlayedTextTracker(time.now);
    tracker.begin("r");
    const close = tracker.openGroup();
    tracker.startClip("done and dusted", 600).end();
    close();
    const first = tracker.stop();
    const second = tracker.stop();
    expect(first.interrupted).toBe(false);
    expect(second).toEqual(first);
  });

  it("a sentence that ends late cannot close a newer sentence", () => {
    const tracker = new PlayedTextTracker(clock().now);
    tracker.begin("r");
    const closeOld = tracker.openGroup();
    tracker.stop();
    tracker.openGroup();
    closeOld();
    expect(tracker.snapshot().interrupted).toBe(true);
  });

  it("a clip that never made a sound is not counted as heard", () => {
    const time = clock();
    const tracker = new PlayedTextTracker(time.now);
    tracker.begin("r");
    tracker.startClip("never heard clip", 1000).drop();
    time.advance(5000);
    expect(tracker.snapshot()).toMatchObject({ text: "", words: 0 });
  });

  it("a different run forgets the earlier reply; the same run keeps it; force clears it", () => {
    const time = clock();
    const tracker = new PlayedTextTracker(time.now);
    tracker.begin("run-a");
    tracker.startClip("kept words", 100).end();
    tracker.begin("run-a");
    expect(tracker.size()).toBe(1);
    tracker.begin("run-b");
    expect(tracker.size()).toBe(0);
    expect(tracker.snapshot().runId).toBe("run-b");
    tracker.startClip("again", 100);
    tracker.begin("run-b", true);
    expect(tracker.size()).toBe(0);
  });

  it("is bounded, and ignores an empty clause", () => {
    const tracker = new PlayedTextTracker(clock().now);
    tracker.begin("r");
    for (let i = 0; i < MAX_PLAYED_CLIPS + 20; i += 1) tracker.startClip(`w${i}`, 10).end();
    tracker.startClip("   ", 10);
    expect(tracker.size()).toBe(MAX_PLAYED_CLIPS);
  });
});

describe("the played text through the voice library (real module, fake devices)", () => {
  type Win = Record<string, unknown> & { AudioContext?: unknown };
  const g = globalThis as unknown as { window?: Win | undefined; Audio?: unknown };
  const saved = { window: g.window, Audio: g.Audio };
  const tuning = {
    voiceName: "",
    lang: "en-IN",
    rate: 1,
    pitch: 1,
    volume: 0.8,
    kind: "neural" as const,
  };
  let lib: typeof import("../../src/lib/friday/voice-library");
  let element: { currentTime: number; duration: number } | null;
  const capture = (audio: { currentTime: number; duration: number }) => {
    element = audio;
  };

  class Ctx {
    static last: Ctx | null = null;
    currentTime = 0;
    sampleRate = 48_000;
    state = "running";
    destination = {};
    constructor() {
      Ctx.last = this;
    }
    createBuffer() {
      return { copyToChannel: () => undefined };
    }
    createBufferSource() {
      return {
        buffer: null,
        connect: () => undefined,
        start: () => undefined,
        stop: () => undefined,
        onended: null,
      };
    }
    resume() {
      return Promise.resolve();
    }
  }

  beforeEach(async () => {
    element = null;
    Ctx.last = null;
    class FakeAudio {
      volume = 1;
      currentTime = 0;
      duration = 4;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {
        capture(this);
      }
      // The clip never ends by itself: the test stops it.
      play() {
        return Promise.resolve();
      }
      pause() {}
    }
    g.Audio = FakeAudio;
    lib = await import("../../src/lib/friday/voice-library");
    lib.resetPrefetchedSpeech();
    lib.resetPcmPlayback();
    lib.beginPlayedReply("run-1", true);
  });
  afterEach(() => {
    lib.stopSpeaking();
    lib.resetPcmPlayback();
    g.window = saved.window;
    g.Audio = saved.Audio;
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
  });

  it("reads the heard words of a file clip from the audio element's position", async () => {
    g.window = {
      friday: {
        speakNeural: async () => ({
          ok: true,
          audioBase64: "AAAA",
          mime: "audio/wav",
          engine: "supertonic-3",
          voice: "F2",
        }),
      },
    };
    const speaking = lib.speakText("alpha beta gamma delta", tuning);
    await new Promise((done) => setTimeout(done, 20));
    expect(element).not.toBeNull();
    (element as unknown as { currentTime: number }).currentTime = 2.5; // 2.5 s of 4 s
    expect(lib.playedReplySnapshot()).toMatchObject({
      runId: "run-1",
      text: "alpha beta",
      words: 2,
      interrupted: true,
    });
    lib.stopSpeaking();
    expect(await speaking).toBe("none");
    // The sentence that was cut left the record, and nothing is playing now.
    expect(lib.playedReplySnapshot()).toMatchObject({ text: "", interrupted: false });
  });

  it("reads the heard words of a raw-sample clip from the audio clock of the player", async () => {
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, pcmPlayback: true } });
    const samples = new Int16Array(44_100).fill(3000); // one second at 44.1 kHz
    g.window = {
      AudioContext: Ctx,
      friday: {
        // speakText needs the file voice bridge to take the neural route; the raw samples are used when asked for.
        speakNeural: async () => ({ ok: false, reason: "not used" }),
        speakNeuralPcm: async () => ({
          ok: true,
          engine: "supertonic-3",
          voice: "F2",
          sampleRate: 44_100,
          pcm: new Uint8Array(samples.buffer),
        }),
      },
    };
    const speaking = lib.speakText("one two three four", tuning);
    await new Promise((done) => setTimeout(done, 20));
    const context = Ctx.last as Ctx;
    context.currentTime = 0.5; // half of the one second clip
    expect(lib.playedReplySnapshot()).toMatchObject({ text: "one two", words: 2 });
    context.currentTime = 0.76;
    expect(lib.playedReplySnapshot().text).toBe("one two three");
    lib.stopSpeaking();
    expect(await speaking).toBe("none");
  });

  it("a different run id starts a fresh record", async () => {
    g.window = {
      friday: {
        speakNeural: async () => ({
          ok: true,
          audioBase64: "AAAA",
          mime: "audio/wav",
          engine: "supertonic-3",
        }),
      },
    };
    void lib.speakText("one two three four", tuning);
    await new Promise((done) => setTimeout(done, 20));
    (element as unknown as { currentTime: number }).currentTime = 4;
    expect(lib.playedReplySnapshot().words).toBe(4);
    lib.beginPlayedReply("run-2");
    expect(lib.playedReplySnapshot()).toMatchObject({ runId: "run-2", text: "", words: 0 });
  });
});

describe("the Brain keeps only what was heard (Brain store, no network)", () => {
  it("marks the message cut, keeps the whole text, and shows the model only the heard part", async () => {
    const { brain, cutReplyForModel } = await import("../../src/lib/friday/brain-engine");
    const messages = [
      { id: "m1", role: "user" as const, text: "tell me the plan", at: 1, runId: "run-9" },
      {
        id: "m2",
        role: "friday" as const,
        text: "First open the report. Then check the totals. Finally send it to Rahul.",
        at: 2,
        runId: "run-9",
      },
    ];
    expect(brain.loadConversation(messages)).toBe(true);
    expect(brain.truncateAssistantReply("run-none", "x")).toBe(false);
    expect(brain.truncateAssistantReply("run-9", "First open the report.")).toBe(true);
    const stored = brain.getSnapshot().messages.find((m) => m.id === "m2");
    expect(stored?.text).toBe(
      "First open the report. Then check the totals. Finally send it to Rahul.",
    );
    expect(stored?.playedText).toBe("First open the report.");
    const history = (
      brain as unknown as { historyForModel: (id: string) => Array<{ role: string; text: string }> }
    ).historyForModel("another-run");
    const reply = history.find((line) => line.role === "friday");
    expect(reply?.text).toBe(cutReplyForModel("First open the report."));
    expect(reply?.text).toContain("First open the report.");
    expect(reply?.text).toContain("interrupted");
    expect(reply?.text).not.toContain("Finally send it to Rahul");
    // Nothing heard at all is also remembered, with its own marker.
    brain.truncateAssistantReply("run-9", "");
    expect(cutReplyForModel("")).toContain("before any of it was heard");
    const after = (
      brain as unknown as { historyForModel: (id: string) => Array<{ role: string; text: string }> }
    ).historyForModel("another-run");
    expect(after.find((line) => line.role === "friday")?.text).toBe(cutReplyForModel(""));
    brain.loadConversation([]);
  });
});

describe("wiring of the played text (source-pinned; the live path cannot run here)", () => {
  const mode = source("src/lib/friday/assistant-mode.ts");
  const brainSrc = source("src/lib/friday/brain-engine.ts");

  it("the setting defaults on and has one toggle row and a flow registry entry", () => {
    expect(DEFAULT_PREFERENCES.voice.trimHistoryToPlayed).toBe(true);
    expect(source("src/lib/friday/preferences.ts")).toMatch(/trimHistoryToPlayed: true,/);
    expect(source("src/lib/friday/flow-registry.gen.ts")).toContain('"voice.trimHistoryToPlayed"');
    const ui = source("src/components/friday/settings/VoiceSettings.tsx");
    expect(ui.match(/prefs\.voice\.trimHistoryToPlayed !== false/g)).toHaveLength(1);
    expect(ui).toMatch(/preferences\.setVoice\(\{\s*trimHistoryToPlayed:/);
  });

  it("the heard part is read before the voice is stopped and stored only on a judged interruption", () => {
    const hold = mode.slice(
      mode.indexOf("private holdForInterruption("),
      mode.indexOf("private armInterruptTimer"),
    );
    expect(hold.indexOf("this.heldPlayed = this.heardOfReply()")).toBeGreaterThan(-1);
    expect(hold.indexOf("this.heldPlayed = this.heardOfReply()")).toBeLessThan(
      hold.indexOf("this.dropPlayback()"),
    );
    const confirm = mode.slice(
      mode.indexOf("private confirmInterruption()"),
      mode.indexOf("private heardOfReply()"),
    );
    expect(confirm.indexOf("brain.stop()")).toBeLessThan(
      confirm.indexOf("this.trimReplyToHeard(this.heldPlayed)"),
    );
    const resume = mode.slice(
      mode.indexOf("private resumeAfterInterruption()"),
      mode.indexOf("private confirmInterruption()"),
    );
    expect(resume).toContain("this.heldPlayed = null");
    expect(resume).not.toContain("trimReplyToHeard");
    const gate = mode.slice(
      mode.indexOf("private heardOfReply()"),
      mode.indexOf("private trimReplyToHeard"),
    );
    expect(gate).toContain("voice.trimHistoryToPlayed === false");
    expect(gate).toContain("heard.runId !== runId");
    expect(mode).toContain("brain.truncateAssistantReply(heard.runId, heard.text, playedMs)");
    // The sample player's clock cuts at a clause boundary; the element path falls back to counted words.
    expect(gate).toContain("playedReplyCut()");
    expect(gate).toContain("playedReplySnapshot()");
  });

  it("a reply starts its own record and a rewrite starts it again", () => {
    expect(mode).toMatch(/this\.voicedRunId = runId;[\s\S]{0,200}beginPlayedReply\(runId\);/);
    expect(mode).toMatch(
      /this\.dropPlayback\(false\);[\s\S]{0,120}beginPlayedReply\(runId, true\);/,
    );
  });

  it("the Brain exposes the cut and shows the model the marker, never the unheard rest", () => {
    expect(brainSrc).toContain(
      "truncateAssistantReply(runId: string, playedText: string, playedMs?: number): boolean",
    );
    expect(brainSrc).toMatch(/playedText: heard,\s*interrupted: true,/);
    expect(brainSrc).toMatch(
      /m\.playedText === undefined \? m\.text : cutReplyForModel\(m\.playedText\)/,
    );
  });
});
