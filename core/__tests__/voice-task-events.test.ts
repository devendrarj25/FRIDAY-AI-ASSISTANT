/**
 * Task events for the voice path: delivery classes, phrasing in three languages, settled tasks.
 * Pure: fixed clock numbers, no timer, no audio, no microphone.
 */
import { describe, expect, it } from "vitest";
import {
  TaskAnnouncer,
  TaskSpeechRouter,
  classifyDelivery,
  speechRequestFor,
  toVoiceTaskEvent,
  type TaskUpdate,
  type VoiceTaskEvent,
} from "../../src/lib/friday/voice-engine/task-announcer";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

const KINDS: TaskUpdate["kind"][] = [
  "started",
  "progress",
  "needs-input",
  "needs-approval",
  "completed",
  "failed",
  "cancelled",
];
type Meta = Parameters<typeof toVoiceTaskEvent>[1];
const meta = (over: Partial<Meta> = {}): Meta => ({
  seq: 1,
  now: 1_000,
  turnSeqAtStart: 3,
  risk: "read-only",
  verified: false,
  foreground: false,
  label: "the report",
  ...over,
});
const upd = (kind: TaskUpdate["kind"], text = "", extra: Partial<TaskUpdate> = {}): TaskUpdate => ({
  taskId: "t1",
  kind,
  text,
  ...extra,
});
const ev = (kind: TaskUpdate["kind"], text = "", m: Partial<Meta> = {}): VoiceTaskEvent =>
  toVoiceTaskEvent(upd(kind, text), meta(m));

describe("toVoiceTaskEvent", () => {
  it("builds the versioned event with the owner-facing fields", () => {
    const e = toVoiceTaskEvent(upd("completed", "done"), meta({ verified: true, seq: 7, now: 42 }));
    expect(e).toMatchObject({
      v: 1,
      taskId: "t1",
      seq: 7,
      kind: "completed",
      delivery: "when-idle",
      verified: true,
      risk: "read-only",
      at: 42,
      turnSeqAtStart: 3,
    });
    expect("error" in e).toBe(false);
    expect(toVoiceTaskEvent(upd("failed"), meta({ error: "disk full" })).error).toBe("disk full");
  });
});

describe("classifyDelivery", () => {
  it("interrupts for needs-approval, a foreground failure and a safety event only", () => {
    expect(classifyDelivery(upd("needs-approval"), { foreground: false })).toBe("interrupt");
    expect(classifyDelivery(upd("failed"), { foreground: true })).toBe("interrupt");
    expect(classifyDelivery(upd("failed"), { foreground: false })).toBe("when-idle");
    expect(classifyDelivery(upd("failed"), { foreground: false, safety: true })).toBe("interrupt");
    expect(classifyDelivery(upd("needs-input"), { foreground: false })).toBe("when-idle");
  });
  it("never interrupts for started, progress, completed or cancelled, whatever the context", () => {
    for (const kind of ["started", "progress", "completed", "cancelled"] as const) {
      for (const foreground of [true, false]) {
        for (const safety of [true, false, undefined]) {
          for (const asked of [true, false, undefined]) {
            const ctx = {
              foreground,
              ...(safety === undefined ? {} : { safety }),
              ...(asked === undefined ? {} : { asked }),
            };
            expect(classifyDelivery(upd(kind), ctx)).not.toBe("interrupt");
          }
        }
      }
    }
  });
  it("keeps plain started and progress silent unless the owner asked, and cancelled always silent", () => {
    expect(classifyDelivery(upd("started"), { foreground: false })).toBe("silent");
    expect(classifyDelivery(upd("progress"), { foreground: false })).toBe("silent");
    expect(classifyDelivery(upd("started"), { foreground: false, asked: true })).toBe("when-idle");
    expect(classifyDelivery(upd("progress"), { foreground: true })).toBe("when-idle");
    expect(classifyDelivery(upd("cancelled"), { foreground: true, asked: true })).toBe("silent");
  });
  it("accepts an event as well as an update", () => {
    expect(classifyDelivery(ev("needs-approval"), { foreground: false })).toBe("interrupt");
  });
});

