/**
 * While a run waits at its approval, a "are you still working" is answered with the truth (waiting on your approval, on
 * screen), a screen-only approval gets one spoken line saying so, and a read-back yes that names a known action
 * mints a single-use token bound to that action's tool and exact arguments. Driven with injected state only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import { busyReply, whileBusy } from "../../src/lib/friday/voice-session";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Driver = {
  state: Record<string, unknown> & { mode: string; muted: boolean; paused: boolean };
  arbiter: SpeechArbiter;
  speak: (text: string, meta?: Record<string, unknown>) => void;
  dispatch: (command: string) => boolean;
  runApproved: (command: string) => void;
  voiceBrainApproval: (again?: boolean) => void;
  screenApprovalAt: number;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

describe("whileBusy at an approval", () => {
  const work = { task: "delete the build folder", elapsedMs: 9000 };

  it("a status question says it waits on the approval, on screen", () => {
    const line = busyReply("are you still working", { ...work, awaitingApproval: true });
    expect(line).toMatch(/waiting on your approval/i);
    expect(line).toMatch(/screen/i);
  });

  it("a small 'okay' does not claim the work is running", () => {
    expect(busyReply("okay", { ...work, awaitingApproval: true })).toMatch(/approval/i);
  });

  it("without an approval pending it still says it is working", () => {
    expect(busyReply("are you still working", work)).toMatch(/on it/);
    expect(busyReply("are you still working", { ...work, awaitingApproval: false })).toMatch(
      /on it/,
    );
  });

  it("the decision carries the same line", () => {
    const decision = whileBusy("are you still working", { ...work, awaitingApproval: true });
    expect(decision).toMatchObject({ kind: "reply" });
    expect(decision.kind === "reply" ? decision.line : "").toMatch(/approval/i);
  });

  it("Roman Hindi gets a Roman Hindi line", () => {
    expect(busyReply("kya kar rahi ho", { ...work, awaitingApproval: true })).toMatch(/intezaar/i);
  });
});

describe("the conductor", () => {
  let said: string[] = [];

  beforeEach(async () => {
    await preferences.hydrate();
    preferences.setVoice({ hinglish: false, speechLang: "en-US", speakReplies: true });
    autonomy.reset();
    Object.assign(d.state, { mode: "auto", muted: false, paused: false });
    d.arbiter = new SpeechArbiter({ now: () => Date.now() });
    d.screenApprovalAt = 0;
    said = [];
    d.speak = (text: string) => void said.push(text);
    d.emit = () => undefined;
  });

  afterEach(() => {
    autonomy.reset();
    vi.restoreAllMocks();
  });

  const waitingSnapshot = (owner?: { kind: "task"; taskId: string }) =>
    ({
      messages: [],
      activeRunId: "run-a",
      runs: [
        {
          id: "run-a",
          state: "awaiting-approval",
          prompt: "x",
          trace: [],
          ...(owner ? { owner } : {}),
        },
      ],
      approval: { runId: "run-a", tool: "fs_delete", at: 1000, reason: "delete — needs approval" },
    }) as never;

  it("a screen-only approval says so once", () => {
    vi.spyOn(brain, "getSnapshot").mockReturnValue(waitingSnapshot());
    d.voiceBrainApproval();
    d.voiceBrainApproval();
    expect(said).toEqual(["That needs your tap on screen."]);
  });

  it("an approval of a background task is left to the task desk", () => {
    vi.spyOn(brain, "getSnapshot").mockReturnValue(waitingSnapshot({ kind: "task", taskId: "t1" }));
    d.voiceBrainApproval();
    expect(said).toEqual([]);
  });

  it("the busy reply asks the Brain whether the run waits for approval", () => {
    const snapshot = {
      messages: [],
      activeRunId: "run-b",
      runs: [
        {
          id: "run-b",
          state: "awaiting-approval",
          prompt: "delete it",
          startedAt: Date.now() - 9000,
          trace: [],
        },
      ],
      approval: null,
    } as never;
    vi.spyOn(brain, "getSnapshot").mockReturnValue(snapshot);
    vi.spyOn(brain, "isAwaitingApproval").mockReturnValue(true);
    vi.spyOn(brain, "send").mockImplementation((() => ({ accepted: true })) as never);
    expect(d.dispatch("are you still working")).toBe(true);
    expect(said.join(" ")).toMatch(/waiting on your approval/i);
  });

  it("a read-back yes for a restart mints a token bound to that action and sends it", () => {
    const pre = vi.spyOn(brain, "preApprove").mockReturnValue("yes-token");
    const send = vi.spyOn(brain, "send").mockImplementation((() => ({ accepted: true })) as never);
    d.runApproved("restart yourself");
    expect(pre).toHaveBeenCalledWith("restart yourself", { tool: "app_restart", args: {} });
    const options = send.mock.calls[0]?.[1] as { preApproval?: string } | undefined;
    expect(options?.preApproval).toBe("yes-token");
  });

  it("a command whose tool is not known up front gets no token", () => {
    const pre = vi.spyOn(brain, "preApprove");
    const send = vi.spyOn(brain, "send").mockImplementation((() => ({ accepted: true })) as never);
    d.runApproved("delete my downloads folder");
    expect(pre).not.toHaveBeenCalled();
    const options = send.mock.calls[0]?.[1] as { preApproval?: string } | undefined;
    expect(options?.preApproval).toBeUndefined();
  });

  it("the token is spent on one dispatch, not the next", () => {
    vi.spyOn(brain, "preApprove").mockReturnValue("yes-token");
    const send = vi.spyOn(brain, "send").mockImplementation((() => ({ accepted: true })) as never);
    d.runApproved("restart yourself");
    d.dispatch("what is the weather");
    const options = send.mock.calls[1]?.[1] as { preApproval?: string } | undefined;
    expect(options?.preApproval).toBeUndefined();
  });
});
