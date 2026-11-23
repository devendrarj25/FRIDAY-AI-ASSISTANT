/**
 * The task desk across a failure and a restart: the INTERRUPTED state, `voiceTaskActions.retry`, the write-through
 * copy in the task ledger (key `friday.tasks.v1`, additive field `voice`), and the one question after a restart.
 *
 * Nothing runs a model, a microphone or a speaker: the work is a stub, the ledger is a recorder with the real
 * pure helpers, and the conductor's voice is a recorder on a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { brain } from "../../src/lib/friday/brain-engine";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { DEFAULT_PREFERENCES, preferences } from "../../src/lib/friday/preferences";
import {
  settleInterrupted,
  restartVoiceRows,
  voiceLedgerId,
  voiceStatusOf,
  type TaskRecord,
} from "../../src/lib/friday/self/task-ledger";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";
import {
  TaskOrchestrator,
  TERMINAL,
  canMoveTask,
} from "../../src/lib/friday/voice-engine/task-orchestrator";
import {
  TASK_WORKER_LIMIT,
  attachVoiceTaskWork,
  dropInterruptedVoiceTasks,
  isReadOnlyRequest,
  listVoiceTasks,
  restoreInterruptedVoiceTasks,
  setVoiceTaskLedger,
  startVoiceTask,
  taskPrefsFrom,
  taskStatusLine,
  taskWorkerLimit,
  voiceTaskActions,
  type VoiceTaskLedger,
} from "../../src/lib/friday/voice-engine/voice-tasks";

const win = globalThis as unknown as { window?: unknown };
win.window ??= globalThis;
const flush = () => vi.advanceTimersByTimeAsync(5);

/* ---------- a ledger that records, with the real pure rules ---------- */

type Sync = Parameters<VoiceTaskLedger["syncVoiceTask"]>[0];
function fakeLedger(initial: TaskRecord[] = []) {
  let rows: TaskRecord[] = initial;
  const synced: Sync[] = [];
  const sink: VoiceTaskLedger = {
    syncVoiceTask: (row) => {
      synced.push(row);
      const record: TaskRecord = {
        id: row.id,
        key: row.id,
        kind: "voice-task",
        title: row.title,
        status: voiceStatusOf(row.state),
        progress: row.percent ?? 0,
        startedAt: row.createdAt,
        logs: [],
        voice: {
          state: row.state,
          ...(row.spokenName ? { spokenName: row.spokenName } : {}),
          ...(row.ordinal !== undefined ? { ordinal: row.ordinal } : {}),
          ...(row.request ? { request: row.request } : {}),
          // like the real ledger, a copy written again keeps what became of the row
          ...(rows.find((r) => r.id === row.id)?.voice?.redo
            ? { redo: rows.find((r) => r.id === row.id)?.voice?.redo }
            : {}),
        },
      } as TaskRecord;
      rows = [record, ...rows.filter((r) => r.id !== row.id)];
    },
    restartVoiceRows: () => restartVoiceRows(rows),
    markVoiceRows: (ids, redo) => {
      rows = rows.map((r) =>
        ids.includes(r.id) && r.voice
          ? {
              ...r,
              ...(redo === "asked" ? {} : { status: "cancelled" as const }),
              voice: { ...r.voice, redo },
            }
          : r,
      );
    },
  };
  return { sink, synced, rows: () => rows };
}

/** What a restart does to the stored rows: JSON out, JSON in, live rows settle as interrupted. */
const restart = (rows: TaskRecord[]): TaskRecord[] =>
  settleInterrupted(JSON.parse(JSON.stringify(rows)) as TaskRecord[]);