describe("speechRequestFor: arbiter mapping", () => {
  it("needs-approval is an approval; other interrupts are direct", () => {
    expect(speechRequestFor(ev("needs-approval", "Delete 3 files?"), 3, "en")?.priority).toBe(
      "approval",
    );
    const failed = speechRequestFor(
      ev("failed", "", { foreground: true, error: "no space" }),
      3,
      "en",
    );
    expect(failed?.priority).toBe("direct");
  });
  it("when-idle lines are progress priority and a completed line is a done line", () => {
    const done = speechRequestFor(ev("completed", "", { verified: true }), 3, "en");
    expect(done).toMatchObject({ priority: "progress", done: true, taskId: "t1" });
    const input = speechRequestFor(ev("needs-input", "Which folder?"), 3, "en");
    expect(input).toMatchObject({ priority: "progress" });
    expect(input?.done).toBeFalsy();
  });
  it("a silent event makes no request, and cancelled neither", () => {
    expect(speechRequestFor(ev("progress", "40%"), 3, "en")).toBeNull();
    expect(speechRequestFor(ev("cancelled"), 3, "en")).toBeNull();
  });
  it("a silent event never reaches a real arbiter", () => {
    const arbiter = new SpeechArbiter({ now: () => 0 });
    const router = new TaskSpeechRouter();
    for (const kind of ["started", "progress", "cancelled"] as const) {
      const req = router.route(ev(kind, "x"), 3, "en");
      if (req) arbiter.enqueue(req);
    }
    expect(arbiter.stats().queued).toBe(0);
    expect(router.silentCount).toBe(3);
  });
  it("a sensitive task is flagged for the digest", () => {
    const req = speechRequestFor(ev("completed", "", { verified: true, sensitive: true }), 3, "en");
    expect(req?.sensitive).toBe(true);
  });
  it("coalesces progress lines of one task", () => {
    const req = speechRequestFor(ev("progress", "half way", { foreground: true }), 3, "en");
    expect(req?.coalesceKey).toBe("task:t1:progress");
  });
});

describe("speechRequestFor: honest completion", () => {
  it("says done only when the result was verified", () => {
    const yes = speechRequestFor(ev("completed", "", { verified: true }), 3, "en");
    const no = speechRequestFor(ev("completed", "", { verified: false }), 3, "en");
    expect(yes?.text).toMatch(/done/i);
    expect(no?.text).not.toMatch(/done/i);
    expect(no?.text).toContain("I finished the report but could not check the result");
  });
  it("keeps the same rule in Hindi and Hinglish", () => {
    const hi = speechRequestFor(ev("completed", "", { verified: false }), 3, "hi");
    const hing = speechRequestFor(ev("completed", "", { verified: false }), 3, "hinglish");
    const hiOk = speechRequestFor(ev("completed", "", { verified: true }), 3, "hi");
    const hingOk = speechRequestFor(ev("completed", "", { verified: true }), 3, "hinglish");
    expect(/[\u0900-\u097F]/.test(hi?.text ?? "")).toBe(true);
    expect(/[\u0900-\u097F]/.test(hing?.text ?? "")).toBe(false);
    expect(hi?.text).not.toBe(hiOk?.text);
    expect(hing?.text).not.toBe(hingOk?.text);
    expect(hiOk?.text).toContain("पूरा हो गया");
    expect(hingOk?.text).toContain("ho gaya");
    expect(hi?.text).not.toContain("पूरा हो गया");
    expect(hing?.text).not.toContain("ho gaya");
  });
});

