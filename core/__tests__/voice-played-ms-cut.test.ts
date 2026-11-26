/**
 * Truncation to what was played: the sample player counts the milliseconds the speaker really played (the audio
 * clock minus the output buffer), each clause carries its start and end on that clock, and a cut at a barge-in
 * keeps only the clauses whose end is at or before the played milliseconds. Fake audio context, fake clock, no
 * speaker; the live path is source-pinned at the end.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PcmClipPlayer, type PcmContext } from "../../src/lib/friday/voice-engine/pcm-clip-player";
import { PcmPlayback } from "../../src/lib/friday/voice-engine/playback-scheduler";
import { PlayedTextTracker } from "../../src/lib/friday/voice-engine/played-text";

const root = resolve(import.meta.dirname, "../..");
const source = (rel: string) => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");

const RATE = 1000; // 1 sample = 1 ms, so a clip's length in samples is its length in milliseconds

class FakeNode {
  inputs: unknown[] = [];
  connect(node: unknown) {
    this.inputs.push(node);
  }
}
class FakeGain extends FakeNode {
  gain = {
    value: 1,
    targets: [] as number[],
    setTargetAtTime(target: number) {
      this.targets.push(target);
      this.value = target;
    },
  };
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  when = -1;
  stopped = false;
  onended: (() => void) | null = null;
  start(when?: number) {
    this.when = when ?? 0;
  }
  stop() {
    this.stopped = true;
  }
}
class FakeContext {
  currentTime = 0;
  sampleRate = RATE;
  state = "running";
  destination = { id: "speaker" };
  outputLatency = 0;
  baseLatency = 0;
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  createBuffer() {
    return { copyToChannel: () => undefined };
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
}

const pcm = (ms: number) => new Int16Array(ms).fill(1000);
const timers = () => ({
  setTimeout: () => 0,
  clearTimeout: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
});

describe("the sample player's played milliseconds", () => {
  it("is the audio clock minus the output buffer, never past what was scheduled", () => {
    const ctx = new FakeContext();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE });
    playback.enqueue(pcm(2000));
    ctx.currentTime = 1.5;
    expect(playback.playedMs()).toBe(1500);
    ctx.outputLatency = 0.12;
    expect(playback.playedMs()).toBe(1380);
    // The base latency is used when the browser reports no output latency.
    ctx.outputLatency = 0;
    ctx.baseLatency = 0.02;
    expect(playback.playedMs()).toBe(1480);
    // Past the end of the audio nothing more was played.
    ctx.currentTime = 9;
    expect(playback.playedMs()).toBe(2000);
    // Before the speaker could have made a sound the figure is zero, not negative.
    ctx.currentTime = 0.01;
    ctx.outputLatency = 0.2;
    expect(playback.playedMs()).toBe(0);
  });

  it("a gap between two clauses counts as time that passed, not as speech", () => {
    const ctx = new FakeContext();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE });
    playback.enqueue(pcm(1000));
    ctx.currentTime = 1.5; // the first clause ended at 1.0; the next clause was not ready until 1.5
    playback.enqueue(pcm(1000));
    expect(playback.lastSpan()).toEqual({ startMs: 1500, endMs: 2500 });
    ctx.currentTime = 2.0;
    expect(playback.playedMs()).toBe(2000);
    ctx.currentTime = 9;
    expect(playback.playedMs()).toBe(2500);
  });

  it("flush reports what was played and starts a fresh clock", () => {
    const ctx = new FakeContext();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE });
    playback.enqueue(pcm(3000));
    ctx.currentTime = 1;
    expect(playback.flush()).toBe(1000);
    expect(playback.playedMs()).toBe(0);
    expect(playback.lastSpan()).toBeNull();
  });

  it("without a gain stage the sources play straight to the speaker; with one they go through it", () => {
    const plain = new FakeContext();
    (plain as unknown as { createGain?: unknown }).createGain = undefined;
    const a = new PcmPlayback(plain as unknown as PcmContext, { rate: RATE });
    a.enqueue(pcm(100));
    expect(plain.sources[0]?.inputs).toEqual([plain.destination]);
    expect(a.setDuck(0.3)).toBe(false);

    const ctx = new FakeContext();
    const b = new PcmPlayback(ctx as unknown as PcmContext, { rate: RATE });
    b.enqueue(pcm(100));
    expect(ctx.sources[0]?.inputs).toEqual([ctx.gains[0]]);
    expect(ctx.gains[0]?.inputs).toEqual([ctx.destination]);
    expect(b.setDuck(0.3)).toBe(true);
    expect(ctx.gains[0]?.gain.value).toBe(0.3);
    b.setDuck(1);
    expect(ctx.gains[0]?.gain.value).toBe(1);
    // A duck asked before the first clause is applied when the gain stage is made.
    const ctx2 = new FakeContext();
    const c = new PcmPlayback(ctx2 as unknown as PcmContext, { rate: RATE });
    c.setDuck(0.25);
    c.enqueue(pcm(100));
    expect(ctx2.gains[0]?.gain.value).toBe(0.25);
  });

  it("the clip carries its span and the player reports the answer's played milliseconds and ducks", () => {
    const ctx = new FakeContext();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, { timers: timers() });
    const first = player.start(pcm(1000), RATE);
    const second = player.start(pcm(1200), RATE);
    expect(first.span).toEqual({ startMs: 0, endMs: 1000 });
    expect(second.span).toEqual({ startMs: 1000, endMs: 2200 });
    ctx.outputLatency = 0.1;
    ctx.currentTime = 1.3;
    expect(first.playedMs()).toBe(1000);
    expect(second.playedMs()).toBeCloseTo(200, 3);
    expect(player.playedMs()).toBe(1200);
    expect(player.setDuck(0.3)).toBe(true);
    expect(ctx.gains[0]?.gain.value).toBe(0.3);
    expect(player.stop()).toBe(1200);
    expect(player.playedMs()).toBe(0);
  });
});

describe("a barge-in cuts the reply at the last clause boundary at or before the played milliseconds", () => {
  // Three clauses on the answer clock: A 0-1000, B 1000-2200, then a 500 ms wait, C 2700-3500.
  const record = () => {
    const tracker = new PlayedTextTracker(() => 0);
    tracker.begin("run-1");
    const add = (text: string, dur: number, startMs: number) =>
      tracker.startClip(text, dur, undefined, 0, { startMs, endMs: startMs + dur });
    add("First open the report.", 1000, 0);
    add("Then check the totals carefully.", 1200, 1000);
    add("Finally send it to Rahul.", 800, 2700);
    return tracker;
  };

  const table: Array<{
    playedMs: number;
    heard: string;
    whole: number;
    cutMs: number;
    interrupted: boolean;
  }> = [
    { playedMs: 0, heard: "", whole: 0, cutMs: 0, interrupted: true },
    { playedMs: 400, heard: "", whole: 0, cutMs: 0, interrupted: true },
    { playedMs: 999, heard: "", whole: 0, cutMs: 0, interrupted: true },
    { playedMs: 1000, heard: "First open the report.", whole: 1, cutMs: 1000, interrupted: true },
    { playedMs: 2199, heard: "First open the report.", whole: 1, cutMs: 1000, interrupted: true },
    {
      playedMs: 2200,
      heard: "First open the report. Then check the totals carefully.",
      whole: 2,
      cutMs: 2200,
      interrupted: true,
    },
    // In the gap before the third clause: the second is whole, the third has not begun.
    {
      playedMs: 2500,
      heard: "First open the report. Then check the totals carefully.",
      whole: 2,
      cutMs: 2200,
      interrupted: true,
    },
    {
      playedMs: 3400,
      heard: "First open the report. Then check the totals carefully.",
      whole: 2,
      cutMs: 2200,
      interrupted: true,
    },
    {
      playedMs: 3500,
      heard: "First open the report. Then check the totals carefully. Finally send it to Rahul.",
      whole: 3,
      cutMs: 3500,
      interrupted: false,
    },
  ];

  for (const row of table) {
    it(`played ${row.playedMs} ms`, () => {
      const cut = record().heardAtMs(row.playedMs);
      expect(cut.text).toBe(row.heard);
      expect(cut.wholeClips).toBe(row.whole);
      expect(cut.cutMs).toBe(row.cutMs);
      expect(cut.interrupted).toBe(row.interrupted);
      expect(cut.playedMs).toBe(row.playedMs);
      expect(cut.runId).toBe("run-1");
    });
  }

  it("the output latency moves the cut: the same clock reading hears less through a slow speaker", () => {
    const ctx = new FakeContext();
    const player = new PcmClipPlayer(ctx as unknown as PcmContext, { timers: timers() });
    const tracker = new PlayedTextTracker(() => 0);
    tracker.begin("run-2");
    const one = player.start(pcm(1000), RATE);
    tracker.startClip("One clause.", one.durationMs, undefined, 0, one.span);
    const two = player.start(pcm(1000), RATE);
    tracker.startClip("Two clauses.", two.durationMs, undefined, 0, two.span);
    ctx.currentTime = 2.05;
    expect(tracker.heardAtMs(player.playedMs()).text).toBe("One clause. Two clauses.");
    ctx.outputLatency = 0.2; // the last 200 ms are still in the speaker's buffer
    expect(tracker.heardAtMs(player.playedMs()).text).toBe("One clause.");
  });

  it("a clause with no span (audio element, system voice) counts by its own progress", () => {
    let now = 0;
    const tracker = new PlayedTextTracker(() => now);
    tracker.begin("run-3");
    tracker.startClip("Spoken by the element.", 1000);
    now = 600;
    expect(tracker.heardAtMs(5000).text).toBe("");
    now = 1000;
    expect(tracker.heardAtMs(0).text).toBe("Spoken by the element.");
  });

  it("a stop forgets the old clock: earlier sentences stay heard, later spans are not compared with the new clock", () => {
    const tracker = new PlayedTextTracker(() => 0);
    tracker.begin("run-5");
    const closeGroup = tracker.openGroup();
    tracker
      .startClip("First open the report.", 1000, undefined, 0, { startMs: 0, endMs: 1000 })
      .end();
    closeGroup();
    tracker.stop();
    // The player's clock restarted at the stop: a new clause at 0-500 is compared on the new clock only.
    tracker.startClip("Said again.", 500, undefined, 0, { startMs: 0, endMs: 500 });
    const after = tracker.heardAtMs(300);
    expect(after.text).toBe("First open the report.");
    expect(tracker.heardAtMs(500).text).toBe("First open the report. Said again.");
  });

  it("Hindi, Hinglish and punctuation come back exactly as spoken", () => {
    const tracker = new PlayedTextTracker(() => 0);
    tracker.begin("run-4");
    tracker.startClip("पहले रिपोर्ट खोलो।", 900, undefined, 0, { startMs: 0, endMs: 900 });
    tracker.startClip("Phir totals check karo, Rahul ko bhejo.", 1500, undefined, 0, {
      startMs: 900,
      endMs: 2400,
    });
    expect(tracker.heardAtMs(1000).text).toBe("पहले रिपोर्ट खोलो।");
    expect(tracker.heardAtMs(2400).text).toBe(
      "पहले रिपोर्ट खोलो। Phir totals check karo, Rahul ko bhejo.",
    );
  });

  it("garbage input is safe: a negative, NaN or empty record cuts nothing", () => {
    const tracker = record();
    expect(tracker.heardAtMs(-5).text).toBe("");
    expect(tracker.heardAtMs(Number.NaN).text).toBe("");
    expect(new PlayedTextTracker().heardAtMs(1000)).toMatchObject({
      text: "",
      words: 0,
      wholeClips: 0,
    });
  });
});

describe("the Brain keeps only what was heard of a reply the owner cut off", () => {
  it("marks the message interrupted with the played milliseconds, and the model sees the cut reply even when the run was stopped", async () => {
    const { brain, cutReplyForModel } = await import("../../src/lib/friday/brain-engine");
    brain.loadConversation([
      { id: "u1", role: "user", text: "walk me through it", at: 1, runId: "run-7" },
      {
        id: "f1",
        role: "friday",
        text: "First open the report. Then check the totals. Finally send it to Rahul.",
        at: 2,
        runId: "run-7",
      },
    ]);
    expect(brain.truncateAssistantReply("run-7", "First open the report.", 1234.6)).toBe(true);
    const stored = brain.getSnapshot().messages.find((m) => m.id === "f1");
    expect(stored).toMatchObject({
      interrupted: true,
      playedMs: 1235,
      playedText: "First open the report.",
    });
    expect(stored?.text).toContain("Finally send it to Rahul");
    const history = (
      brain as unknown as { historyForModel: (id: string) => Array<{ role: string; text: string }> }
    ).historyForModel("next-run");
    expect(history.find((l) => l.role === "friday")?.text).toBe(
      cutReplyForModel("First open the report."),
    );
    brain.loadConversation([]);
  }, 30_000);

  it("a stopped run whose reply was cut keeps the heard part in the model's context; an uncut stopped run still drops it", () => {
    const brainSource = source("src/lib/friday/brain-engine.ts");
    expect(brainSource).toMatch(/failed\.has\(m\.runId\) && m\.playedText === undefined/);
  });
});

describe("the cut with joined clauses", () => {
  it("a clause that overlaps the one before it is whole only at its own end, on the same clock", () => {
    const tracker = new PlayedTextTracker(() => 0);
    tracker.begin("r");
    tracker.startClip("First one.", 100, undefined, 0, { startMs: 0, endMs: 100 });
    tracker.startClip("Second one.", 100, undefined, 0, { startMs: 92, endMs: 192 });
    tracker.startClip("Third one.", 100, undefined, 0, { startMs: 184, endMs: 284 });
    expect(tracker.heardAtMs(99).text).toBe("");
    expect(tracker.heardAtMs(100).text).toBe("First one.");
    expect(tracker.heardAtMs(191.4).text).toBe("First one.");
    expect(tracker.heardAtMs(192).text).toBe("First one. Second one.");
    expect(tracker.heardAtMs(284)).toMatchObject({ wholeClips: 3, cutMs: 284, interrupted: false });
  });

  it("the sample player counts the overlapped time once", () => {
    const ctx = new FakeContext();
    const playback = new PcmPlayback(ctx as unknown as PcmContext, {
      rate: RATE,
      joinMs: 8,
      edgeFadeMs: 4,
    });
    playback.enqueue(pcm(1000));
    playback.enqueue(pcm(1000));
    ctx.currentTime = 5;
    expect(playback.playedMs()).toBeCloseTo(1992, 6);
  });
});

describe("wiring (source-pinned; the speaker cannot run here)", () => {
  const voiceLibrary = source("src/lib/friday/voice-library.ts");
  it("every raw-sample clause registers its span, and the cut reads the player's clock", () => {
    expect(voiceLibrary).toMatch(
      /startClip\(\s*heardText,\s*playing\.durationMs,[\s\S]{0,160}playing\.span,\s*\)/,
    );
    expect(voiceLibrary).toMatch(/playedTracker\.heardAtMs\(pcmPlayer\.playedMs\(\)\)/);
    expect(voiceLibrary).toContain("export function playedReplyCut()");
  });
  it("the tracker forgets the old clock at a stop", () => {
    expect(source("src/lib/friday/voice-engine/played-text.ts")).toMatch(/entry\.span = null;/);
  });
});
