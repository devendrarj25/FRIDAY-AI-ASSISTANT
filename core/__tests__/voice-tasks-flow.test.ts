/**
 * How the real Auto mode controller treats a background voice task and the foreground turn beside it.
 *
 * An architect's review read `assistant-mode.ts`, `brain-engine.ts` and `voice-engine/voice-tasks.ts` and listed eight
 * "read, not run" findings about work that runs while the owner keeps talking. This file turns each into a fact by
 * driving the real controller, the real Brain singleton and the real task desk:
 *
 *  - `describe("today: ...")` tests are passing characterisations of what the code does now, with the observed
 *    values, so a change in that behaviour shows as a red test that names what moved.
 *  - `describe.skip("TARGET ...")` blocks hold the behaviour the owner wants (the router and arbiter round) and are
 *    not built yet. Each was run RED against the code before being skipped; when it lands, switch that one
 *    `describe.skip` to `describe` and the guard must go green, and its `today:` twin is then rewritten (or deleted
 *    with the behaviour it pins) in the same change.
 *  - Scenarios 1, 3 and 7 are fixed (round voice-eager-G1): a foreground stop leaves a task's run alone, a
 *    quick-lane answer is spoken at once, and Stop everything cancels every task. Their `today:` twins now state
 *    the new truth and the TARGET twins are live.
 *
 * Nothing opens a microphone, a speaker, a model or the network: the voice output is a recorder (or the real
 * `speak()` with the playback loop replaced, where the gate itself is under test), the Brain turn is a run injected
 * into the real Brain state (so the real `brain.stop()` and the real quick lane run), the speech model is a stub,
 * and the clock is a fixed fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { brain, type Run } from "../../src/lib/friday/brain-engine";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { preferences } from "../../src/lib/friday/preferences";
import { APP_RESTART_TOOL } from "../../src/lib/friday/app-control";
import {
  listVoiceTasks,
  releaseTaskUpdates,
  startVoiceTask,
  voiceTaskActions,
} from "../../src/lib/friday/voice-engine/voice-tasks";
import { whileBusy } from "../../src/lib/friday/voice-session";

vi.mock("../../src/lib/friday/ask", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/friday/ask")>();
  return {
    ...real,
    canAsk: () => true,
    askFriday: async () => "Paris is the capital of France.",
  };
});

type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    paused: boolean;
    muted: boolean;
    speaking: boolean;
    handsFree: boolean;
    voiceState: string;
    pending: { command: string; reason: string; at: number } | null;
  };
  handleHeard: (text: string) => void;
  setPaused: (paused: boolean) => void;
  dispatch: (command: string) => void;
  speak: (text: string) => void;
  holdForInterruption: () => void;
  speakNewReplies: () => void;
  speakQuickAnswer: (answer: unknown) => void;
  announceTask: (text: string) => void;
  taskBusy: () => string;
  emit: () => void;
  drainSpeech: () => Promise<void>;
  to: (event: string, detail?: string) => boolean;
  interruptHold: unknown;
  heldPlayed: unknown;
  queuedCommands: string[];
  speechQueue: string[];
  spokenUpTo: number;
  voicedRunId: string;
  voicedChars: number;
  voicedPrefix: string;
  callHold: boolean;
  awakeUntil: number;
  followUpUntil: number;
  lastWakeAt: number;
  liveWakeAt: number;
};
const d = assistantMode as unknown as Driver;
const win = globalThis as unknown as { window?: unknown };
win.window ??= globalThis;

type BrainInner = {
  state: {
    runs: Run[];
    messages: Record<string, unknown>[];
    activeRunId: string | null;
    approval: { runId: string; tool: string; reason: string } | null;
    log: { level: string; line: string }[];
  };
  emit: (persist?: boolean) => void;
  gateAction: (run: Run, tool: string, risk: string, label: string) => Promise<boolean>;
  answerQuick: (text: string, surface: "voice" | "chat") => Promise<void>;
};
const inner = brain as unknown as BrainInner;
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];

const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
let recorded: string[] = [];
let asked: string[] = [];
let unsubscribe: (() => void)[] = [];
const savedFields: Record<string, string> = {};

/** The same wiring `startAuto` makes: every Brain change and every quick-lane answer is read by the controller. */
function listenLikeAuto() {
  unsubscribe.push(brain.subscribe(() => d.speakNewReplies()));
  unsubscribe.push(brain.onQuickAnswer((answer) => d.speakQuickAnswer(answer)));
}

