/**
 * The spoken approval path, attacked with concrete transcripts. Every case is a timeline of heard lines (the ear's
 * start and end, the voice frames, the final) played into the real Auto mode controller through the turn simulator.
 * A yes approves only when it is short, fresh, bound to the prompt that finished sounding, said in words that carry
 * no "no", heard with no TV, music or other voice tagged in the room, and begun after the prompt ended. A speaker
 * match never approves; her own playback never approves; Stop everything and pause halt.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ctl,
  ear,
  fin,
  quiet,
  runScenario,
  script,
  vad,
  type ScriptEvent,
  type SimResult,
} from "./helpers/voice-turn-sim";

vi.mock("../../src/lib/friday/voice-library", async (importOriginal) =>
  (await import("./helpers/voice-turn-sim")).simLibraryMock(await importOriginal()),
);

type FakeTask = { id: string; label: string; state: string; createdAt: number };
type TaskSpy = { tasks: FakeTask[]; approved: Array<[string, boolean]>; redone: string[][] };
const TASKS = "__approvalSafetyTasks";
const taskSpy = (): TaskSpy => {
  const g = globalThis as unknown as Record<string, TaskSpy | undefined>;
  g[TASKS] ??= { tasks: [], approved: [], redone: [] };
  return g[TASKS];
};

// The desk, with one waiting task the test can place and the approve and redo calls recorded (real ones otherwise).
vi.mock("../../src/lib/friday/voice-engine/voice-tasks", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/lib/friday/voice-engine/voice-tasks")>();
  const spy = (): TaskSpy =>
    (globalThis as unknown as Record<string, TaskSpy>)["__approvalSafetyTasks"] ?? {
      tasks: [],
      approved: [],
      redone: [],
    };
  return {
    ...real,
    routerTasks: () => [...real.routerTasks(), ...spy().tasks],
    redoInterruptedVoiceTasks: (ids: string[]) => {
      spy().redone.push(ids);
      return real.redoInterruptedVoiceTasks(ids);
    },
    voiceTaskActions: {
      ...real.voiceTaskActions,
      approve: (id: string, yes: boolean) => {
        if (spy().tasks.some((t) => t.id === id)) {
          spy().approved.push([id, yes]);
          return true;
        }
        return real.voiceTaskActions.approve(id, yes);
      },
    },
  };
});

const SOURCE = readFileSync(
  resolve(import.meta.dirname, "../../src/lib/friday/assistant-mode.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

type Env = { kind: "speech" | "music" | "tv" | "noise"; score: number };
type Speaker = { tag: "owner" | "other" | "unknown"; score: number };
type Line = {
  id: string;
  at: number;
  text: string;
  endAt?: number;
  finalAt?: number;
  env?: Env;
  speaker?: Speaker;
  /** No ear events: a recogniser that gives only a final (its voice start is unknown). */
  finalOnly?: boolean;
};

/** One heard line: about 240 ms a word of voice, the ear's end 320 ms later, the final 160 ms after that. */
function said(line: Line): ScriptEvent[] {
  const words = line.text.split(/\s+/).length;
  const voiceEnd = line.at + Math.max(240, words * 240);
  const end = line.endAt ?? voiceEnd + 320;
  const finalAt = line.finalAt ?? end + 160;
  const tags = {
    ...(line.env ? { env: line.env } : {}),
    ...(line.speaker ? { speaker: line.speaker } : {}),
  };
  const voice = [...vad(line.at, voiceEnd), ...quiet(voiceEnd, voiceEnd + 240)];
  if (line.finalOnly) return [...voice, fin(finalAt, line.text)];
  return [
    ear(line.at, "start", line.id, "", tags),
    ...voice,
    ear(end, "end", line.id, line.text, { speechMs: voiceEnd - line.at, ...tags }),
    fin(finalAt, line.text),
  ];
}

type Pending = { command: string; at: number } | null;
type Drive = {
  state: { pending: Pending };
  approvalAsked: { askedAt: number; taskId?: string } | null;
  approvalSpoken: { at: number; taskId?: string; ended?: boolean } | null;
  restartAsk: { ids: string[] } | null;
  playingItem: { priority: string; taskId?: string } | null;
  noteApprovalSpoken: (phase?: "start" | "end") => void;
};
const drive = (r: { h: { d: unknown } }): Drive => r.h.d as Drive;
const pendingOf = (r: SimResult): Pending => drive(r).state.pending;

const SEND = "Friday send 5000 rupees to Rahul";
const DIGEST_RAHUL = "Send 5,000 rupees to rahul. Say yes to confirm.";
const DIGEST_ROHAN = "Send 5,000 rupees to Rohan. Say yes to confirm.";
// SEND's final reaches her at 1920 ms; its 9-word read-back sounds until about 5520 ms.
const AFTER_READ = 6000;

