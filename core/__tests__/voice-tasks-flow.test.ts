/**
 * How the real Auto mode controller treats a background voice task and the foreground turn beside it.
 *
 * An architect's review read `assistant-mode.ts`, `brain-engine.ts` and `voice-engine/voice-tasks.ts` and listed eight
 * "read, not run" findings about work that runs while the owner keeps talking. This file turns each into a fact by
 * driving the real controller, the real Brain singleton and the real task desk:
 *
 *  - `describe("today: ...")` tests are passing characterisations of what the code does now, with the observed
 *    values, so a change in that behaviour shows as a red test that names what moved.
 *  - Every scenario is now fixed and live. Scenarios 1, 3 and 7 landed in round voice-eager-G1 (a foreground stop
 *    leaves a task's run alone, a quick-lane answer is spoken at once, Stop everything cancels every task).
 *    Scenarios 2, 4, 5, 6 and 8 landed with the router, the speech arbiter and the narration policy (P13-P14): a
 *    short question is answered at once at any task age, a background run is announced once instead of streamed,
 *    the "Started" acknowledgement is spoken at once, a background approval is asked aloud, and a call, Do not
 *    disturb and quiet hours hold task announcements. The old `today:` twins that pinned the gaps were rewritten.
 *
 * Nothing opens a microphone, a speaker, a model or the network: the voice output is a recorder (or the real
 * `speak()` with the playback loop replaced, where the gate itself is under test), the Brain turn is a run injected
 * into the real Brain state (so the real `brain.stop()` and the real quick lane run), the speech model is a stub,
 * and the clock is a fixed fake clock.
 */
import { readFileSync } from "node:fs";
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
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";
import {
  createNarrationMemory,
  type NarrationMemory,
} from "../../src/lib/friday/voice-engine/narration-policy";

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
  announceTask: (
    text: string,
    meta?: { priority?: "approval" | "direct" | "progress" | "chatter"; done?: boolean },
  ) => void;
  taskBusy: () => string;
  slowTaskTick: (now: number) => void;
  dropPlayback: () => void;
  afterQuiet: () => void;
  lastOwnerAt: number;
  emit: () => void;
  drainSpeech: () => Promise<void>;
  to: (event: string, detail?: string) => boolean;
  interruptHold: unknown;
  heldPlayed: unknown;
  queuedCommands: string[];
  arbiter: SpeechArbiter;
  narration: NarrationMemory;
  approvalAsked: unknown;
  spokenUpTo: number;
  voicedRunId: string;
  voicedChars: number;
  voicedPrefix: string;
  callHold: boolean;
  noteApprovalSpoken: () => void;
  speakPlan: (
    text: string,
    localOnly?: boolean,
  ) => { argTuning: { allowCloud?: boolean; cloudClip?: unknown; kind?: string } };
  unfinished: string;
  restartAsk: unknown;
  supersedeOnConfirm: unknown;
  cancelSpeech: () => void;
  followKillSwitch: () => void;
  playingItem: { priority: string; taskId?: string } | null;
  approvalSpoken: { at: number; taskId?: string } | null;
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
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  d.narration = createNarrationMemory();
  d.approvalAsked = null;
  d.approvalSpoken = null;
  d.playingItem = null;
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