/** A run in the real Brain state, as `startRun` leaves it while a turn is working. */
function injectRun(
  id: string,
  prompt: string,
  startedAt: number,
  answer = "",
  owner?: Run["owner"],
): Run {
  const run = {
    id,
    prompt,
    intent: "general",
    intentLabel: "General",
    confidence: 1,
    matched: [],
    stages: [],
    agents: [],
    recalled: [],
    state: "running",
    answer,
    startedAt,
    ms: 0,
    ...(owner ? { owner } : {}),
  } as unknown as Run;
  inner.state.runs = [run, ...inner.state.runs];
  inner.state.activeRunId = id;
  inner.state.messages = [
    ...inner.state.messages,
    { id: `m-${id}`, role: "user", text: prompt, at: startedAt, runId: id, source: "voice" },
  ];
  inner.emit(false);
  return run;
}

/** The run ends the way `finish` leaves it: done, answer stored once as the reply, nothing active. */
function finishRun(run: Run, answer: string) {
  run.state = "done";
  run.answer = answer;
  inner.state.messages = [
    ...inner.state.messages,
    { id: `a-${run.id}`, role: "friday", text: answer, at: Date.now(), runId: run.id },
  ];
  inner.state.activeRunId = null;
  inner.emit(false);
}

function taskRun(): Run {
  const run = inner.state.runs.find((row) => row.id === "run-1");
  if (!run) throw new Error("the background task never asked the Brain");
  return run;
}

/** "Friday ... in the background" through the real controller; the task asks the (injected) Brain. */
async function startBackgroundTask(request = "summarise the quarterly report") {
  d.handleHeard(`Friday ${request} in the background`);
  await vi.advanceTimersByTimeAsync(5);
  const task = listVoiceTasks().at(-1);
  if (!task) throw new Error("no task was started");
  return task;
}

const taskNow = (id: string) => listVoiceTasks().find((row) => row.id === id);

beforeEach(async () => {
  vi.useFakeTimers({ now: T0 });
  inner.state.runs = [];
  inner.state.messages = [];
  inner.state.activeRunId = null;
  inner.state.approval = null;
  inner.emit(false);
  autonomy.reset();
  recorded = [];
  asked = [];
  unsubscribe = [];
  for (const key of ["timezone", "quietStart", "quietEnd"])
    savedFields[key] = preferences.getSnapshot().fields[key] ?? "";
  Object.assign(d.state, {
    mode: "auto",
    paused: false,
    muted: false,
    speaking: false,
    handsFree: true,
    voiceState: "LISTENING",
    pending: null,
  });
  d.queuedCommands = [];
  d.speechQueue = [];
  d.interruptHold = null;
  d.heldPlayed = null;
  d.callHold = false;
  d.voicedRunId = "";
  d.voicedChars = 0;
  d.voicedPrefix = "";
  d.spokenUpTo = 0;
  d.awakeUntil = Date.now() + 8000;
  d.followUpUntil = Date.now() + 8000;
  d.lastWakeAt = 0;
  d.liveWakeAt = 0;
  d.emit = () => undefined;
  d.drainSpeech = async () => undefined; // the queue is kept so a test can read what would be said
  vi.spyOn(d, "speak").mockImplementation(() => undefined);
  releaseTaskUpdates(); // an update held by an earlier test is not this test's
  vi.mocked(d.speak).mockImplementation((text: string) => void recorded.push(text));
  // `send` is the real one while a run is active (busy or the quick lane); a first turn becomes an injected run.
  const realSend = brain.send.bind(brain);
  vi.spyOn(brain, "send").mockImplementation(((
    text: string,
    options?: { owner?: Run["owner"] },
  ) => {
    if (inner.state.activeRunId) return realSend(text, options as never);
    asked.push(text);
    const id = `run-${asked.length}`;
    injectRun(id, text, Date.now(), "", options?.owner);
    return { accepted: true, reason: "accepted", message: null, runId: id };
  }) as never);
});