/** A task waiting for approval whose prompt sounded at `at` (start and end stamped together unless `playing`). */
function waitingTask(h: { d: unknown }, options: { playing?: boolean } = {}) {
  const spy = taskSpy();
  spy.tasks = [
    {
      id: "task-7",
      label: "delete the folder Photos",
      state: "WAITING_FOR_APPROVAL",
      createdAt: 1,
    },
  ];
  spy.approved = [];
  const d = h.d as Drive;
  d.playingItem = { priority: "approval", taskId: "task-7" };
  d.noteApprovalSpoken("start");
  if (!options.playing) d.noteApprovalSpoken("end");
  else d.approvalSpoken = { ...(d.approvalSpoken ?? { at: Date.now() }), ended: false };
  d.playingItem = null;
}

function restartAsked(h: { d: unknown }) {
  const spy = taskSpy();
  spy.redone = [];
  const d = h.d as Drive;
  d.restartAsk = { ids: ["row-gone"] };
  d.playingItem = { priority: "approval", taskId: "restart-redo" };
  d.noteApprovalSpoken("start");
  d.noteApprovalSpoken("end");
  d.playingItem = null;
}

describe("finding 1: a rewritten line never turns a no into an approval", () => {
  it("'no, I mean yes' to a waiting task is never an approval (self-repair does not run on an answer)", async () => {
    const r = await runScenario({
      name: "task no-I-mean-yes",
      setup: (h) => waitingTask(h),
      script: script(said({ id: "t1", at: 400, text: "Friday no I mean yes" })),
    });
    expect(taskSpy().approved.filter(([, yes]) => yes)).toEqual([]);
    // No beats yes (voice-session): the line as heard is a no.
    expect(taskSpy().approved).toEqual([["task-7", false]]);
  });

  it("'cancel, I mean yes' to the restart question redoes nothing", async () => {
    const r = await runScenario({
      name: "restart cancel-I-mean-yes",
      setup: (h) => restartAsked(h),
      script: script(said({ id: "t1", at: 400, text: "Friday cancel I mean yes" })),
    });
    expect(taskSpy().redone).toEqual([]);
    expect(r.spoken).toContain("Okay, I dropped them.");
  });

  it("the control: a plain yes to the waiting task approves it", async () => {
    await runScenario({
      name: "task plain yes",
      setup: (h) => waitingTask(h),
      script: script(said({ id: "t1", at: 400, text: "Friday yes" })),
    });
    expect(taskSpy().approved).toEqual([["task-7", true]]);
  });

  it("'no, I mean yes' to a read-back digest cancels it and never runs the order", async () => {
    const r = await runScenario({
      name: "digest no-I-mean-yes",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: AFTER_READ, text: "no I mean yes" }),
      ),
    });
    expect(r.sent).toEqual([]);
    expect(pendingOf(r)).toBeNull();
  });

  it("the guard is in the self-repair stage and every yes reads the words as heard", () => {
    const body = SOURCE.slice(SOURCE.indexOf("  private selfRepairOf("));
    const head = body.slice(0, body.indexOf("\n  }\n"));
    expect(head).toContain('if (this.turnExpect() === "yesno") return null;');
    expect(head).toContain('if (confirmationVerdict(repair.repaired) !== "unclear") return null;');
    const refusal = SOURCE.slice(SOURCE.indexOf("  private yesRefusal("));
    expect(refusal.slice(0, 400)).toContain(
      'this.heardRawLines.some((line) => confirmationVerdict(line) === "no")',
    );
    // The words as heard are copied at the intake (the recogniser's own text), never read from the turn record.
    expect(SOURCE).toContain("this.heardRaw = text;");
    expect(SOURCE).toContain("const raw = this.heardRaw;");
  });
});

describe("finding 2: a yes counts only when it began after the prompt finished sounding", () => {
  it("a yes that begins in the middle of the read-back is asked again; one after it runs the order", async () => {
    const r = await runScenario({
      name: "yes mid read-back",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        // 2400 ms: she is still reading "Send 5,000 rupees to rahul..." (it sounds until about 5520 ms).
        said({ id: "t2", at: 2400, text: "yes" }),
        said({ id: "t3", at: 12_000, text: "yes" }),
      ),
    });
    expect(r.spoken).toEqual([DIGEST_RAHUL, DIGEST_RAHUL]);
    expect(r.sent).toEqual(["send 5000 rupees to rahul"]);
  });

  it("after a correction, a yes begun while the new amount is still being read is asked again", async () => {
    const r = await runScenario({
      name: "yes mid correction read",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: AFTER_READ, text: "no, to Rohan" }),
        // The correction's final lands at 7200 ms; the 9-word Rohan read sounds until about 10800 ms.
        said({ id: "t3", at: 8000, text: "yes" }),
      ),
    });
    expect(r.spoken).toEqual([DIGEST_RAHUL, DIGEST_ROHAN, DIGEST_ROHAN]);
    expect(r.sent).toEqual([]);
  });

  it("the window counts from the end of the read-back: a yes inside it after a long read still runs", async () => {
    const r = await runScenario({
      name: "window from end",
      setup: (h) => h.preferences.setVoice({ approvalTtlSec: 10 }),
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        // 11.6 s after the digest was built, 6 s after its read ended.
        said({ id: "t2", at: 11_520, text: "yes" }),
      ),
    });
    expect(r.sent).toEqual(["send 5000 rupees to rahul"]);
  });

  it("a yes to a task prompt that is still playing is not taken", async () => {
    await runScenario({
      name: "task prompt playing",
      setup: (h) => waitingTask(h, { playing: true }),
      script: script(said({ id: "t1", at: 400, text: "Friday yes" })),
    });
    expect(taskSpy().approved).toEqual([]);
  });

  it("the Brain's prompt binds only once it has ended, and the yes must begin after that end", () => {
    const at = SOURCE.indexOf("const heardPrompt =");
    const block = SOURCE.slice(at, at + 1600);
    expect(block).toContain("spoken.ended !== false");
    expect(block).toContain("this.yesRefusal(spoken.at, room)");
    expect(SOURCE).toContain('this.noteApprovalSpoken("start");');
    expect(SOURCE).toContain('this.noteApprovalSpoken("end");');
  });
});

