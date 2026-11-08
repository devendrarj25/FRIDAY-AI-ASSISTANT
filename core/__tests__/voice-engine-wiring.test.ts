import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  answerTaskApproval,
  attachVoiceTaskSpeaker,
  listVoiceTasks,
  releaseTaskUpdates,
  runTaskControl,
  startVoiceTask,
} from "../../src/lib/friday/voice-engine/voice-tasks";
import { classifyVoiceControl } from "../../src/lib/friday/voice-engine/interruption-controller";
import type { VoiceBusy } from "../../src/lib/friday/voice-engine/task-announcer";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("voice task desk", () => {
  it("says task updates only when the voice is quiet and releases them in order", async () => {
    const said: string[] = [];
    let busy: VoiceBusy = "listening-to-owner";
    attachVoiceTaskSpeaker(
      (t) => said.push(t),
      () => busy,
    );
    let finish!: () => void;
    const made = startVoiceTask(
      "Excel report",
      () => new Promise<string>((r) => (finish = () => r("3 sheets"))),
    );
    expect(made.ok).toBe(true);
    expect(said).toEqual([]);
    busy = "idle";
    releaseTaskUpdates();
    expect(said).toEqual(["Started: Excel report."]);
    finish();
    await tick();
    expect(said.at(-1)).toMatch(/Done: Excel report/);
  });

  it("applies spoken task words to the newest task and says so when there is none", async () => {
    const said: string[] = [];
    attachVoiceTaskSpeaker(
      (t) => said.push(t),
      () => "idle",
    );
    expect(runTaskControl({ kind: "cancel-task" })).toBe("No task is running.");
    expect(runTaskControl({ kind: "resume-task" })).toBe("No task is paused.");
    expect(runTaskControl({ kind: "stop-speaking" })).toBeNull();
    startVoiceTask(
      "Long job",
      (_t, ctx) =>
        new Promise((_r, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("x")))),
    );
    await tick();
    expect(runTaskControl(classifyVoiceControl("background task cancel karo"))).toBeNull();
    await tick();
    expect(listVoiceTasks().at(-1)?.state).toBe("CANCELLED");
    expect(said.at(-1)).toBe("Cancelled: Long job.");
  });

  it("holds a risky task until the owner says yes", async () => {
    attachVoiceTaskSpeaker(
      () => undefined,
      () => "idle",
    );
    let ran = false;
    const made = startVoiceTask(
      "Delete old files",
      async () => ((ran = true), "ok"),
      "needs-approval",
    );
    if (!made.ok) throw new Error("create failed");
    await tick();
    expect(ran).toBe(false);
    expect(answerTaskApproval(true)).toBe("Starting Delete old files.");
    await tick();
    expect(ran).toBe(true);
    expect(answerTaskApproval(true)).toBeNull();
  });
});

describe("live wiring", () => {
  const source = (path: string) => readFileSync(path, "utf8");

  it("assistant mode sends task words to the task desk before the plain stop word and keeps stop to speech", () => {
    const mode = source("src/lib/friday/assistant-mode.ts");
    const control = mode.indexOf("classifyVoiceControl(command || text)");
    const stop = mode.indexOf("if (isStopCommand(text))");
    expect(control).toBeGreaterThan(0);
    expect(control).toBeLessThan(stop);
    expect(mode).toContain("attachVoiceTaskSpeaker(");
    expect(mode).toContain("releaseTaskUpdates()");
    expect(mode).toContain("splitLongSpeech(chunk.spoken)");
    const stopBranch = mode.slice(stop, stop + 400);
    expect(stopBranch).not.toMatch(/voiceTasks|runTaskControl|cancel-task/);
  });

  it("the voice settings page shows the engine card", () => {
    expect(source("src/components/friday/settings/VoiceSettings.tsx")).toContain(
      "<VoiceEngineSettings />",
    );
  });
});

import {
  subscribeVoiceTasks,
  voiceTaskActions,
  voiceTaskSnapshot,
} from "../../src/lib/friday/voice-engine/voice-tasks";

describe("voice task panel store", () => {
  it("notifies subscribers on every change and keeps a stable snapshot between changes", async () => {
    attachVoiceTaskSpeaker(
      () => undefined,
      () => "idle",
    );
    let calls = 0;
    const off = subscribeVoiceTasks(() => (calls += 1));
    const before = voiceTaskSnapshot();
    expect(voiceTaskSnapshot()).toBe(before);
    let finish!: () => void;
    const made = startVoiceTask(
      "Panel job",
      () => new Promise<string>((r) => (finish = () => r("ok"))),
      "needs-approval",
    );
    if (!made.ok) throw new Error("create failed");
    expect(calls).toBeGreaterThan(0);
    expect(voiceTaskSnapshot().find((t) => t.id === made.task.id)?.state).toBe(
      "WAITING_FOR_APPROVAL",
    );
    expect(voiceTaskActions.approve(made.task.id, true)).toBe(true);
    await tick();
    expect(voiceTaskSnapshot().find((t) => t.id === made.task.id)?.state).toBe("RUNNING");
    // A runner that never checkpoints can be marked paused and still finish; it must settle, not throw.
    expect(voiceTaskActions.pause(made.task.id)).toBe(true);
    finish();
    await tick();
    expect(voiceTaskSnapshot().find((t) => t.id === made.task.id)?.state).toBe("COMPLETED");
    expect(voiceTaskActions.cancel(made.task.id)).toBe(false);
    off();
    const seen = calls;
    startVoiceTask("After unsubscribe", async () => "x");
    expect(calls).toBe(seen);
  });

  it("the Auto page shows the panel and it offers cancel, pause, resume and a yes or no", () => {
    expect(readFileSync("src/components/friday/AutoMode.tsx", "utf8")).toContain(
      "<VoiceTaskPanel />",
    );
    const panel = readFileSync("src/components/friday/VoiceTaskPanel.tsx", "utf8");
    for (const action of [
      "approve(task.id, true)",
      "approve(task.id, false)",
      "pause(task.id)",
      "resume(task.id)",
      "cancel(task.id)",
    ]) {
      expect(panel).toContain(action);
    }
  });
});
