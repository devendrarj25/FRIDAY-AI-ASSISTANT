import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseBackgroundRequest,
  completionLine,
} from "../../src/lib/friday/voice-engine/background-request";

describe("background request", () => {
  it.each([
    [
      "Friday, meri Excel report analyze karo aur jab tak tum kaam kar rahi ho, main tumse doosre questions bhi poochunga",
      "meri Excel report analyze karo",
    ],
    ["summarise this report in the background", "summarise this report"],
    [
      "Excel report ka summary bana do background mein kaam karo",
      "Excel report ka summary bana do",
    ],
    ["check my downloads folder while you're working on that", "check my downloads folder"],
  ])("%s", (heard, request) => {
    const out = parseBackgroundRequest(heard.replace(/^Friday,\s*/i, ""));
    expect(out).not.toBeNull();
    expect(out?.request.toLowerCase()).toContain(
      request.toLowerCase().split(" ").slice(0, 2).join(" "),
    );
    expect(out?.request).not.toMatch(/in the background|jab tak|background/i);
  });

  it("leaves ordinary sentences alone, even with the word background", () => {
    for (const heard of [
      "change the background colour to blue",
      "desktop background badal do",
      "aaj ka weather batao",
      "in the background",
      "background task",
      "open the report",
    ]) {
      expect(parseBackgroundRequest(heard)).toBeNull();
    }
  });

  it("makes a short label and a first-sentence summary", () => {
    expect(
      parseBackgroundRequest("summarise the long quarterly sales report in the background")?.label
        .length,
    ).toBeLessThanOrEqual(80);
    expect(completionLine("Three sheets were read. The totals match. Done.")).toBe(
      "Three sheets were read.",
    );
    expect(completionLine("")).toBe("");
    expect(completionLine("x".repeat(400)).length).toBeLessThanOrEqual(200);
  });
});

describe("background request wiring", () => {
  const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");

  it("runs the real Brain turn as a voice task, only in Auto mode, and cancels the turn with the task", () => {
    const at = mode.indexOf("const background =");
    expect(at).toBeGreaterThan(0);
    const block = mode.slice(at, at + 1400);
    expect(block).toContain('this.state.mode === "auto"');
    // A consequential background order is asked about first; a confirmed one starts the same task.
    expect(block).toContain("this.askToConfirm(ordered)");
    expect(block).toMatch(
      /const ordered = route\.supersedes\s*\?\s*withoutChangeOfMind\(command \|\| text\)\s*:\s*command \|\| text;/,
    );
    // A change of mind cancels the old task only after the yes (inside runApproved), never before the question.
    expect(block.indexOf("this.askToConfirm(ordered)")).toBeLessThan(
      block.indexOf("voiceTaskActions.cancel(route.supersedes)"),
    );
    expect(mode).toMatch(
      /runApproved\(command: string, hints\?: TurnHints\) \{[\s\S]*?voiceTaskActions\.cancel\(sup\.id\)[\s\S]*?this\.replayWith\(heardWith[\s\S]*?this\.beginBackground\(background\)/,
    );
    expect(block).toContain("this.beginBackground(background)");
    expect(mode).toMatch(
      /runApproved\(command: string, hints\?: TurnHints\) \{[\s\S]*?this\.beginBackground\(background\)/,
    );
    const start = mode.indexOf("private beginBackground(");
    const method = mode.slice(start, start + 600);
    expect(method).toContain("startVoiceTask(");
    expect(method).toContain("this.backgroundWork(background.request)");
    // The work is the real Brain turn, and it is the same work a task redone after a restart runs.
    const work = mode.slice(mode.indexOf("backgroundWork(request: string)"));
    const body = work.slice(0, 700);
    expect(body).toContain("askBrain(request");
    expect(body).toContain("brain.stop({ taskId: task.id })");
    expect(mode).toContain(
      "attachVoiceTaskWork((request) => assistantMode.backgroundWork(request))",
    );
    expect(at).toBeLessThan(mode.indexOf("if (this.isStopHeard(text, wake.matched))"));
  });

  it("leaves the answer to a quick agreement after being cut off to the interruption hold, not to a second path", () => {
    expect(mode).toContain("settleInterruption(");
    expect(mode).not.toContain("interruptedAt");
  });
});