const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
const never = () => new Promise<string>(() => undefined);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  for (const task of listVoiceTasks())
    if (!TERMINAL.includes(task.state)) voiceTaskActions.cancel(task.id);
  // a finished row left by one test is not the next test's
  dropInterruptedVoiceTasks(listVoiceTasks().map((t) => t.id));
  setVoiceTaskLedger(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the orchestrator: INTERRUPTED, retry, and the optional fields", () => {
  const make = (run: () => Promise<string>) =>
    new TaskOrchestrator({ run: async () => run(), now: () => Date.now() });

  it("INTERRUPTED is a finished state with no way out, and it holds neither a worker nor a waiting slot", () => {
    expect(TERMINAL).toContain("INTERRUPTED");
    for (const to of ["RUNNING", "QUEUED", "CANCELLED", "FAILED"] as const)
      expect(canMoveTask("INTERRUPTED", to)).toBe(false);
    const o = make(never);
    const restored = o.restore([
      { label: "summarise the report", request: "summarise the report" },
    ]);
    expect(restored[0]).toMatchObject({
      state: "INTERRUPTED",
      reason: expect.stringMatching(/closed/i),
      ordinal: 1,
    });
    expect(o.latestActive()).toBeNull();
    const next = o.create({ label: "next", payload: never });
    expect(next.ok && o.get(next.task.id)?.state).toBe("RUNNING");
  });

  it("a task keeps its spoken name, its number and its request; a failure keeps the reason", async () => {
    const o = make(async () => {
      throw new Error("the model timed out");
    });
    const made = o.create({ label: "A", payload: never, request: "what is A", spoken: "A" });
    expect(made.ok && made.task).toMatchObject({ ordinal: 1, spoken: "A", request: "what is A" });
    const failing = new TaskOrchestrator({
      run: () => Promise.reject(new Error("the model timed out")),
      now: () => Date.now(),
    });
    const f = failing.create({ label: "B", payload: () => undefined });
    await flush();
    expect(f.ok && failing.get(f.task.id)).toMatchObject({
      state: "FAILED",
      error: "the model timed out",
      reason: "the model timed out",
    });
  });

  it("retry runs a failed task again with its original request and puts the new task in its place", async () => {
    let calls = 0;
    const o = new TaskOrchestrator({
      run: async (task, _ctx, payload) => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return (payload as () => string)() + task.label;
      },
      now: () => Date.now(),
    });
    const made = o.create({
      label: "weather",
      payload: () => "sunny ",
      request: "weather in Delhi",
    });
    await flush();
    const failedId = made.ok ? made.task.id : "";
    expect(o.get(failedId)?.state).toBe("FAILED");
    expect(o.retry(failedId)).toBe(true);
    await flush();
    const rows = o.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "COMPLETED",
      label: "weather",
      request: "weather in Delhi",
      result: "sunny weather",
    });
    expect(rows[0]?.id).not.toBe(failedId);
  });

  it("retry refuses a task that is running, finished well, cancelled, unknown, or has no work to run", async () => {
    const o = make(never);
    const running = o.create({ label: "r", payload: never });
    const id = running.ok ? running.task.id : "";
    expect(o.retry(id)).toBe(false);
    o.cancel(id);
    expect(o.retry(id)).toBe(false);
    expect(o.retry("task-404")).toBe(false);
    const [interrupted] = o.restore([{ label: "x", request: "x" }]);
    expect(o.retry(interrupted?.id ?? "")).toBe(false); // no work and no fallback
    expect(o.get(interrupted?.id ?? "")?.state).toBe("INTERRUPTED");
    expect(o.retry(interrupted?.id ?? "", never)).toBe(true); // the fallback is the work
    expect(o.get(interrupted?.id ?? "")).toBeNull();
  });

  it("a retry that cannot be made (too many waiting) leaves the old row where it was", () => {
    const o = new TaskOrchestrator({ run: never, maxWaiting: 1, now: () => Date.now() });
    o.create({ label: "busy", payload: never });
    o.create({ label: "waits", payload: never }); // fills the one waiting slot
    const [row] = o.restore([{ label: "old", request: "old" }]);
    expect(o.retry(row?.id ?? "", never)).toBe(false);
    expect(o.get(row?.id ?? "")?.state).toBe("INTERRUPTED");
  });
});

