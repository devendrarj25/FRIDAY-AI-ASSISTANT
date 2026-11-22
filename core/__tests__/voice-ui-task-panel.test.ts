/**
 * The voice task panel: rows in plain words with an ordinal, waiting reasons, Retry only where the desk has one,
 * every page state (data, loading, empty, error with Retry, offline), and the real task desk behind the buttons.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VoiceTaskPanel, VoiceTaskPanelView } from "../../src/components/friday/VoiceTaskPanel";
import {
  liveTaskActions,
  taskRows,
  type TaskPanelActions,
} from "../../src/lib/friday/voice-task-rows";
import type { TaskState, VoiceTask } from "../../src/lib/friday/voice-engine/task-orchestrator";
import {
  cancelAllVoiceTasks,
  voiceTaskActions,
} from "../../src/lib/friday/voice-engine/voice-tasks";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const task = (n: number, state: string, extra: Partial<VoiceTask> = {}): VoiceTask => ({
  id: `task-${n}`,
  label: `Job ${n}`,
  state: state as TaskState,
  risk: "safe",
  createdAt: n,
  updatedAt: n,
  ...extra,
});

const render = (props: Parameters<typeof VoiceTaskPanelView>[0]) =>
  renderToStaticMarkup(createElement(VoiceTaskPanelView, props));

const fakeActions = (over: Partial<TaskPanelActions> = {}): TaskPanelActions => ({
  approve: vi.fn(() => true),
  pause: vi.fn(() => true),
  resume: vi.fn(() => true),
  cancel: vi.fn(() => true),
  cancelAll: vi.fn(() => 1),
  ...over,
});

describe("taskRows", () => {
  it("lists newest first with the ordinal from the task id and the state in plain words", () => {
    const rows = taskRows([
      task(1, "COMPLETED"),
      task(2, "RUNNING", { percent: 40 }),
      task(3, "QUEUED"),
      task(4, "WAITING_FOR_APPROVAL"),
      task(5, "FAILED", { error: "disk full" }),
      task(6, "CANCELLED"),
    ]);
    expect(rows.map((r) => r.ordinal)).toEqual([6, 5, 4, 3, 2]);
    expect(rows.map((r) => r.words)).toEqual([
      "cancelled",
      "failed",
      "waiting for your yes",
      "queued",
      "running",
    ]);
    expect(rows[1]?.detail).toBe("disk full");
    expect(rows[4]?.detail).toBe("40%");
    expect(rows[3]?.waiting).toBe("behind task 2");
    expect(rows[2]?.waiting).toMatch(/asks first/);
  });

  it("uses the desk's own fields when they exist and says interrupted for an interrupted task", () => {
    const rows = taskRows([
      task(1, "INTERRUPTED", { label: "raw" } as Partial<VoiceTask>),
      {
        ...task(2, "WAITING_FOR_INPUT"),
        spoken: "the report",
        ordinal: 9,
        reason: "which year?",
      } as VoiceTask,
    ]);
    expect(rows[0]).toMatchObject({
      ordinal: 9,
      name: "the report",
      words: "waiting for your answer",
      waiting: "which year?",
      live: true,
    });
    expect(rows[1]).toMatchObject({ words: "interrupted", live: false, canRetry: true });
  });

  it("falls back to the position for an id without a number, and handles Hindi and long names", () => {
    const rows = taskRows([{ ...task(1, "RUNNING"), id: "abc", label: "रिपोर्ट बनाओ & 100% ‘x’" }]);
    expect(rows[0]).toMatchObject({ ordinal: 1, name: "रिपोर्ट बनाओ & 100% ‘x’" });
    expect(taskRows([])).toEqual([]);
  });
});

describe("VoiceTaskPanelView states", () => {
  it("empty says No tasks running and has no buttons", () => {
    const html = render({ tasks: [] });
    expect(html).toContain("No tasks running");
    expect(html).not.toContain("<button");
  });

  it("loading shows the shared loading state, not the list", () => {
    const html = render({ tasks: [], loading: true });
    expect(html).toContain("Loading tasks");
    expect(html).not.toContain("No tasks running");
  });

  it("error shows the message and a Retry button that reloads", () => {
    const html = render({
      tasks: [],
      error: new Error("render failed"),
      onReload: () => undefined,
    });
    expect(html).toContain("render failed");
    expect(html).toContain("Retry");
    expect(html).not.toContain("No tasks running");
  });

  it("offline keeps the list and says the kernel is not connected", () => {
    const html = render({ tasks: [task(1, "RUNNING")], offline: true });
    expect(html).toContain("kernel is not connected");
    expect(html).toContain("Job 1");
    expect(html).toContain("Cancel");
  });

  it("data: Cancel on live work, Cancel all, Yes and No on approval, Pause and Resume", () => {
    const html = render({
      tasks: [
        task(1, "RUNNING"),
        task(2, "WAITING_FOR_APPROVAL"),
        task(3, "PAUSED"),
        task(4, "COMPLETED"),
      ],
    });
    for (const word of ["Pause", "Resume", "Yes", "No", "Cancel all"])
      expect(html).toContain(`>${word}<`);
    expect((html.match(/>Cancel</g) ?? []).length).toBe(3);
    expect(html).toContain("waiting for your yes");
    expect(html).toContain("done");
  });

  it("Retry shows only for failed or interrupted tasks and only when the desk can retry", () => {
    const tasks = [
      task(1, "FAILED", { error: "x" }),
      task(2, "INTERRUPTED" as never),
      task(3, "COMPLETED"),
    ];
    expect(render({ tasks, actions: fakeActions() })).not.toContain(">Retry<");
    const withRetry = render({ tasks, actions: fakeActions({ retry: vi.fn(() => true) }) });
    expect((withRetry.match(/>Retry</g) ?? []).length).toBe(2);
    expect(
      render({ tasks: [task(3, "COMPLETED")], actions: fakeActions({ retry: () => true }) }),
    ).not.toContain(">Retry<");
  });

  it("a finished list has no Cancel all and no Cancel", () => {
    const html = render({ tasks: [task(1, "COMPLETED"), task(2, "FAILED"), task(3, "CANCELLED")] });
    expect(html).not.toContain("Cancel all");
    expect(html).not.toContain(">Cancel<");
  });

  it("shows the notice from a button that changed nothing", () => {
    expect(
      render({ tasks: [task(1, "RUNNING")], notice: "That task already finished." }),
    ).toContain("That task already finished.");
  });
});

describe("the panel on the real task desk", () => {
  it("mounts empty with no desktop (no kernel banner) and reads the live store", () => {
    cancelAllVoiceTasks();
    const html = renderToStaticMarkup(createElement(VoiceTaskPanel));
    expect(html).toContain("Background tasks");
    expect(html).not.toContain("kernel is not connected");
  });

  it("its buttons are the task desk's exports, and Retry waits for the desk to export it", () => {
    expect(liveTaskActions.cancel).toBe(voiceTaskActions.cancel);
    expect(liveTaskActions.pause).toBe(voiceTaskActions.pause);
    expect(liveTaskActions.resume).toBe(voiceTaskActions.resume);
    expect(liveTaskActions.approve).toBe(voiceTaskActions.approve);
    expect(liveTaskActions.cancelAll).toBe(cancelAllVoiceTasks);
    expect(liveTaskActions.retry).toBe((voiceTaskActions as { retry?: unknown }).retry);
  });

  it("is mounted once in the Auto screen, inside the captions area, without touching the orb", () => {
    const auto = read("src/components/friday/AutoMode.tsx");
    expect(auto.match(/<VoiceTaskPanel \/>/g)?.length).toBe(1);
    const panel = read("src/components/friday/VoiceTaskPanel.tsx");
    expect(panel).not.toMatch(/assistantMode|setPaused|stopEverything/);
  });
});
