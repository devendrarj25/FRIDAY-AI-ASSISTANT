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