describe("a short harmless question is answered at once, whatever the age of the task (scenario 2)", () => {
  const QUESTION = "what is the capital of France?";

  it("whileBusy keeps its own 4 s rule for an order: it is queued from 4 s on and interrupts before that", () => {
    expect(whileBusy(QUESTION, { task: "summarise", elapsedMs: 1500 }).kind).toBe("interrupt");
    expect(whileBusy(QUESTION, { task: "summarise", elapsedMs: 3999 }).kind).toBe("interrupt");
    expect(whileBusy(QUESTION, { task: "summarise", elapsedMs: 4000 }).kind).toBe("queue");
    expect(whileBusy(QUESTION, { task: "summarise", elapsedMs: 60_000 }).kind).toBe("queue");
  });

  it.each([1500, 5000, 60_000])(
    "a short harmless question %i ms into the task goes to the quick lane",
    async (ms) => {
      await startBackgroundTask();
      await vi.advanceTimersByTimeAsync(ms);
      const quick = vi.spyOn(inner, "answerQuick");
      d.dispatch(QUESTION);
      expect(quick).toHaveBeenCalledTimes(1);
      expect(quick).toHaveBeenCalledWith(QUESTION, "voice");
      expect(d.queuedCommands).toEqual([]);
      expect(asked).toEqual(["summarise the quarterly report"]); // the task's own run is the only run
    },
  );

  it("an order (not a question) 5 s into the task is still queued with an acknowledgement", async () => {
    await startBackgroundTask();
    await vi.advanceTimersByTimeAsync(5000);
    const quick = vi.spyOn(inner, "answerQuick");
    recorded = [];
    d.dispatch("open the calendar and the mail");
    expect(d.queuedCommands).toEqual(["open the calendar and the mail"]);
    expect(recorded).toEqual(["Got it — I'll do that right after this."]);
    expect(quick).not.toHaveBeenCalled();
    expect(d.state["status"]).toBe("Working — next request queued");
  });

  it("the lane can be turned off (voice.tasks.sideQuestionLane = false): then the age rule applies as before", async () => {
    await startBackgroundTask();
    await vi.advanceTimersByTimeAsync(5000);
    const quick = vi.spyOn(inner, "answerQuick");
    const voice = preferences.getSnapshot().voice as unknown as Record<string, unknown>;
    const saved = voice["tasks"];
    voice["tasks"] = { sideQuestionLane: false };
    try {
      d.dispatch(QUESTION);
    } finally {
      voice["tasks"] = saved;
    }
    expect(quick).not.toHaveBeenCalled();
    expect(d.queuedCommands).toEqual([QUESTION]);
  });
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

describe("a background run is announced once, not voiced as foreground (scenario 4)", () => {
  it("the streamed sentences stay silent and the result is spoken only through 'Done: X'", async () => {
    const task = await startBackgroundTask();
    listenLikeAuto();
    d.spokenUpTo = inner.state.messages.length;
    recorded = [];
    const run = taskRun();
    run.answer = "The totals match. Three sheets were read and nothing is missing.";
    inner.emit(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(recorded).toEqual([]); // nothing is read out while the task still runs
    finishRun(run, run.answer);
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(task.id)?.state).toBe("COMPLETED");
    expect(recorded).toEqual(["Done: summarise the quarterly report. The totals match."]);
    expect(recorded.filter((line) => line.includes("The totals match.")).length).toBe(1);
    expect(recorded.some((line) => line.includes("Three sheets"))).toBe(false);
  });

  it("the finish line is a done line of the arbiter and carries the task", async () => {
    vi.mocked(d.speak).mockRestore();
    const task = await startBackgroundTask();
    d.arbiter.clear();
    finishRun(taskRun(), "The totals match.");
    await vi.advanceTimersByTimeAsync(5);
    const line = d.arbiter.peek().find((row) => row.done);
    expect(line?.text).toBe("Done: summarise the quarterly report. The totals match.");
    expect(line?.taskId).toBe(task.id);
    expect(line?.priority).toBe("direct");
  });
});

describe("the 'Started: X' acknowledgement is spoken at once (scenario 5)", () => {
  it("is said right after the request, with no further owner speech, even though the state is still WAKE_DETECTED", async () => {
    await startBackgroundTask();
    expect(d.state.voiceState).toBe("WAKE_DETECTED");
    expect(d.taskBusy()).toBe("listening-to-owner"); // the legacy announcer would have held it
    expect(recorded).toEqual(["Started: summarise the quarterly report."]);
    expect(listVoiceTasks().at(-1)?.state).toBe("RUNNING");
  });

  it("is not said again when the owner next speaks and falls silent", async () => {
    await startBackgroundTask();
    d.to("vad-speech");
    d.to("vad-silence");
    expect(d.state.voiceState).toBe("LISTENING");
    expect(recorded).toEqual(["Started: summarise the quarterly report."]);
  });
});

describe("a background approval is asked aloud (scenario 6)", () => {
  /** The prompt really sounded: the speech queue handed it out and the voice started (the player is not run here). */
  const promptSounds = (taskId: string) => {
    d.playingItem = { priority: "approval", taskId };
    d.noteApprovalSpoken();
    d.playingItem = null;
  };

  const openApproval = async (options: { sounded?: boolean } = {}) => {
    const task = await startBackgroundTask();
    listenLikeAuto();
    d.spokenUpTo = inner.state.messages.length;
    d.to("vad-speech");
    d.to("vad-silence"); // a quiet voice
    recorded = [];
    const decision = inner.gateAction(taskRun(), APP_RESTART_TOOL, "exec", "Restart FRIDAY");
    await vi.advanceTimersByTimeAsync(5);
    if (options.sounded !== false) promptSounds(task.id);
    return { task, decision };
  };

  it("says what is waiting and that a yes is needed, once, bound to the task", async () => {
    const { task, decision } = await openApproval({ sounded: false });
    expect(inner.state.approval).toMatchObject({ runId: "run-1", tool: APP_RESTART_TOOL });
    expect(recorded).toHaveLength(1);
    expect(recorded.join(" ")).toMatch(/restart friday/i);
    expect(recorded.join(" ")).toMatch(/\byes\b|approv|confirm/i);
    // Queued is not heard: the prompt is bound to a yes only once it has sounded.
    expect(d.approvalAsked).toBeNull();
    promptSounds(task.id);
    expect(d.approvalAsked).toMatchObject({ taskId: task.id });
    expect(d.approvalSpoken).toMatchObject({ taskId: task.id });
    // another Brain change inside the repeat window does not ask again
    inner.emit(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(recorded).toHaveLength(1);
    brain.approve(false);
    await decision;
  });

  it("a short fresh yes approves it (the speaker check still applies), after the prompt", async () => {
    const { decision } = await openApproval();
    await vi.advanceTimersByTimeAsync(20_000);
    d.handleHeard("yes");
    await expect(decision).resolves.toBe(true);
    expect(inner.state.approval).toBeNull();
  });

  it("a yes after the 120 s expiry approves nothing and says it timed out", async () => {
    const { decision } = await openApproval();
    await vi.advanceTimersByTimeAsync(125_000);
    recorded = [];
    d.handleHeard("yes");
    expect(inner.state.approval).not.toBeNull();
    expect(recorded.join(" ")).toMatch(/timed out/i);
    brain.approve(false);
    await decision;
  });

  it("B1: a yes before the prompt ever sounded approves nothing and points to the screen", async () => {
    const { decision } = await openApproval({ sounded: false });
    recorded = [];
    const approve = vi.spyOn(brain, "approve");
    d.handleHeard("yes");
    expect(approve).not.toHaveBeenCalled();
    expect(inner.state.approval).not.toBeNull();
    expect(taskRun().state).toBe("awaiting-approval");
    expect(recorded.join(" ")).toMatch(/check the screen/i);
    // Once the prompt has really sounded, the same yes is the answer.
    promptSounds(
      taskRun().owner?.kind === "task" ? (taskRun().owner as { taskId: string }).taskId : "",
    );
    d.handleHeard("yes");
    await expect(decision).resolves.toBe(true);
  });

  it("B1: a call hold keeps the prompt off the speaker, so a bare yes from the call approves nothing", async () => {
    await startBackgroundTask();
    listenLikeAuto();
    d.callHold = true;
    // The real announcer (not the recorder): a held line is shown and kept, never played.
    vi.mocked(d.speak).mockRestore();
    const approve = vi.spyOn(brain, "approve");
    const decision = inner.gateAction(taskRun(), APP_RESTART_TOOL, "exec", "Restart FRIDAY");
    await vi.advanceTimersByTimeAsync(5);
    expect(d.arbiter.size()).toBe(0);
    expect(d.approvalSpoken).toBeNull();
    d.handleHeard("yes");
    d.handleHeard("ok");
    d.handleHeard("sure");
    expect(approve).not.toHaveBeenCalled();
    expect(inner.state.approval).not.toBeNull();
    expect(taskRun().state).toBe("awaiting-approval");
    d.callHold = false;
    brain.approve(false);
    await decision;
  });

  it("R1: a foreground app-restart approval is screen-only: another prompt's stamp (no task id) never binds a yes to it", async () => {
    injectRun("run-fg", "restart the app", Date.now());
    const run = inner.state.runs.find((r) => r.id === "run-fg") as Run;
    const decision = inner.gateAction(run, APP_RESTART_TOOL, "exec", "Restart FRIDAY");
    await vi.advanceTimersByTimeAsync(5);
    expect(run.state).toBe("awaiting-approval");
    // "Confirm: should I X?" sounded a moment ago: an approval-priority line with no task.
    d.playingItem = { priority: "approval" };
    d.noteApprovalSpoken();
    d.playingItem = null;
    expect(d.approvalSpoken).not.toBeNull();
    recorded = [];
    const approve = vi.spyOn(brain, "approve");
    d.handleHeard("yes");
    expect(approve).not.toHaveBeenCalled();
    expect(run.state).toBe("awaiting-approval");
    expect(recorded.join(" ")).toMatch(/check the screen/i);
    brain.approve(false);
    await decision;
  });

  it("R1: the restart question's stamp (a different task id) never approves a waiting approval, foreground or task-owned", async () => {
    const task = await startBackgroundTask();
    const decision = inner.gateAction(taskRun(), APP_RESTART_TOOL, "exec", "Restart FRIDAY");
    await vi.advanceTimersByTimeAsync(5);
    d.playingItem = { priority: "approval", taskId: "restart-redo" };
    d.noteApprovalSpoken();
    d.playingItem = null;
    const approve = vi.spyOn(brain, "approve");
    d.handleHeard("yes");
    expect(approve).not.toHaveBeenCalled();
    expect(inner.state.approval).not.toBeNull();
    // Its own prompt sounding is what binds it.
    promptSounds(task.id);
    d.handleHeard("yes");
    await expect(decision).resolves.toBe(true);
  });

  it("B1: a prompt that sounded earlier than the approval it was for does not bind the newer one", async () => {
    const { decision } = await openApproval({ sounded: false });
    d.approvalSpoken = {
      at: (inner.state.approval as unknown as { at: number }).at - 5000,
    };
    const approve = vi.spyOn(brain, "approve");
    d.handleHeard("yes");
    expect(approve).not.toHaveBeenCalled();
    brain.approve(false);
    await decision;
  });

  it("B2: Stop clears the approval slot, and a later yes cannot revive the stopped run", async () => {
    const { decision } = await openApproval();
    brain.stop();
    await vi.advanceTimersByTimeAsync(5);
    await expect(decision).resolves.toBe(false);
    expect(inner.state.approval).toBeNull();
    expect(taskRun().state).toBe("failed");
    d.handleHeard("yes");
    expect(taskRun().state).toBe("failed");
    expect(inner.state.activeRunId).not.toBe(taskRun().id);
  });

  it("B2: stopping only the task that owns the run clears its approval too", async () => {
    const { task, decision } = await openApproval();
    brain.stop({ taskId: task.id });
    await vi.advanceTimersByTimeAsync(5);
    await expect(decision).resolves.toBe(false);
    expect(inner.state.approval).toBeNull();
    expect(taskRun().state).toBe("failed");
  });

  it("B2: a slot left over for a run that is no longer awaiting approval is never approved", async () => {
    await startBackgroundTask();
    const run = taskRun();
    run.state = "failed";
    inner.state.approval = {
      runId: run.id,
      tool: APP_RESTART_TOOL,
      reason: "Restart FRIDAY — exec",
      at: Date.now(),
    } as never;
    d.approvalSpoken = { at: Date.now() };
    const approve = vi.spyOn(brain, "approve");
    d.handleHeard("yes");
    expect(approve).not.toHaveBeenCalled();
    expect(run.state).toBe("failed");
    inner.state.approval = null;
  });

  it("an owner who says no denies it", async () => {
    const { decision } = await openApproval();
    d.handleHeard("no");
    await expect(decision).resolves.toBe(false);
  });

  it("a write or exec tool approval that is not an app action stays on the screen only", async () => {
    await startBackgroundTask();
    listenLikeAuto();
    d.spokenUpTo = inner.state.messages.length;
    recorded = [];
    const decision = inner.gateAction(taskRun(), "files.delete", "exec", "Delete the old exports");
    await vi.advanceTimersByTimeAsync(5);
    expect(recorded).toEqual([]);
    if (inner.state.approval) brain.approve(false);
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
    expect(d.arbiter.size()).toBe(0);
    autonomy.resume();
    d.to("vad-speech");
    d.to("vad-silence");
    expect(d.arbiter.size()).toBe(0);
  });
});

describe("a calm moment gates task announcements (scenario 8)", () => {
  const LINE = "Done: summarise the report. Three sheets were read.";
  const said = () =>
    d.arbiter
      .peek()
      .map((row) => row.text)
      .join(" ");

  beforeEach(() => {
    vi.mocked(d.speak).mockRestore(); // the real speak() gates are what is under test
  });

  it("holds the line while a call is open, shows it, and keeps it for the digest", () => {
    d.callHold = true;
    d.announceTask(LINE, { priority: "direct", done: true });
    expect(d.arbiter.size()).toBe(0);
    expect(d.narration.held).toEqual([LINE]);
  });

  it("holds the line under Do not disturb", () => {
    preferences.setToggle("doNotDisturb", true);
    d.announceTask(LINE, { priority: "direct", done: true });
    expect(d.arbiter.size()).toBe(0);
  });

  it("holds the line inside quiet hours", () => {
    preferences.setToggle("quietHours", true);
    preferences.setField("timezone", "UTC");
    preferences.setField("quietStart", "08:00");
    preferences.setField("quietEnd", "12:00");
    d.announceTask(LINE, { priority: "direct", done: true });
    expect(d.arbiter.size()).toBe(0);
  });

  it("a finished task under Do not disturb says nothing and is kept for the screen digest", async () => {
    preferences.setToggle("doNotDisturb", true);
    const task = await startBackgroundTask();
    finishRun(taskRun(), "Three sheets were read.");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(task.id)?.state).toBe("COMPLETED");
    expect(d.arbiter.size()).toBe(0);
    expect(d.narration.held.join(" ")).toContain("Three sheets were read");
  });

  it("speaks it when nothing gates it, and is still gated by Stop everything, mute and Chat mode", () => {
    d.announceTask(LINE, { priority: "direct", done: true });
    expect(said()).toContain("Three sheets were read");
    d.arbiter.clear();
    autonomy.stopEverything();
    d.announceTask(LINE);
    autonomy.resume();
    d.state.muted = true;
    d.announceTask(LINE);
    d.state.muted = false;
    d.state.mode = "chat";
    d.announceTask(LINE);
    expect(d.arbiter.size()).toBe(0);
  });
});

describe("spoken task words reach the desk through the router", () => {
  // The desk keeps finished tasks between tests: count only the ones this test made.
  let before = new Set<string>();
  beforeEach(() => {
    before = new Set(listVoiceTasks().map((row) => row.id));
  });
  const mine = () => listVoiceTasks().filter((row) => !before.has(row.id));
  const lastTask = () => listVoiceTasks().at(-1);
  const never = () =>
    startVoiceTask("never ends", async (_t, context) => {
      await context.checkpoint();
      await new Promise<void>(() => undefined);
      return "never";
    });

  it("'cancel the task' cancels the only live task and the desk says so once", async () => {
    const task = await startBackgroundTask();
    recorded = [];
    d.handleHeard("Friday cancel the task");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(task.id)?.state).toBe("CANCELLED");
    expect(recorded).toEqual(["Cancelled: summarise the quarterly report."]);
  });

  it("'pause the task' and 'resume the task' say what they did (the desk is quiet for them)", async () => {
    const task = await startBackgroundTask();
    recorded = [];
    d.handleHeard("Friday pause the task");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(task.id)?.state).toBe("PAUSED");
    expect(recorded).toEqual(["Paused: summarise the quarterly report."]);
    recorded = [];
    d.handleHeard("Friday resume the task");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(task.id)?.state).toBe("RUNNING");
    expect(recorded).toEqual(["Resumed: summarise the quarterly report."]);
  });

  it("'cancel everything' ends every task with one summary line, not one line per task", async () => {
    never();
    never();
    never();
    await vi.advanceTimersByTimeAsync(5);
    recorded = [];
    d.handleHeard("Friday cancel all tasks");
    await vi.advanceTimersByTimeAsync(5);
    expect(mine().every((row) => row.state === "CANCELLED")).toBe(true);
    expect(mine()).toHaveLength(3);
    expect(recorded).toEqual(["Cancelled 3 tasks."]);
  });

  it("two live tasks and no name: ONE short question that lists them, and nothing is cancelled", async () => {
    startVoiceTask(
      "summarise the budget",
      async (_t, c) => (await c.checkpoint(), new Promise(() => undefined)),
    );
    startVoiceTask(
      "translate the notes",
      async (_t, c) => (await c.checkpoint(), new Promise(() => undefined)),
    );
    await vi.advanceTimersByTimeAsync(5);
    recorded = [];
    d.handleHeard("Friday cancel the task");
    await vi.advanceTimersByTimeAsync(5);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatch(/^Which one: .*budget.* or .*notes.*\?$/);
    expect(mine().filter((row) => row.state === "CANCELLED")).toHaveLength(0);
  });

  it("a name picks the task out of two", async () => {
    startVoiceTask(
      "summarise the budget",
      async (_t, c) => (await c.checkpoint(), new Promise(() => undefined)),
    );
    startVoiceTask(
      "translate the notes",
      async (_t, c) => (await c.checkpoint(), new Promise(() => undefined)),
    );
    await vi.advanceTimersByTimeAsync(5);
    d.handleHeard("Friday cancel the translate task");
    await vi.advanceTimersByTimeAsync(5);
    expect(mine().map((row) => [row.label, row.state])).toEqual([
      ["summarise the budget", "RUNNING"],
      ["translate the notes", "CANCELLED"],
    ]);
  });

  it("no task, and no such task, are said plainly", async () => {
    d.handleHeard("Friday cancel the task");
    expect(recorded).toEqual(["No task is running."]);
    await startBackgroundTask();
    recorded = [];
    d.handleHeard("Friday cancel task 99");
    await vi.advanceTimersByTimeAsync(5);
    expect(recorded).toEqual(["I don't have a task like that."]);
    expect(lastTask()?.state).toBe("RUNNING");
  });

  it("a status question gets a spoken summary of the desk; with no task it falls through to the ordinary turn", async () => {
    await startBackgroundTask();
    recorded = [];
    d.handleHeard("Friday what are you working on");
    await vi.advanceTimersByTimeAsync(5);
    expect(recorded.join(" ")).toMatch(/summarise the quarterly report: running/);
  });

  it("a change of mind within 20 s cancels that task and starts the new one", async () => {
    const first = await startBackgroundTask();
    await vi.advanceTimersByTimeAsync(10_000);
    d.handleHeard("Friday actually summarise the budget sheet in the background");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(first.id)?.state).toBe("CANCELLED");
    const now = listVoiceTasks().at(-1);
    expect(now?.label).toBe("summarise the budget sheet");
    expect(now?.state).not.toBe("CANCELLED");
  });

  it("after 20 s it is a second task, not a replacement", async () => {
    const first = await startBackgroundTask();
    await vi.advanceTimersByTimeAsync(25_000);
    d.handleHeard("Friday actually summarise the budget sheet in the background");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(first.id)?.state).toBe("RUNNING");
    expect(mine()).toHaveLength(2);
  });

  it("a consequential background order asks first, and only a fresh yes starts it", async () => {
    d.handleHeard("Friday delete the old exports folder in the background");
    await vi.advanceTimersByTimeAsync(5);
    expect(mine()).toHaveLength(0);
    expect(d.state.pending?.command).toMatch(/delete the old exports/);
    expect(recorded).toHaveLength(1); // one short question, never two in a row
    expect(recorded[0]).toMatch(/^Should I delete the old exports/);
    expect(recorded[0]?.length).toBeLessThan(80);
    d.handleHeard("yes");
    await vi.advanceTimersByTimeAsync(5);
    expect(mine()).toHaveLength(1);
    expect(d.state.pending).toBeNull();
  });

  it("a SENSITIVE task is acknowledged without its words", async () => {
    d.handleHeard("Friday note that my password is hunter22 and summarise it in the background");
    await vi.advanceTimersByTimeAsync(5);
    expect(mine()).toHaveLength(1);
    expect(recorded.join(" ")).not.toMatch(/password|hunter22/i);
  });

  it("I2: a task whose ANSWER is sensitive is announced without its words, whatever its label said", async () => {
    await startBackgroundTask("summarise the notes");
    recorded = [];
    finishRun(taskRun(), "Your PAN is ABCDE1234F, filed under the new regime.");
    await vi.advanceTimersByTimeAsync(5);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.join(" ")).not.toMatch(/ABCDE1234F|PAN\b/);
  });

  it("I2: a sensitive line is never sent to a cloud voice: the plan is local and the system voice", () => {
    for (const line of [
      "my password is hunter2",
      "the card number is 4111 1111 1111 1111",
      "your OTP is 482913",
    ]) {
      const plan = d.speakPlan(line);
      expect(plan.argTuning.allowCloud, line).toBe(false);
      expect(plan.argTuning.cloudClip, line).toBeUndefined();
      expect(plan.argTuning.kind, line).toBe("system");
    }
    // An ordinary line keeps the owner's chosen route (the cloud is still allowed when nothing forbids it).
    expect(d.speakPlan("It is sunny in Jaipur today.").argTuning.kind).not.toBe("system");
  });

  it("I3: a change of mind that needs a yes leaves the old task RUNNING until the yes", async () => {
    const first = await startBackgroundTask();
    await vi.advanceTimersByTimeAsync(5000);
    d.handleHeard("Friday actually delete the old exports folder in the background");
    await vi.advanceTimersByTimeAsync(5);
    expect(d.state.pending?.command).toMatch(/delete the old exports/);
    expect(taskNow(first.id)?.state).toBe("RUNNING");
    expect(mine()).toHaveLength(1);
    d.handleHeard("yes");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(first.id)?.state).toBe("CANCELLED");
    expect(mine().filter((t) => t.state !== "CANCELLED")).toHaveLength(1);
    expect(mine().at(-1)?.label).toBe("delete the old exports folder");
  });

  it("I3: a no to the confirmation leaves the old task running for good", async () => {
    const first = await startBackgroundTask();
    d.handleHeard("Friday actually delete the old exports folder in the background");
    await vi.advanceTimersByTimeAsync(5);
    d.handleHeard("no");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(first.id)?.state).toBe("RUNNING");
    expect(d.supersedeOnConfirm).toBeNull();
    // the same order confirmed much later is a new order, not a change of mind about the old task
    d.handleHeard("Friday delete the old exports folder in the background");
    await vi.advanceTimersByTimeAsync(5);
    d.handleHeard("yes");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(first.id)?.state).toBe("RUNNING");
  });

  it("an answer containing a link, a path or a command is never read out raw", async () => {
    await startBackgroundTask();
    recorded = [];
    finishRun(
      taskRun(),
      "See https://example.com/a?b=1 and C:\\Users\\me\\file.txt then run npm install.",
    );
    await vi.advanceTimersByTimeAsync(5);
    expect(recorded.join(" ")).not.toMatch(/https?:|C:\\|npm install/);
  });
});