describe("finding 3: a TV, music or other voice in the room never approves a pending order", () => {
  const DELETE = "Friday delete the folder Photos";

  it.each([
    ["a TV scene", { env: { kind: "tv" as const, score: 0.9 } }],
    ["a music scene", { env: { kind: "music" as const, score: 0.9 } }],
    ["another voice", { speaker: { tag: "other" as const, score: 0.9 } }],
  ])("%s saying 'Yes!' is asked again and deletes nothing", async (_name, tags) => {
    const r = await runScenario({
      name: "room yes",
      script: script(
        said({ id: "t1", at: 0, text: DELETE }),
        said({ id: "t2", at: AFTER_READ, text: "Yes!", ...tags }),
      ),
    });
    expect(r.sent).toEqual([]);
    expect(pendingOf(r)?.command).toMatch(/delete the folder photos/i);
    expect(r.spoken).toHaveLength(2);
    expect(r.spoken[1]).toBe(r.spoken[0]);
  });

  it("the control: the owner's yes in a quiet room deletes it, and an owner tag is no stronger than none", async () => {
    const r = await runScenario({
      name: "room control",
      script: script(
        said({ id: "t1", at: 0, text: DELETE }),
        said({ id: "t2", at: AFTER_READ, text: "Yes!", env: { kind: "speech", score: 0.9 } }),
      ),
    });
    expect(r.sent).toEqual(["delete the folder photos"]);
  });

  it("a TV 'yes' to a waiting task is not taken either", async () => {
    await runScenario({
      name: "task tv yes",
      setup: (h) => waitingTask(h),
      script: script(
        said({ id: "t1", at: 400, text: "Friday yes", env: { kind: "tv", score: 0.9 } }),
      ),
    });
    expect(taskSpy().approved).toEqual([]);
  });
});

describe("finding 4: an unknown voice start never skips the older-yes rule", () => {
  it("a final-only yes that lands just after a correction (it began before the new read) is asked again", async () => {
    const r = await runScenario({
      name: "unknown start",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: AFTER_READ, text: "no, to Rohan" }),
        // The correction's final lands at 7200 ms; this final arrives 480 ms later with no ear framing.
        said({ id: "t3", at: 7280, text: "yes", finalOnly: true, finalAt: 7680 }),
      ),
    });
    expect(r.sent).toEqual([]);
    expect(r.spoken).toEqual([DIGEST_RAHUL, DIGEST_ROHAN, DIGEST_ROHAN]);
  });

  it("a final-only yes long after the read-back still runs the order", async () => {
    const r = await runScenario({
      name: "unknown start control",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: 9600, text: "yes", finalOnly: true }),
      ),
    });
    expect(r.sent).toEqual(["send 5000 rupees to rahul"]);
  });
});

describe("more holes: halts and her own voice", () => {
  it("a yes after Stop everything runs nothing, and the order is gone", async () => {
    const r = await runScenario({
      name: "stop-all yes",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        ctl(2960, "stop-all"),
        said({ id: "t2", at: AFTER_READ, text: "yes" }),
      ),
    });
    expect(r.sent).toEqual([]);
    expect(pendingOf(r)).toBeNull();
  });

  it("the tray pause drops a waiting order, so a yes after resume binds to nothing", async () => {
    const r = await runScenario({
      name: "pause drops pending",
      script: script(said({ id: "t1", at: 0, text: SEND }), ctl(2960, "pause")),
    });
    expect(pendingOf(r)).toBeNull();
  });

  it("her own read-back heard back as 'yes to confirm' never approves, even after the read", async () => {
    const r = await runScenario({
      name: "own words",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({
          id: "t2",
          at: AFTER_READ,
          text: "say yes to confirm",
          speaker: { tag: "owner", score: 0.99 },
        }),
      ),
    });
    expect(r.sent).toEqual([]);
  });
});
