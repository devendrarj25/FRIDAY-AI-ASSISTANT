/**
 * A spoken tool result is one short outcome line: the first meaningful error line, no IPC prefix, no stack,
 * known failures in plain words, a count for a list. Typed chat keeps the full text.
 */
import { describe, expect, it } from "vitest";
import { describeToolResult } from "../../src/lib/friday/brain-engine";

const voice = (label: string, result: Record<string, unknown> | null) =>
  describeToolResult(label, result, { voice: true });

describe("describeToolResult on the voice surface", () => {
  it("strips the Electron IPC prefix and keeps the first meaningful error line", () => {
    const line = voice("open the report", {
      ok: false,
      error:
        "Error invoking remote method 'kernel:call': Error: report.docx not found in Documents\n    at Object.invoke (node:internal/x:1:1)\n    at next (node:internal/y:2:2)",
    });
    expect(line).toBe("I couldn't open the report — report.docx not found in Documents.");
    expect(line).not.toMatch(/Error invoking|node:internal|\n/);
  });

  it("maps denied, timeout and kernel-down failures to plain words", () => {
    expect(
      voice("delete the file", { ok: false, error: "EACCES: permission denied, unlink 'C:\\x'" }),
    ).toMatch(/it was denied/);
    expect(voice("scan the disk", { ok: false, error: "tool timed out after 30000 ms" })).toMatch(
      /it took too long/,
    );
    expect(
      voice("list windows", { ok: false, error: "Kernel is not running — start it from Setup." }),
    ).toMatch(/my local tool service is not running/);
    expect(voice("list windows", { ok: false, error: "bridge not connected" })).toMatch(
      /my local tool service is not running/,
    );
  });

  it("says a list as a count and the first few names, on one line", () => {
    const line = voice("list the windows", {
      ok: true,
      windows: ["Mail", "Notes", "Chrome", "Code", "Terminal"],
    });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toMatch(/5/);
    expect(line).toMatch(/Mail, Notes/);
    expect(line).not.toMatch(/Terminal/);
  });

  it("caps a long output to one sentence-sized line", () => {
    const line = voice("run the check", {
      ok: true,
      output: `All good. ${"details ".repeat(200)}`,
    });
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line.split("\n")).toHaveLength(1);
    expect(line.startsWith("Done — run the check")).toBe(true);
  });

  it("answers a missing result in one line", () => {
    expect(voice("do it", null)).toMatch(/^I couldn't do it/);
  });

  it("keeps the full text for typed chat", () => {
    const full = describeToolResult("list the windows", {
      ok: true,
      windows: ["Mail", "Notes", "Chrome", "Code"],
    });
    expect(full).toMatch(/Done — list the windows:\n• Mail\n• Notes\n• Chrome\n• Code/);
    const failed = describeToolResult("open it", {
      ok: false,
      error: "Error invoking remote method 'x': boom",
    });
    expect(failed).toContain("Error invoking remote method");
  });
});