describe("I4: Stop, the tray pause and the stop word forget what was open", () => {
  const openState = () => {
    d.approvalAsked = { askedAt: Date.now(), taskId: "task-1" };
    d.approvalSpoken = { at: Date.now(), taskId: "task-1" };
    d.restartAsk = { ids: ["task-9"] };
    d.supersedeOnConfirm = { id: "task-1", command: "x", at: Date.now() };
    d.unfinished = "and the rest of the old answer";
    d.arbiter.enqueue({ text: "Done: a.", priority: "direct", done: true, ttlMs: 1 });
  };
  const digestWaits = async () => {
    await vi.advanceTimersByTimeAsync(700_000); // a finish line that aged out becomes a digest
    return d.arbiter.takeDigest();
  };

  it("the tray pause clears the asked prompt, the unfinished remainder and the digest", async () => {
    openState();
    d.setPaused(true);
    expect(d.approvalAsked).toBeNull();
    expect(d.approvalSpoken).toBeNull();
    expect(d.restartAsk).toBeNull();
    expect(d.supersedeOnConfirm).toBeNull();
    expect(d.unfinished).toBe("");
    expect(await digestWaits()).toBeNull();
    d.setPaused(false);
  });

  it("Stop everything clears them too, so a continue after resume speaks nothing old", async () => {
    openState();
    autonomy.stopEverything();
    await vi.advanceTimersByTimeAsync(5);
    expect(d.approvalAsked).toBeNull();
    expect(d.unfinished).toBe("");
    expect(await digestWaits()).toBeNull();
  });

  it("the stop word (cancelSpeech) clears the open prompt, the remainder and the digest", async () => {
    openState();
    d.cancelSpeech();
    expect(d.approvalAsked).toBeNull();
    expect(d.approvalSpoken).toBeNull();
    expect(d.unfinished).toBe("");
    expect(await digestWaits()).toBeNull();
  });
});

