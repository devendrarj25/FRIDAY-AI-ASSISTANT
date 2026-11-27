import { describe, expect, it } from "vitest";
import { voiceModeBlock } from "../../src/lib/friday/conversation-style";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import { systemContextPrompt, type SystemContext } from "../../src/lib/friday/system-context";

const CTX: SystemContext = {
  iso: "2026-11-27T09:41:23.456Z",
  date: "27 November 2026",
  time: "09:41:23",
  timeMinute: "09:41",
  weekday: "Friday",
  timeZone: "Asia/Kolkata",
  utcOffset: "UTC+05:30",
  locale: "en-IN",
  online: true,
  platform: "Win32",
};

describe("voice system prompt stays lean", () => {
  it("keeps the clock to the minute and drops the ISO line for voice", () => {
    const lean = systemContextPrompt(CTX, { surface: "voice" });
    expect(lean).not.toMatch(/ISO timestamp|2026-11-27T|:23|\.456/);
    expect(lean).toContain("09:41");
    expect(lean.length).toBeLessThan(systemContextPrompt(CTX).length);
    // The typed-chat block is unchanged.
    expect(systemContextPrompt(CTX)).toContain("ISO timestamp: 2026-11-27T09:41:23.456Z");
  });

  it("builds a short, stable-first voice system prompt for a Hinglish smalltalk turn", async () => {
    const cognition = await coreBrain.cognize("tum kaisi ho", { mode: "auto", surface: "voice" });
    const system = cognition.system;
    // Measured 15,746 chars before the lean branch and 5,065 after; the ceiling is the new size plus about 10%.
    expect(system.length).toBeLessThan(5600);
    expect(system).not.toMatch(/ISO timestamp/);
    expect(system).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect((system.match(/^Note:/gm) ?? []).length).toBeLessThanOrEqual(3);
    // One voice rule, not two overlapping brevity blocks.
    expect((system.match(/AUTO MODE — you are speaking out loud/g) ?? []).length).toBe(1);
    expect(system).toMatch(/speaking out loud/);
    // Stable text first, volatile (clock) later than the persona header.
    expect(system.indexOf("Live system context")).toBeGreaterThan(system.indexOf("You are "));
  });

  it("says the length rule once when the caller already added the voice-mode block", async () => {
    const block = voiceModeBlock({ deliveryTags: true });
    const cognition = await coreBrain.cognize("kal ka mausam batao", {
      mode: "auto",
      surface: "voice",
      extra: block,
    });
    const brevity = cognition.system.match(
      /at most 2 short spoken sentences|then at most one more/g,
    );
    expect(brevity?.length).toBe(1);
    expect(cognition.system).toContain("Voice mode (this reply is spoken).");
    expect(cognition.system).not.toMatch(/This turn was (SPOKEN|TYPED)/);
  });

  it("leaves the typed-chat prompt on the full path", async () => {
    const chat = await coreBrain.cognize("tum kaisi ho", { mode: "manual", surface: "chat" });
    expect(chat.system).toMatch(/ISO timestamp/);
  });
});