describe("the desk: voiceTaskActions.retry, the ledger copy, and the restart", () => {
  it("retry on a failed desk task starts a new one with the same request; a task that works is not retried", async () => {
    const led = fakeLedger();
    setVoiceTaskLedger(led.sink);
    let attempts = 0;
    const made = startVoiceTask(
      "check the weather",
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("the kernel was offline");
        return "It is sunny.";
      },
      "safe",
      { request: "check the weather in Delhi" },
    );
    await flush();
    const id = made.ok ? made.task.id : "";
    expect(listVoiceTasks().find((t) => t.id === id)).toMatchObject({
      state: "FAILED",
      reason: "the kernel was offline",
      spoken: "check the weather",
    });
    expect(voiceTaskActions.retry(id)).toBe(true);
    await flush();
    const now = listVoiceTasks();
    expect(now.find((t) => t.id === id)).toBeUndefined();
    const again = now.at(-1);
    expect(again).toMatchObject({
      state: "COMPLETED",
      result: "It is sunny.",
      request: "check the weather in Delhi",
    });
    expect(voiceTaskActions.retry(again?.id ?? "")).toBe(false);
    expect(voiceTaskActions.retry("task-none")).toBe(false);
    expect(attempts).toBe(2);
  });

  it("writes through to the ledger: the row carries state, spoken name, number and request, and only tasks with a request", async () => {
    const led = fakeLedger();
    setVoiceTaskLedger(led.sink);
    const made = startVoiceTask("summarise the plan", never, "safe", {
      request: "summarise the plan",
    });
    startVoiceTask("no request here", never); // waits behind the first, and is never written
    await flush();
    const task = made.ok ? made.task : null;
    expect(
      led.synced.every((row) => row.id === voiceLedgerId(task?.createdAt ?? 0, task?.id ?? "")),
    ).toBe(true);
    const row = led.rows()[0];
    expect(row).toMatchObject({
      kind: "voice-task",
      status: "running",
      voice: { state: "RUNNING", spokenName: "summarise the plan", request: "summarise the plan" },
    });
    expect(row?.voice?.ordinal).toBeGreaterThan(0);
    expect(led.rows()).toHaveLength(1);
    voiceTaskActions.cancel(task?.id ?? "");
    expect(led.rows()[0]).toMatchObject({ status: "cancelled", voice: { state: "CANCELLED" } });
  });

  it("a restart marks live rows interrupted (JSON round trip), keeps finished ones, and loads an old row without `voice`", () => {
    const base = {
      logs: [] as TaskRecord["logs"],
      progress: 0,
      startedAt: T0,
      key: "k",
      kind: "voice-task",
    };
    const stored: TaskRecord[] = [
      {
        ...base,
        id: "a",
        title: "A",
        status: "running",
        voice: { state: "RUNNING", request: "a" },
      },
      { ...base, id: "b", title: "B", status: "queued", voice: { state: "QUEUED", request: "b" } },
      { ...base, id: "c", title: "C", status: "done", voice: { state: "COMPLETED", request: "c" } },
      {
        ...base,
        id: "d",
        title: "D",
        status: "awaiting-approval",
        voice: { state: "WAITING_FOR_APPROVAL", request: "d" },
      },
      // a row written before the field existed
      {
        id: "old",
        key: "old",
        kind: "agent",
        title: "Old",
        status: "running",
        progress: 3,
        startedAt: 1,
        logs: [],
      },
    ];
    const loaded = restart(stored);
    expect(loaded.map((r) => r.status)).toEqual([
      "interrupted",
      "interrupted",
      "done",
      "interrupted",
      "interrupted",
    ]);
    expect(loaded.find((r) => r.id === "old")).toMatchObject({ title: "Old", progress: 3 });
    expect(loaded.find((r) => r.id === "old")?.voice).toBeUndefined();
    // only the voice rows that were live, with a request, are asked about
    expect(restartVoiceRows(loaded).map((r) => r.id)).toEqual(["a", "b", "d"]);
    // asked once: a row marked is not asked again
    const marked = loaded.map((r) =>
      r.id === "a" ? { ...r, voice: { ...r.voice!, redo: "asked" as const } } : r,
    );
    expect(restartVoiceRows(marked).map((r) => r.id)).toEqual(["b", "d"]);
    expect(voiceStatusOf("PAUSED")).toBe("running");
    expect(voiceStatusOf("WAITING_FOR_INPUT")).toBe("running");
  });

  it("restoreInterruptedVoiceTasks puts the rows on the desk as INTERRUPTED, once, and runs nothing", () => {
    const base = {
      logs: [] as TaskRecord["logs"],
      progress: 0,
      startedAt: T0 - 5000,
      kind: "voice-task",
    };
    const led = fakeLedger(
      restart([
        {
          ...base,
          id: "r1",
          key: "r1",
          title: "summarise the plan",
          status: "running",
          voice: {
            state: "RUNNING",
            request: "summarise the plan",
            spokenName: "summarise the plan",
          },
        },
        {
          ...base,
          id: "r2",
          key: "r2",
          title: "find the invoice",
          status: "queued",
          voice: { state: "QUEUED", request: "find the invoice" },
        },
      ]),
    );
    setVoiceTaskLedger(led.sink);
    const desk = restoreInterruptedVoiceTasks();
    expect(desk.map((t) => t.state)).toEqual(["INTERRUPTED", "INTERRUPTED"]);
    expect(desk.map((t) => t.spoken)).toEqual(["summarise the plan", "find the invoice"]);
    expect(listVoiceTasks().filter((t) => t.state === "INTERRUPTED")).toHaveLength(2);
    expect(led.rows().every((r) => r.voice?.redo === "asked")).toBe(true);
    expect(restoreInterruptedVoiceTasks()).toEqual([]);
    expect(taskStatusLine("en", desk)).toContain("stopped when I closed");
    // the restored row keeps its own ledger row: no copy is written for it
    expect(
      led.synced.filter((s) => s.state === "INTERRUPTED").every((s) => s.id.startsWith("r")),
    ).toBe(true);
  });

  it("maxParallel is read and kept, but the worker limit stays 1 (the Brain has one lane)", () => {
    expect(taskPrefsFrom({ maxParallel: 3 }).maxParallel).toBe(3);
    expect(taskWorkerLimit({ maxParallel: 3 })).toBe(1);
    expect(TASK_WORKER_LIMIT).toBe(1);
    const first = startVoiceTask("one", never);
    const second = startVoiceTask("two", never);
    expect(first.ok && second.ok).toBe(true);
    expect(listVoiceTasks().filter((t) => t.state === "RUNNING")).toHaveLength(1);
  });

  it("read-only means a plain read or lookup that names no action; anything unclear is not", () => {
    for (const ok of [
      "summarise the quarterly report",
      "what is the weather in Jaipur",
      "find the invoice from March",
      "Friday, check the exchange rate",
    ])
      expect(isReadOnlyRequest(ok), ok).toBe(true);
    for (const no of [
      "",
      "send the report to Asha",
      "summarise the report and email it",
      "delete the old exports",
      "open the calendar",
      "restart FRIDAY",
      "install the update",
      "what is my password",
      "x".repeat(400),
      "कल की रिपोर्ट भेज दो",
      "check the weather then reply to Rahul",
      "check the weather and then open the calendar",
      "read the mail also forward it to Asha",
      "find the invoice, share it with Dev",
      "check the file and export it",
      "look up the flight and approve the booking",
      "summarise this then submit the form",
      "read the plan, start the build",
      "Rahul ko report bhejo",
      "report likho aur save karo",
      "check the weather phir kar do",
    ])
      expect(isReadOnlyRequest(no), no).toBe(false);
    for (const verb of [
      "reply",
      "respond",
      "forward",
      "share",
      "approve",
      "transfer",
      "cancel",
      "accept",
      "submit",
      "sync",
      "export",
      "stop",
      "start",
      "play",
    ])
      expect(isReadOnlyRequest(`check the plan ${verb} now`), verb).toBe(false);
    // two reading steps are still read-only
    expect(isReadOnlyRequest("check the weather then find the best route")).toBe(true);
  });

  it("a request that looks private is never written to the ledger (that task cannot be redone)", async () => {
    const led = fakeLedger();
    setVoiceTaskLedger(led.sink);
    startVoiceTask("note my password is hunter22", never, "safe", {
      request: "note that my password is hunter22 and summarise it",
    });
    startVoiceTask("summarise the plan", never, "safe", { request: "summarise the plan" });
    await flush();
    expect(led.synced.length).toBeGreaterThan(0);
    expect(JSON.stringify(led.rows())).not.toContain("hunter22");
    expect(led.rows().every((r) => r.title !== "note my password is hunter22")).toBe(true);
  });
});

