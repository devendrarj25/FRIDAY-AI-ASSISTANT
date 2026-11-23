import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  earlyStartRows,
  echoReferenceRows,
  stampedFigure,
} from "../../src/lib/friday/voice-diagnostics-rows";
import type { EchoLiveDiagnostics } from "../../src/lib/friday/voice-engine/echo-live";
import { LatencyMonitor } from "../../src/lib/friday/voice-engine/latency-monitor";

const base: EchoLiveDiagnostics = {
  enabled: true,
  attached: true,
  cancelledFrames: 12,
  passedFrames: 3,
  errors: 0,
  clears: 0,
  lastClear: "",
  reductionDb: null,
  delayMs: null,
  shadowReady: null,
  shadowReason: "waiting for playback",
  shadowSent: 0,
  reference: null,
  canceller: null,
};

describe("echo reference rows", () => {
  it("are hidden when the reference is off", () => {
    expect(echoReferenceRows({ ...base, enabled: false })).toEqual([]);
  });

  it("say 'no measurement yet' for a null reduction and delay, never a number", () => {
    const rows = echoReferenceRows(base);
    expect(rows.find((r) => r.label.includes("reduction"))?.value).toBe("no measurement yet");
    expect(rows.find((r) => r.label.includes("delay"))?.value).toBe("no measurement yet");
  });

  it("show the measured values, frame counts, shadow reason and the honest scope note", () => {
    const rows = echoReferenceRows({ ...base, reductionDb: 14.26, delayMs: 87.4 });
    const text = rows.map((r) => `${r.label}: ${r.value}`).join("\n");
    expect(text).toContain("14.3 dB");
    expect(text).toContain("87 ms");
    expect(text).toContain("12 cancelled · 3 passed");
    expect(text).toContain("waiting for playback");
    expect(text).toContain("voice.pcmPlayback");
    expect(text).toContain("unverified on the owner's PC");
  });
});

describe("instant acknowledgement and early start rows", () => {
  it("read 'not used yet' until the gap was really stamped", () => {
    const monitor = new LatencyMonitor();
    const rows = earlyStartRows({ instantAck: true, eagerTurn: false }, monitor);
    expect(rows[0]?.value).toBe("on · not used yet");
    expect(rows[1]?.value).toBe("off · not used yet");
    expect(rows[2]?.value).toBe("off");
  });

  it("show the real figure once a turn recorded it", () => {
    const monitor = new LatencyMonitor();
    monitor.record("ackArmedToAudible", 140);
    expect(stampedFigure("ackArmedToAudible", monitor)).toContain("140 ms");
    expect(earlyStartRows({ instantAck: true }, monitor)[0]?.value).toContain("140 ms");
  });
});

describe("VoiceDiagnostics wiring", () => {
  const ui = readFileSync("src/components/friday/VoiceDiagnostics.tsx", "utf8");
  it("renders the echo, acknowledgement and early start rows from live sources", () => {
    expect(ui).toContain("echoReferenceRows(echoDiagnostics())");
    expect(ui).toContain("earlyStartRows(preferences.getSnapshot().voice)");
    expect(ui).toContain("voice-engine/echo-live");
  });
  it("keeps the prewarm timings and the Doctor warnings rows", () => {
    expect(ui).toContain("voiceBudgetLine()");
    expect(ui).toContain("unstampedStagesLine()");
    expect(ui).toContain("voiceDoctorMarks()");
  });
});
