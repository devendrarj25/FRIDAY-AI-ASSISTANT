/**
 * "Reset voice defaults" in Settings > Voice must not switch hands-free on: hands-free starts off, so the reset puts the
 * wake word back and saves that choice (the safety rule: hands-free initialises false).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const source = readFileSync(
  resolve(root, "src/components/friday/settings/VoiceSettings.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

/** The click handler of the reset button: from its `onClick` to the success toast. */
function resetHandler(): string {
  const toast = source.indexOf('toast.success("Voice defaults restored');
  expect(toast).toBeGreaterThan(0);
  const from = source.lastIndexOf("onClick={() => {", toast);
  return source.slice(from, toast);
}

describe("G4-1: Reset voice defaults", () => {
  it("restores the voice preferences and mutes nothing", () => {
    const handler = resetHandler();
    expect(handler).toContain("resetToBestVoice();");
    expect(handler).toContain("assistantMode.setMuted(false);");
    expect(handler).toContain("assistantMode.setPaused(false);");
  });

  it("puts hands-free back to its default, off, and never turns it on", () => {
    const handler = resetHandler();
    expect(handler).toContain("assistantMode.setHandsFree(false);");
    expect(handler).not.toContain("setHandsFree(true)");
  });
});