afterEach(async () => {
  for (const task of listVoiceTasks())
    if (!TERMINAL.includes(task.state)) voiceTaskActions.cancel(task.id);
  await vi.advanceTimersByTimeAsync(5);
  unsubscribe.forEach((off) => off());
  autonomy.resume();
  autonomy.reset();
  preferences.setToggle("doNotDisturb", false);
  preferences.setToggle("quietHours", false);
  for (const [key, value] of Object.entries(savedFields)) preferences.setField(key, value);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("only the foreground reply stops, a background task survives (scenario 1)", () => {
  const taskSurvives = async (id: string) => {
    await vi.advanceTimersByTimeAsync(5);
    expect(taskRun().state).toBe("running");
    expect(taskNow(id)?.state).toBe("RUNNING");
  };

  it("a real barge-in stops only the foreground reply and leaves the background task running", async () => {
    const task = await startBackgroundTask();
    const stop = vi.spyOn(brain, "stop");
    d.holdForInterruption();
    expect(d.interruptHold).not.toBeNull();
    d.handleHeard("Friday what is the weather in Delhi");
    expect(stop).toHaveBeenCalledWith("foreground");
    expect(stop).not.toHaveBeenCalledWith();
    await taskSurvives(task.id);
  });

  it("the stop word stops only the foreground reply and leaves the background task running", async () => {
    const task = await startBackgroundTask();
    const stop = vi.spyOn(brain, "stop");
    d.handleHeard("Friday stop");
    expect(stop).toHaveBeenCalledWith("foreground");
    expect(stop).not.toHaveBeenCalledWith();
    await taskSurvives(task.id);
  });

  it("a change of mind about the foreground request leaves the background task running", async () => {
    const task = await startBackgroundTask();
    expect(whileBusy("actually open the calendar", { task: "x", elapsedMs: 9000 }).kind).toBe(
      "interrupt",
    );
    d.dispatch("actually open the calendar");
    await taskSurvives(task.id);
  });

  it("the task desk never marks a task FAILED because the foreground stopped", async () => {
    const task = await startBackgroundTask();
    d.handleHeard("Friday stop");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(task.id)?.state).not.toBe("FAILED");
    expect(taskNow(task.id)?.error).toBeUndefined();
  });
});

describe("today: a short harmless question during a long task depends on its age (scenario 2)", () => {
  const QUESTION = "what is the capital of France?";

  it("whileBusy queues it from 4 s on and interrupts before that", () => {
    expect(whileBusy(QUESTION, { task: "summarise", elapsedMs: 1500 }).kind).toBe("interrupt");
    expect(whileBusy(QUESTION, { task: "summarise", elapsedMs: 3999 }).kind).toBe("interrupt");
    expect(whileBusy(QUESTION, { task: "summarise", elapsedMs: 4000 }).kind).toBe("queue");
    expect(whileBusy(QUESTION, { task: "summarise", elapsedMs: 60_000 }).kind).toBe("queue");
  });

  it("5 s after the task started it is queued with an acknowledgement, not answered", async () => {
    await startBackgroundTask();
    await vi.advanceTimersByTimeAsync(5000);
    const quick = vi.spyOn(inner, "answerQuick");
    d.dispatch(QUESTION);
    expect(d.queuedCommands).toEqual([QUESTION]);
    expect(recorded).toEqual(["Got it — I'll do that right after this."]);
    expect(quick).not.toHaveBeenCalled();
    expect(asked).toEqual(["summarise the quarterly report"]);
    expect(d.state["status"]).toBe("Working — next request queued");
  });

  it("1.5 s after the task started the same question reaches the quick lane (younger is answered, older is queued)", async () => {
    await startBackgroundTask();
    await vi.advanceTimersByTimeAsync(1500);
    const quick = vi.spyOn(inner, "answerQuick");
    d.dispatch(QUESTION);
    expect(quick).toHaveBeenCalledTimes(1);
    expect(quick).toHaveBeenCalledWith(QUESTION, "voice");
    expect(d.queuedCommands).toEqual([]);
  });
});

describe.skip("TARGET (fails today, fixed by P13-P14): the side-question lane answers at once, whatever the age", () => {
  it.each([1500, 5000, 60_000])(
    "a short harmless question %i ms into the task goes to the quick lane",
    async (ms) => {
      await startBackgroundTask();
      await vi.advanceTimersByTimeAsync(ms);
      const quick = vi.spyOn(inner, "answerQuick");
      d.dispatch("what is the capital of France?");
      expect(quick).toHaveBeenCalledWith("what is the capital of France?", "voice");
      expect(d.queuedCommands).toEqual([]);
    },
  );
});

describe("a quick-lane answer is spoken at once (scenario 3)", () => {
  it("is voiced while the long run is still active, once, without a double period", async () => {
    await startBackgroundTask();
    listenLikeAuto();
    d.spokenUpTo = inner.state.messages.length;
    const result = brain.send("what is the capital of France?", { routingSurface: "voice" });
    expect(result.reason).toBe("quick-lane");
    await vi.advanceTimersByTimeAsync(5);
    expect(inner.state.activeRunId).toBe("run-1");
    expect(recorded.join(" ")).toContain("Paris is the capital of France.");
    expect(recorded.join(" ")).not.toMatch(/\.\./);
    const heardOnce = recorded.length;
    finishRun(taskRun(), "The report has three sheets.");
    await vi.advanceTimersByTimeAsync(5);
    expect(recorded.slice(heardOnce).join(" ")).not.toContain("Paris is the capital of France.");
  });
});

describe("today: a background run's streamed answer is voiced as foreground, then Done says it again (scenario 4)", () => {
  const ANSWER = "The totals match. Three sheets were read and nothing is missing.";

  it("says each streamed sentence while the task still runs, then 'Done: X' repeats the first one", async () => {
    const task = await startBackgroundTask();
    listenLikeAuto();
    d.spokenUpTo = inner.state.messages.length;
    const run = taskRun();
    run.answer = ANSWER;
    inner.emit(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(task.id)?.state).toBe("RUNNING");
    expect(recorded).toEqual(["The totals match."]);
    finishRun(run, ANSWER);
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(task.id)?.state).toBe("COMPLETED");
    expect(recorded).toEqual([
      "The totals match.",
      "Three sheets were read and nothing is missing.",
    ]);
    // The announcer waits for a quiet voice; the next entry into LISTENING releases it.
    d.to("vad-speech");
    d.to("vad-silence");
    expect(recorded.at(-1)).toBe("Done: summarise the quarterly report. The totals match.");
    expect(recorded.filter((line) => line.includes("The totals match.")).length).toBe(2);
  });
});