describe("speechRequestFor: the earlier task", () => {
  it("prefixes the line when the owner has had a newer turn, in three languages", () => {
    const e = ev("completed", "", { verified: true });
    expect(speechRequestFor(e, 4, "en")?.text.startsWith("About the earlier the report: ")).toBe(
      true,
    );
    expect(speechRequestFor(e, 4, "hi")?.text.startsWith("पहले वाले the report के बारे में: ")).toBe(
      true,
    );
    expect(
      speechRequestFor(e, 4, "hinglish")?.text.startsWith("Pehle wale the report ke baare mein: "),
    ).toBe(true);
  });
  it("adds no prefix in the same turn", () => {
    for (const lang of ["en", "hi", "hinglish"] as const) {
      const text = speechRequestFor(ev("completed", "", { verified: true }), 3, lang)?.text ?? "";
      expect(text).not.toMatch(/About the earlier|पहले वाले|Pehle wale/);
    }
  });
});

describe("speechRequestFor: failures and untrusted text", () => {
  it("speaks the tool's own error and nothing invented", () => {
    const e = ev("failed", "", { foreground: true, error: "Permission denied" });
    expect(speechRequestFor(e, 3, "en")?.text).toContain("Permission denied");
    const bare = speechRequestFor(ev("failed", "", { foreground: true }), 3, "en");
    expect(bare?.text).toBe("The report failed.");
  });
  it("scrubs drive and network paths and bounds the error to 120 characters", () => {
    const e = ev("failed", "", {
      foreground: true,
      error:
        "cannot open C:\\Users\\owner\\secret.txt or \\\\server\\share\\x.doc " + "z".repeat(300),
    });
    const text = speechRequestFor(e, 3, "en")?.text ?? "";
    expect(text).not.toMatch(/C:\\|\\\\server|secret\.txt/);
    const spoken = text.slice("The report failed: ".length);
    expect(spoken.length).toBeLessThanOrEqual(120);
  });
  it("strips delivery tags from event text before it can be spoken", () => {
    const e = ev("needs-input", "[whisper] Which folder? [pause:500]");
    const text = speechRequestFor(e, 3, "en")?.text ?? "";
    expect(text).not.toMatch(/\[/);
    expect(text).toContain("Which folder?");
  });
  it("returns null for an empty needs-input only when nothing at all can be said", () => {
    expect(speechRequestFor(ev("needs-input", ""), 3, "en")?.text).toMatch(/\S/);
  });
});

describe("TaskSpeechRouter: a settled task stays settled", () => {
  it("drops a late result after the owner cancelled the task", () => {
    const router = new TaskSpeechRouter();
    expect(
      router.route(ev("started", "go", { foreground: true, asked: true }), 3, "en"),
    ).not.toBeNull();
    expect(router.route(ev("cancelled"), 3, "en")).toBeNull();
    expect(router.route(ev("completed", "", { verified: true }), 3, "en")).toBeNull();
    expect(router.route(ev("failed", "", { foreground: true, error: "x" }), 3, "en")).toBeNull();
    expect(router.dropped).toBe(2);
    expect(router.isSettled("t1")).toBe(true);
  });
  it("leaves other tasks alone and keeps its memory bounded", () => {
    const router = new TaskSpeechRouter();
    router.route(ev("cancelled"), 3, "en");
    const other = toVoiceTaskEvent(
      { taskId: "t2", kind: "completed", text: "" },
      meta({ verified: true }),
    );
    expect(router.route(other, 3, "en")).not.toBeNull();
    for (let i = 0; i < 500; i += 1) router.route({ ...ev("cancelled"), taskId: `x${i}` }, 3, "en");
    expect(router.settledCount()).toBeLessThanOrEqual(128);
  });
});

describe("TaskAnnouncer is unchanged", () => {
  it("still returns TaskUpdate[] from offer and release", () => {
    const a = new TaskAnnouncer({ now: () => 0 });
    expect(a.offer(upd("needs-input", "q"), "speaking")).toEqual([]);
    expect(a.release("idle")).toEqual([upd("needs-input", "q")]);
    expect(KINDS).toHaveLength(7);
  });
});
