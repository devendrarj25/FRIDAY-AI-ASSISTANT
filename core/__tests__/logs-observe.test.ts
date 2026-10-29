import { describe, expect, it } from "vitest";

import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { logsLookRequested, shouldAttachLogsExtra } from "../../src/lib/friday/brain/logs-observe";
import {
  publishLogsSession,
  formatLogsExtra,
  resetLogsSession,
} from "../../src/lib/friday/logs-awareness";
import { summarizeLogErrors, filterLogLines, type LogLine } from "../../src/lib/friday/log-stream";

describe("read-only logs observation", () => {
  it("matches look-at-logs asks", () => {
    expect(logsLookRequested("find the errors in the logs")).toBe(true);
    expect(logsLookRequested("what is in the logs")).toBe(true);
    expect(shouldAttachLogsExtra("explain the logs")).toBe(true);
    expect(shouldAttachLogsExtra("run npm test in the sandbox")).toBe(false);
  });

  it("answers a logs look from the live ring without inventing lines", () => {
    resetLogsSession();
    publishLogsSession({
      desktop: true,
      file: "/tmp/friday/logs/main.log",
      follow: true,
      lines: [
        {
          id: "1",
          at: "12:00:00.000",
          level: "error",
          source: "kernel",
          message: "traceback: boom",
        },
      ],
    });
    const reply = baselineRespond("find the errors in the logs");
    expect(reply.handled).toBe(true);
    expect(reply.resolve).toBeTypeOf("function");
    return expect(reply.resolve?.()).resolves.toMatch(/traceback: boom/);
  });
});

describe("log buffer helpers", () => {
  const lines: LogLine[] = [
    { id: "1", at: "a", level: "info", source: "main", message: "ok" },
    { id: "2", at: "b", level: "error", source: "kernel", message: "failure" },
  ];

  it("only reports real error lines", () => {
    expect(summarizeLogErrors(lines)).toMatch(/failure/);
    expect(summarizeLogErrors([lines[0]!])).toBe("");
  });

  it("filters by level and source", () => {
    expect(filterLogLines(lines, { level: "error", source: "all" })).toHaveLength(1);
    expect(filterLogLines(lines, { source: "main" }).map((row) => row.id)).toEqual(["1"]);
  });

  it("formats the shared extra from the live session", () => {
    resetLogsSession();
    publishLogsSession({
      file: "main.log",
      lines: [lines[1]!],
    });
    expect(formatLogsExtra()).toMatch(/LOGS SESSION/);
    expect(formatLogsExtra()).toMatch(/failure/);
  });
});