describe.skip("TARGET (fails today, fixed by P13-P14): a background run is announced once, not voiced as foreground", () => {
  it("the streamed sentences stay silent and the result is spoken only through 'Done: X'", async () => {
    const task = await startBackgroundTask();
    listenLikeAuto();
    d.spokenUpTo = inner.state.messages.length;
    const run = taskRun();
    run.answer = "The totals match. Three sheets were read and nothing is missing.";
    inner.emit(false);
    await vi.advanceTimersByTimeAsync(5);
    finishRun(run, run.answer);
    await vi.advanceTimersByTimeAsync(5);
    d.to("vad-speech");
    d.to("vad-silence");
    expect(taskNow(task.id)?.state).toBe("COMPLETED");
    expect(recorded.filter((line) => line.includes("The totals match.")).length).toBe(1);
    expect(recorded.some((line) => line.startsWith("Done: "))).toBe(true);
  });
});

describe("today: the 'Started: X' acknowledgement waits for the next LISTENING entry (scenario 5)", () => {
  it("stays held because the state stays WAKE_DETECTED, which taskBusy maps to listening-to-owner", async () => {
    await startBackgroundTask();
    expect(d.state.voiceState).toBe("WAKE_DETECTED");
    expect(d.taskBusy()).toBe("listening-to-owner");
    expect(recorded).toEqual([]);
    expect(listVoiceTasks().at(-1)?.state).toBe("RUNNING");
  });

  it("is spoken only when the owner next speaks and falls silent (the next LISTENING entry)", async () => {
    await startBackgroundTask();
    d.to("vad-speech");
    expect(recorded).toEqual([]);
    d.to("vad-silence");
    expect(d.state.voiceState).toBe("LISTENING");
    expect(d.taskBusy()).toBe("idle");
    expect(recorded).toEqual(["Started: summarise the quarterly report."]);
  });
});

