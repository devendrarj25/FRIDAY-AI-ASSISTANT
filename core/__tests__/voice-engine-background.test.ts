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
    const at = mode.indexOf("parseBackgroundRequest(command || text)");
    const block = mode.slice(at, at + 1400);
    expect(block).toContain('this.state.mode === "auto"');
    expect(block).toContain("startVoiceTask(");
    expect(block).toContain("askBrain(background.request");
    expect(block).toContain("brain.stop()");
    expect(at).toBeLessThan(mode.indexOf("if (this.isStopHeard(text, wake.matched))"));
  });

  it("leaves the answer to a quick agreement after being cut off to the interruption hold, not to a second path", () => {
    expect(mode).toContain("settleInterruption(");
    expect(mode).not.toContain("interruptedAt");
  });
});