describe("the speech queue and the narration around a task", () => {
  const progressLine = "About 50 percent done.";

  it("the owner talking holds a task line; it is released a moment after he stops, never before", async () => {
    vi.mocked(d.speak).mockRestore();
    d.to("vad-speech");
    d.announceTask("Paused: summarise.", { priority: "direct" });
    expect(d.arbiter.size()).toBe(1);
    expect(d.arbiter.next()).toBeNull();
    d.to("vad-silence");
    expect(d.arbiter.next()).toBeNull(); // inside the 600 ms grace
    await vi.advanceTimersByTimeAsync(700);
    expect(d.arbiter.next()?.text).toBe("Paused: summarise.");
  });

  it("a barge-in drops queued answers and progress but keeps an approval prompt", () => {
    vi.mocked(d.speak).mockRestore();
    d.arbiter.enqueue({ text: "an answer", priority: "direct" });
    d.arbiter.enqueue({ text: progressLine, priority: "progress", taskId: "t1" });
    d.arbiter.enqueue({ text: "Restart FRIDAY: shall I go ahead?", priority: "approval" });
    d.dropPlayback();
    expect(d.arbiter.peek().map((row) => row.text)).toEqual(["Restart FRIDAY: shall I go ahead?"]);
  });

  it("a paused microphone (the tray kill switch) shows a task line and never speaks it", () => {
    vi.mocked(d.speak).mockRestore();
    d.state.paused = true;
    d.announceTask("Cancelled: summarise.", { priority: "direct" });
    d.state.paused = false;
    expect(d.arbiter.size()).toBe(0);
  });

  it("progress lines of one task coalesce: only the newest is kept", () => {
    vi.mocked(d.speak).mockRestore();
    d.announceTask("About 25 percent done.", { priority: "progress", taskId: "t1" } as never);
    expect(d.arbiter.size()).toBe(1);
  });

  it("three running tasks and a quiet owner get one rolled-up line, on the slow beat only", async () => {
    for (let i = 0; i < 3; i += 1)
      startVoiceTask(
        `job ${i}`,
        async (_t, c) => (await c.checkpoint(), new Promise(() => undefined)),
      );
    await vi.advanceTimersByTimeAsync(70_000);
    d.lastOwnerAt = 0;
    recorded = [];
    d.slowTaskTick(Date.now());
    expect(recorded).toEqual(["3 tasks are running."]);
    d.slowTaskTick(Date.now() + 1000);
    expect(recorded).toHaveLength(1); // not again inside the minute
  });

  it("what a call held back is shown as one text digest when the call ends, never spoken at the time", async () => {
    d.callHold = true;
    const task = await startBackgroundTask();
    finishRun(taskRun(), "Three sheets were read.");
    await vi.advanceTimersByTimeAsync(5);
    expect(taskNow(task.id)?.state).toBe("COMPLETED");
    expect(recorded.join(" ")).not.toContain("Three sheets");
    d.callHold = false;
    d.afterQuiet();
    const captions = d.state["captions"] as { who: string; text: string }[];
    expect(captions.at(-1)?.text).toMatch(/^While you were busy: .*Three sheets were read/);
    d.afterQuiet();
    expect((d.state["captions"] as unknown[]).length).toBe(captions.length); // once
  });

  it("speak done off: the finish shows on screen and is not spoken", async () => {
    const voice = preferences.getSnapshot().voice as unknown as Record<string, unknown>;
    const saved = voice["tasks"];
    voice["tasks"] = { speakDone: false };
    try {
      await startBackgroundTask();
      recorded = [];
      finishRun(taskRun(), "Three sheets were read.");
      await vi.advanceTimersByTimeAsync(5);
    } finally {
      voice["tasks"] = saved;
    }
    expect(recorded).toEqual([]);
  });
});