describe.skip("TARGET (fails today, fixed by P13-P14): the 'Started: X' acknowledgement is spoken at once", () => {
  it("is said right after the request, with no further owner speech", async () => {
    await startBackgroundTask();
    expect(recorded).toEqual(["Started: summarise the quarterly report."]);
  });
});

describe("today: an approval needed in the background is silent (scenario 6)", () => {
  it("gateAction only sets the approval slot: no spoken prompt, no pending line, the task still reads RUNNING", async () => {
    const task = await startBackgroundTask();
    listenLikeAuto();
    d.spokenUpTo = inner.state.messages.length;
    d.to("vad-speech");
    d.to("vad-silence"); // a quiet voice, so silence is not just a held line
    recorded = [];
    const decision = inner.gateAction(taskRun(), APP_RESTART_TOOL, "exec", "Restart FRIDAY");
    await vi.advanceTimersByTimeAsync(5);
    expect(inner.state.approval).toMatchObject({
      runId: "run-1",
      tool: APP_RESTART_TOOL,
      risk: "exec",
    });
    expect(taskRun().state).toBe("awaiting-approval");
    expect(taskNow(task.id)?.state).toBe("RUNNING"); // the task desk never sees WAITING_FOR_APPROVAL
    expect(d.taskBusy()).toBe("idle");
    expect(recorded).toEqual([]);
    expect(d.speechQueue).toEqual([]);
    expect(d.state.pending).toBeNull();
    brain.approve(false);
    await decision;
  });
});

describe.skip("TARGET (fails today, fixed by P13-P14): a background approval is asked aloud", () => {
  it("says what is waiting and that a yes is needed", async () => {
    await startBackgroundTask();
    listenLikeAuto();
    d.spokenUpTo = inner.state.messages.length;
    d.to("vad-speech");
    d.to("vad-silence");
    recorded = [];
    const decision = inner.gateAction(taskRun(), APP_RESTART_TOOL, "exec", "Restart FRIDAY");
    await vi.advanceTimersByTimeAsync(5);
    expect(recorded.join(" ")).toMatch(/restart friday/i);
    expect(recorded.join(" ")).toMatch(/\byes\b|approv|confirm/i);
    brain.approve(false);
    await decision;
  });
});

