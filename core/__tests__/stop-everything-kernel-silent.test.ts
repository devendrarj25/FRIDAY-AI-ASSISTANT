/**
 * When the kernel does not answer the open-task query, Stop everything cannot know whether kernel tasks are still
 * running. It used to count 0 and say "Nothing else was running" while those tasks went on. Now the report says
 * the kernel did not answer. A kernel that answers with an empty list is still "nothing else was running".
 * No kernel, terminal or network is used: the bridges are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import kernelApi from "../../src/lib/friday/kernel-api";
import { autonomy, describeStop } from "../../src/lib/friday/self/autonomy";

type Bridge = Record<string, unknown>;
const g = globalThis as unknown as { window?: { friday?: Bridge } };
g.window ??= globalThis as never;

beforeEach(() => {
  autonomy.reset();
  g.window!.friday = { terminalRuns: async () => [], terminalCancel: async () => ({ ok: true }) };
});
afterEach(() => {
  autonomy.resume();
  autonomy.reset();
  vi.restoreAllMocks();
  delete g.window!.friday;
});

describe("describeStop with a silent kernel", () => {
  it("does not claim nothing was running when the kernel did not answer", () => {
    const line = describeStop({ graphs: 0, kernelTasks: 0, terminalRuns: 0, kernelSilent: true });
    expect(line).not.toMatch(/Nothing else was running/);
    expect(line).toMatch(/kernel did not answer/i);
  });

  it("keeps what did stop and still names the silent kernel", () => {
    const line = describeStop({ graphs: 2, kernelTasks: 0, terminalRuns: 1, kernelSilent: true });
    expect(line).toMatch(/paused 2 background tasks/);
    expect(line).toMatch(/ended 1 terminal run/);
    expect(line).toMatch(/kernel did not answer/i);
  });

  it("an answering kernel keeps the old wording", () => {
    expect(describeStop({ graphs: 0, kernelTasks: 0, terminalRuns: 0 })).toBe(
      "Stopped. Nothing else was running.",
    );
  });
});

describe("autonomy.stopEverything with a silent kernel", () => {
  it("a failing task query is reported, not counted as zero", async () => {
    vi.spyOn(kernelApi.tasks, "pending").mockRejectedValue(new Error("kernel offline"));
    const cancel = vi.spyOn(kernelApi.tasks, "cancel");
    const report = await autonomy.stopEverything().settled;
    expect(cancel).not.toHaveBeenCalled();
    expect(report.kernelSilent).toBe(true);
    expect(describeStop(report)).toMatch(/kernel did not answer/i);
    expect(describeStop(report)).not.toMatch(/Nothing else was running/);
  });

  it("a cancel the kernel never answered is reported too", async () => {
    vi.spyOn(kernelApi.tasks, "pending").mockResolvedValue({
      tasks: [{ taskId: "k-1", state: "running" }],
    } as never);
    vi.spyOn(kernelApi.tasks, "cancel").mockRejectedValue(new Error("timeout"));
    const report = await autonomy.stopEverything().settled;
    expect(report.kernelTasks).toBe(0);
    expect(report.kernelSilent).toBe(true);
  });

  it("an empty answer is a real nothing", async () => {
    vi.spyOn(kernelApi.tasks, "pending").mockResolvedValue({ tasks: [] } as never);
    const report = await autonomy.stopEverything().settled;
    expect(report.kernelSilent).toBeUndefined();
    expect(describeStop(report)).toBe("Stopped. Nothing else was running.");
  });
});