/* ---------- the conductor: one question after a restart ---------- */

type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    paused: boolean;
    muted: boolean;
    stt: { ready: boolean };
  };
  handleHeard: (text: string) => void;
  announceReady: () => void;
  offerRestartRedo: () => void;
  noteApprovalSpoken: () => void;
  playingItem: { priority: string; taskId?: string } | null;
  approvalAsked: unknown;
  approvalSpoken: unknown;
  restartAsked: boolean;
  restartAsk: unknown;
  arbiter: SpeechArbiter;
  callHold: boolean;
  emit: () => void;
  drainSpeech: () => Promise<void>;
  speak: (text: string, meta?: { priority?: string; taskId?: string }) => void;
};
const d = assistantMode as unknown as Driver;

describe("after a restart she asks once, and a yes redoes the tasks", () => {
  let said: Array<{ text: string; priority?: string | undefined; taskId?: string | undefined }> =
    [];
  let led: ReturnType<typeof fakeLedger>;
  const works: string[] = [];

  const interruptedRows = (...requests: string[]): TaskRecord[] =>
    restart(
      requests.map((request, i) => ({
        id: `row-${i}`,
        key: `row-${i}`,
        kind: "voice-task",
        title: request,
        status: "running" as const,
        progress: 0,
        startedAt: T0 - 9000 + i,
        logs: [],
        voice: { state: "RUNNING", request, spokenName: request },
      })),
    );

  const asked = () => said.filter((s) => s.priority === "approval");
  const questionSounds = () => {
    d.playingItem = { priority: "approval", taskId: "restart-redo" };
    d.noteApprovalSpoken();
    d.playingItem = null;
  };

  beforeEach(() => {
    said = [];
    works.length = 0;
    autonomy.reset();
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
    Object.assign(d.state, { mode: "auto", paused: false, muted: false });
    d.callHold = false;
    d.restartAsked = false;
    d.restartAsk = null;
    d.approvalAsked = null;
    d.approvalSpoken = null;
    d.playingItem = null;
    d.arbiter = new SpeechArbiter({ now: () => Date.now() });
    d.emit = () => undefined;
    d.drainSpeech = async () => undefined;
    vi.spyOn(d, "speak").mockImplementation(
      ((text: string, meta?: { priority?: string; taskId?: string }) =>
        void said.push({ text, priority: meta?.priority, taskId: meta?.taskId })) as never,
    );
    attachVoiceTaskWork((request) => async () => {
      works.push(request);
      return never();
    });
  });
  afterEach(() => {
    attachVoiceTaskWork((request) => assistantMode.backgroundWork(request));
    autonomy.reset();
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
  });

  const load = (...requests: string[]) => {
    led = fakeLedger(interruptedRows(...requests));
    setVoiceTaskLedger(led.sink);
  };

  it("says once what she was working on and asks to redo it, as an approval-priority line", () => {
    load("summarise the plan", "find the invoice");
    d.offerRestartRedo();
    expect(asked()).toEqual([
      {
        text: "I was working on summarise the plan and find the invoice when I closed. Redo them?",
        priority: "approval",
        taskId: "restart-redo",
      },
    ]);
    expect(listVoiceTasks().filter((t) => t.state === "INTERRUPTED")).toHaveLength(2);
    d.offerRestartRedo();
    expect(said).toHaveLength(1); // once per session
    expect(works).toEqual([]); // she never starts them by herself
  });

  it("a private task is named neutrally in the question, never by its words", () => {
    load("find my account number 123456789012 details", "summarise the plan");
    d.offerRestartRedo();
    const text = asked()[0]?.text ?? "";
    expect(text).toContain("a private task");
    expect(text).not.toMatch(/123456789012|account number/);
    expect(text).toContain("summarise the plan");
  });

  it("names three tasks as a list, and says nothing when nothing was interrupted", () => {
    load("one thing", "two things", "three things");
    d.offerRestartRedo();
    expect(asked()[0]?.text).toContain("one thing, two things and three things");
    d.restartAsked = false;
    setVoiceTaskLedger(fakeLedger().sink);
    said = [];
    d.offerRestartRedo();
    expect(said).toEqual([]);
  });

  it("a yes before the question sounded redoes nothing; after it sounded, the speaker-checked yes redoes them", async () => {
    load("summarise the plan", "find the invoice");
    d.offerRestartRedo();
    d.handleHeard("yes");
    await flush();
    expect(works).toEqual([]);
    expect(listVoiceTasks().filter((t) => t.state === "INTERRUPTED")).toHaveLength(2);
    questionSounds();
    d.handleHeard("yes");
    await flush();
    // Both are on the desk again; the Brain has one lane, so the second waits behind the first.
    expect(works).toEqual(["summarise the plan"]);
    expect(listVoiceTasks().filter((t) => t.state === "INTERRUPTED")).toHaveLength(0);
    expect(listVoiceTasks().filter((t) => t.state === "RUNNING")).toHaveLength(1);
    expect(listVoiceTasks().filter((t) => t.state === "QUEUED")).toHaveLength(1);
    expect(led.rows().filter((r) => r.voice?.redo === "redone")).toHaveLength(2);
    expect(d.restartAsk).toBeNull();
    expect(d.approvalAsked).toBeNull();
  });

  it("a no drops the interrupted tasks from the desk and closes their ledger rows", async () => {
    load("summarise the plan");
    d.offerRestartRedo();
    questionSounds();
    d.handleHeard("no");
    await flush();
    expect(works).toEqual([]);
    expect(listVoiceTasks().filter((t) => t.state === "INTERRUPTED")).toHaveLength(0);
    expect(led.rows()[0]).toMatchObject({ status: "cancelled", voice: { redo: "dropped" } });
    expect(said.at(-1)?.text).toMatch(/dropped/i);
  });

  it("a yes that comes after the 120 s window redoes nothing", async () => {
    load("summarise the plan");
    d.offerRestartRedo();
    questionSounds();
    await vi.advanceTimersByTimeAsync(125_000);
    d.handleHeard("yes");
    await flush();
    expect(works).toEqual([]);
    expect(listVoiceTasks().filter((t) => t.state === "INTERRUPTED")).toHaveLength(1);
  });

  it("a call hold keeps the question off the speaker, so a yes from the call redoes nothing", async () => {
    load("summarise the plan");
    d.callHold = true;
    vi.mocked(d.speak).mockRestore();
    d.offerRestartRedo();
    expect(d.arbiter.size()).toBe(0);
    d.handleHeard("yes");
    await flush();
    expect(works).toEqual([]);
  });

  it("'auto' redoes by itself only when every task only reads AND autonomy is Full; otherwise she asks", async () => {
    const auto = () =>
      preferences.update({
        voice: {
          ...DEFAULT_PREFERENCES.voice,
          tasks: { ...DEFAULT_PREFERENCES.voice.tasks, resumeAfterRestart: "auto" },
        },
      });
    // default is ask, even under Full autonomy
    load("summarise the plan");
    autonomy.update({ approvalLevel: "full" });
    d.offerRestartRedo();
    expect(asked()).toHaveLength(1);
    expect(works).toEqual([]);
    // auto + Balanced: still asks
    auto();
    autonomy.update({ approvalLevel: "balanced" });
    d.restartAsked = false;
    load("summarise the plan");
    said = [];
    d.offerRestartRedo();
    expect(asked()).toHaveLength(1);
    // auto + Full + a task that acts: asks
    autonomy.update({ approvalLevel: "full" });
    d.restartAsked = false;
    load("summarise the plan", "send the plan to Asha");
    said = [];
    d.offerRestartRedo();
    expect(asked()).toHaveLength(1);
    expect(works).toEqual([]);
    // auto + Full + read-only: picks it up without asking
    d.restartAsked = false;
    load("summarise the plan");
    said = [];
    d.offerRestartRedo();
    await flush();
    expect(asked()).toEqual([]);
    expect(works).toEqual(["summarise the plan"]);
    expect(said[0]?.text).toMatch(/up again/);
    // and Stop everything beats it
    autonomy.stopEverything();
    d.restartAsked = false;
    load("find the invoice");
    said = [];
    works.length = 0;
    d.offerRestartRedo();
    await flush();
    expect(works).toEqual([]);
    autonomy.resume();
  });

  it("is offered when Auto announces it is ready, and not before", () => {
    load("summarise the plan");
    d.state.stt = { ready: false };
    d.announceReady();
    expect(asked()).toEqual([]);
    d.state.stt = { ready: true };
    d.announceReady();
    expect(asked()).toHaveLength(1);
  });

  it("the brain is untouched: no turn is sent by the question or the redo question itself", () => {
    const send = vi.spyOn(brain, "send");
    load("summarise the plan");
    d.offerRestartRedo();
    expect(send).not.toHaveBeenCalled();
  });
});
