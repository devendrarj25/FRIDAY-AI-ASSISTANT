/**
 * When the speech worker answers without a voice status, the Doctor rows carry the worker's own reason, not a
 * fixed sentence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const status = vi.hoisted(() => ({
  answer: { available: false, reason: "" } as { available: boolean; reason?: string },
}));

vi.mock("../../src/lib/friday/voice-library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/friday/voice-library")>()),
  neuralVoiceStatus: async () => status.answer,
}));

import { doctor } from "../../src/lib/friday/doctor-engine";
import { noteFridayVoiceStatus } from "../../src/lib/friday/voice-doctor";

const voiceRows = () =>
  doctor.getSnapshot().checks.filter((check) => check.id.startsWith("voice:"));

describe("Doctor voice rows carry the worker reason", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    noteFridayVoiceStatus(undefined);
  });

  it("shows the worker's reason when no voice status came", async () => {
    vi.stubGlobal("window", { friday: { isDesktop: true } });
    status.answer = { available: false, reason: "Supertonic is not installed" };
    await doctor.scan();
    const details = voiceRows()
      .map((row) => row.detail)
      .join(" | ");
    expect(details).toContain("Supertonic is not installed");
    expect(details).not.toContain("sent no voice status");
  });

  it("falls back to the fixed line only when the worker gave no reason", async () => {
    vi.stubGlobal("window", { friday: { isDesktop: true } });
    status.answer = { available: false };
    await doctor.scan();
    expect(
      voiceRows()
        .map((row) => row.detail)
        .join(" | "),
    ).toContain("sent no voice status");
  });
});