describe("Stop everything and the tray pause end every desk task (scenario 7)", () => {
  it("a desk task that is not inside a Brain turn is CANCELLED; the queue, the confirmation and the microphone are stopped", async () => {
    const made = startVoiceTask("paused work", async (_task, context) => {
      await context.checkpoint();
      await new Promise<void>(() => undefined);
      return "never";
    });
    await vi.advanceTimersByTimeAsync(5);
    const id = made.ok ? made.task.id : "";
    d.queuedCommands = ["open mail"];
    d.state.pending = { command: "delete my downloads", reason: "exec", at: Date.now() };
    autonomy.stopEverything();
    await vi.advanceTimersByTimeAsync(5);
    expect(d.queuedCommands).toEqual([]);
    expect(d.state.pending).toBeNull();
    expect(d.state.paused).toBe(true);
    expect(taskNow(id)?.state).toBe("CANCELLED");
  });

  it("a task inside a Brain turn ends CANCELLED, not COMPLETED with 'Stopped.'", async () => {
    const task = await startBackgroundTask();
    const stop = vi.spyOn(brain, "stop");
    autonomy.stopEverything();
    await vi.advanceTimersByTimeAsync(5);
    expect(stop).toHaveBeenCalledWith();
    expect(taskNow(task.id)?.state).toBe("CANCELLED");
    expect(taskNow(task.id)?.result).not.toBe("Stopped.");
  });

  it("the tray pause is the kill switch too: it ends the background task and the Brain's turn", async () => {
    const task = await startBackgroundTask();
    const stop = vi.spyOn(brain, "stop");
    d.setPaused(true);
    await vi.advanceTimersByTimeAsync(5);
    expect(stop).toHaveBeenCalledWith();
    expect(taskNow(task.id)?.state).toBe("CANCELLED");
  });

  it("nothing is spoken for a stopped task: the switch gates speak() and the line is not kept or replayed", async () => {
    vi.mocked(d.speak).mockRestore();
    const task = await startBackgroundTask();
    autonomy.stopEverything();
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(task.id)?.state).toBe("CANCELLED");
    expect(d.speechQueue).toEqual([]);
    autonomy.resume();
    d.to("vad-speech");
    d.to("vad-silence");
    expect(d.speechQueue).toEqual([]);
  });
});

describe("today: a meeting and quiet hours do not gate task announcements (scenario 8)", () => {
  const LINE = "Done: summarise the report. Three sheets were read.";
  const said = () => d.speechQueue.join(" ");

  beforeEach(() => {
    vi.mocked(d.speak).mockRestore(); // the real speak() gates are what is under test
  });

  it("speaks it while a call is open (callHold), and taskBusy still says idle", () => {
    d.callHold = true;
    expect(d.taskBusy()).toBe("idle");
    d.announceTask(LINE);
    expect(said()).toContain("Three sheets were read");
  });

  it("speaks it under Do not disturb", () => {
    preferences.setToggle("doNotDisturb", true);
    d.announceTask(LINE);
    expect(said()).toContain("Three sheets were read");
  });

  it("speaks it inside quiet hours", () => {
    preferences.setToggle("quietHours", true);
    preferences.setField("timezone", "UTC");
    preferences.setField("quietStart", "08:00");
    preferences.setField("quietEnd", "12:00");
    d.announceTask(LINE);
    expect(said()).toContain("Three sheets were read");
  });

  it("is gated by Stop everything, mute and Chat mode, so the gate list is only missing the three above", () => {
    autonomy.stopEverything();
    d.announceTask(LINE);
    autonomy.resume();
    d.state.muted = true;
    d.announceTask(LINE);
    d.state.muted = false;
    d.state.mode = "chat";
    d.announceTask(LINE);
    expect(d.speechQueue).toEqual([]);
  });
});

describe.skip("TARGET (fails today, fixed by P13-P14): a calm moment gates task announcements", () => {
  const LINE = "Done: summarise the report. Three sheets were read.";

  beforeEach(() => {
    vi.mocked(d.speak).mockRestore();
  });

  it("holds the line while a call is open", () => {
    d.callHold = true;
    d.announceTask(LINE);
    expect(d.speechQueue).toEqual([]);
  });

  it("holds the line under Do not disturb", () => {
    preferences.setToggle("doNotDisturb", true);
    d.announceTask(LINE);
    expect(d.speechQueue).toEqual([]);
  });

  it("holds the line inside quiet hours", () => {
    preferences.setToggle("quietHours", true);
    preferences.setField("timezone", "UTC");
    preferences.setField("quietStart", "08:00");
    preferences.setField("quietEnd", "12:00");
    d.announceTask(LINE);
    expect(d.speechQueue).toEqual([]);
  });
});
