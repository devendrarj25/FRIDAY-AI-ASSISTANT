import { describe, expect, it } from "vitest";
import {
  BargeInDetector,
  classifyVoiceControl,
  InterruptController,
} from "../../src/lib/friday/voice-engine/interruption-controller";
import { TaskAnnouncer } from "../../src/lib/friday/voice-engine/task-announcer";

const frame = (t: number, speech: boolean, mic: number, play: number) => ({
  t,
  speech,
  micLevel: mic,
  playbackLevel: play,
});

describe("BargeInDetector", () => {
  it("ignores speech while nothing plays", () => {
    const d = new BargeInDetector();
    expect(d.push(frame(1000, true, 0.5, 0))).toBe(false);
  });

  it("ignores the start of FRIDAY's own reply", () => {
    const d = new BargeInDetector({ guardMs: 250, minSpeechMs: 100 });
    d.playbackStarted(0);
    expect(d.push(frame(100, true, 0.5, 0.1))).toBe(false);
    expect(d.push(frame(200, true, 0.5, 0.1))).toBe(false);
  });

  it("does not take echo for the owner", () => {
    const d = new BargeInDetector({ minSpeechMs: 100, guardMs: 0 });
    d.playbackStarted(0);
    for (let t = 0; t < 2000; t += 20) expect(d.push(frame(t, true, 0.3, 0.3))).toBe(false);
  });

  it("fires once after sustained voice louder than the echo", () => {
    const d = new BargeInDetector({ minSpeechMs: 100, guardMs: 0 });
    d.playbackStarted(0);
    const fired: number[] = [];
    for (let t = 20; t <= 400; t += 20) if (d.push(frame(t, true, 0.5, 0.2))) fired.push(t);
    expect(fired).toEqual([120]);
  });

  it("debounces a short burst", () => {
    const d = new BargeInDetector({ minSpeechMs: 150, guardMs: 0 });
    d.playbackStarted(0);
    expect(d.push(frame(20, true, 0.5, 0.1))).toBe(false);
    expect(d.push(frame(60, false, 0.5, 0.1))).toBe(false);
    expect(d.push(frame(100, true, 0.5, 0.1))).toBe(false);
    expect(d.push(frame(200, true, 0.5, 0.1))).toBe(false);
  });
});

describe("InterruptController", () => {
  it("stops audible playback first, then the rest in order", async () => {
    const order: string[] = [];
    let t = 0;
    const c = new InterruptController(
      {
        playback: () => void order.push("playback"),
        ttsRequest: () => void order.push("tts"),
        answerStream: () => void order.push("stream"),
        queue: () => void order.push("queue"),
        providerTruncate: () => void order.push("truncate"),
      },
      () => (t += 10),
    );
    const report = await c.interrupt("barge-in");
    expect(order).toEqual(["playback", "tts", "stream", "queue", "truncate"]);
    expect(report?.audibleStopMs).toBe(10);
    expect(report?.failed).toEqual([]);
  });

  it("keeps going when one step throws and reports it", async () => {
    const ran: string[] = [];
    const c = new InterruptController({
      playback: () => {
        throw new Error("device gone");
      },
      queue: () => void ran.push("queue"),
    });
    const report = await c.interrupt("stop");
    expect(ran).toEqual(["queue"]);
    expect(report?.failed).toEqual([{ step: "playback", error: "device gone" }]);
  });

  it("ignores a second interrupt while one runs and allows one after", async () => {
    let release: () => void = () => undefined;
    let first_call = true;
    const c = new InterruptController({
      playback: () =>
        first_call ? new Promise<void>((r) => ((first_call = false), (release = r))) : undefined,
    });
    const first = c.interrupt("a");
    expect(await c.interrupt("b")).toBeNull();
    release();
    expect(await first).not.toBeNull();
    expect(await c.interrupt("c")).not.toBeNull();
  });
});

describe("classifyVoiceControl", () => {
  it.each([
    ["Friday, ruk jao", "stop-speaking"],
    ["ruko zara", "stop-speaking"],
    ["stop", "stop-speaking"],
    ["रुको", "stop-speaking"],
    ["chup ho jao", "stop-speaking"],
    ["cancel the background task", "cancel-task"],
    ["background kaam band karo", "cancel-task"],
    ["task pause karo", "pause-task"],
    ["task resume karo", "resume-task"],
    ["mat suno", "stop-listening"],
    ["Ruko, pehle meri baat suno", "stop-speaking"],
    ["Aaj ka weather batao", "none"],
    ["Is report ka summary bana do", "none"],
  ])("%s -> %s", (heard, kind) => {
    expect(classifyVoiceControl(heard).kind).toBe(kind);
  });

  it("a plain stop never cancels a task", () => {
    expect(classifyVoiceControl("ruk jao").kind).not.toBe("cancel-task");
  });
});

describe("TaskAnnouncer", () => {
  it("speaks at once when idle", () => {
    const a = new TaskAnnouncer();
    expect(a.offer({ taskId: "t1", kind: "started", text: "Shuru" }, "idle")).toHaveLength(1);
  });

  it("holds while the owner talks or FRIDAY speaks, then releases in order with urgent first", () => {
    const a = new TaskAnnouncer();
    expect(a.offer({ taskId: "t1", kind: "started", text: "s" }, "speaking")).toEqual([]);
    expect(
      a.offer({ taskId: "t2", kind: "needs-approval", text: "ok?" }, "listening-to-owner"),
    ).toEqual([]);
    expect(a.pending()).toBe(2);
    expect(a.release("speaking")).toEqual([]);
    expect(a.release("idle").map((u) => u.kind)).toEqual(["needs-approval", "started"]);
    expect(a.pending()).toBe(0);
  });

  it("speaks only real milestones of progress", () => {
    let now = 0;
    const a = new TaskAnnouncer({
      now: () => now,
      progressStepPercent: 25,
      progressMinGapMs: 1000,
    });
    const p = (percent?: number) => ({
      taskId: "t",
      kind: "progress" as const,
      text: "p",
      ...(percent === undefined ? {} : { percent }),
    });
    expect(a.offer(p(), "idle")).toEqual([]);
    now = 5000;
    expect(a.offer(p(30), "idle")).toHaveLength(1);
    now = 6000;
    expect(a.offer(p(40), "idle")).toEqual([]);
    now = 9000;
    expect(a.offer(p(60), "idle")).toHaveLength(1);
  });

  it("keeps only the newest held progress line per task and bounds the list", () => {
    const a = new TaskAnnouncer({ maxHeld: 3, progressStepPercent: 1, progressMinGapMs: 0 });
    a.offer({ taskId: "t", kind: "progress", text: "a", percent: 10 }, "speaking");
    a.offer({ taskId: "t", kind: "progress", text: "b", percent: 20 }, "speaking");
    expect(a.pending()).toBe(1);
    for (let i = 0; i < 6; i += 1)
      a.offer({ taskId: `x${i}`, kind: "failed", text: "f" }, "speaking");
    expect(a.pending()).toBe(3);
  });
});
