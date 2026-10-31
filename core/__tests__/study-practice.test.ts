import { beforeEach, describe, expect, it } from "vitest";
import {
  practiceInSandbox,
  resetStudyForTests,
  studySuccesses,
} from "../../src/lib/friday/self/study-practice";
import type { ToolPort } from "../../src/lib/friday/brain/tool-checks";
import type { VerifiedResult } from "../../src/lib/friday/brain/verified-run";

const task = {
  id: "study-1",
  title: "parse csv",
  task: "Parse a CSV string",
  band: "easy",
} as never;
const port: ToolPort = { runCode: async () => ({ ok: true, output: "ok" }) } as never;
const result = (over: Partial<VerifiedResult>): VerifiedResult => ({
  answer: "```python\nprint(1)\n```",
  rung: "local",
  verified: true,
  checked: ["runnable-code"],
  attempts: [],
  escalated: false,
  note: "ok",
  ...over,
});

describe("study practice", () => {
  beforeEach(() => resetStudyForTests());

  it("does nothing without a sandbox", async () => {
    const out = await practiceInSandbox(task, { ask: async () => result({}), port: undefined });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/sandbox/);
  });

  it("counts a verified run", async () => {
    const out = await practiceInSandbox(task, { ask: async () => result({}), port });
    expect(out.ok).toBe(true);
    expect(studySuccesses()["study-1"]).toBe(1);
  });

  it("reports a miss without counting it", async () => {
    const out = await practiceInSandbox(task, {
      ask: async () => result({ verified: false, note: "script crashed" }),
      port,
    });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/crashed/);
    expect(studySuccesses()["study-1"]).toBeUndefined();
  });
});