describe("the three modules are the conductor's only path", () => {
  const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");

  it("one arbiter replaces the string queue, and every spoken line goes through it", () => {
    expect(mode).not.toMatch(/\bspeechQueue\b/);
    expect(mode).toContain("private arbiter = new SpeechArbiter(");
    expect(mode).toMatch(/this\.arbiter\.enqueue\(\{/);
    expect(mode).toMatch(/const item = this\.arbiter\.next\(\);/);
    expect(mode).toMatch(/this\.arbiter\.finish\(item\.id\)/);
    expect(mode).toMatch(/this\.arbiter\.setOwnerSpeaking\(next === "SPEECH_DETECTED"\)/);
    expect(mode).toMatch(/this\.arbiter\.waitMs\(\)/);
    expect(mode).toMatch(/this\.arbiter\.bargeIn\(\)/);
    expect(mode).toMatch(/this\.arbiter\.takeDigest\(\)/);
  });

  it("every final transcript is routed, task updates are narrated, one memory per session", () => {
    expect(mode).toMatch(/routeUtterance\(\{/);
    expect(mode).toContain("private narration = createNarrationMemory();");
    expect(mode).toMatch(/const out = narrate\(event, ctx\);/);
    expect(mode).toContain('{ kind: "rollup" }');
    expect(mode).toContain('kind: "settled"');
    expect(mode).toMatch(/holdDigest\(this\.narration, lang\)/);
    expect(mode).toMatch(/attachVoiceTaskNarrator\(\(update, task\) =>/);
  });

  it("the slow beat rides the supervisor tick and adds no timer of its own", () => {
    const at = mode.indexOf("private slowTaskTick(");
    const body = mode.slice(at, mode.indexOf("private superviseTick()", at));
    expect(body).not.toMatch(/setInterval|setTimeout/);
    expect(mode).toMatch(/this\.slowTaskTick\(now\);/);
  });

  it("a background run's answer is never streamed as the foreground reply", () => {
    expect(mode).toMatch(/owner\?\.kind === "task"[\s\S]{0,400}return;/);
    expect(mode).toMatch(
      /runs\.find\(\(row\) => row\.id === m\.runId\)\?\.owner\?\.kind !== "task"/,
    );
  });
});
