import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { trackProcessingRows } from "../../src/lib/friday/voice-audio";

const asked = { echoCancellation: true, noiseSuppression: true, autoGainControl: false };

describe("live track processing rows", () => {
  it("say 'no live microphone' for every row when there is no track", () => {
    const rows = trackProcessingRows(null, asked);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.value).toContain("no live microphone");
      expect(row.bad).toBeUndefined();
    }
  });

  it("show asked next to live, mark a dropped flag bad, and say 'not reported' for null", () => {
    const rows = trackProcessingRows(
      { echoCancellation: false, noiseSuppression: null, autoGainControl: false },
      asked,
    );
    expect(rows[0]?.value).toBe("on · live off");
    expect(rows[0]?.bad).toBe(true);
    expect(rows[1]?.value).toBe("on · live not reported");
    expect(rows[1]?.bad).toBeUndefined();
    expect(rows[2]?.value).toBe("off · live off");
    expect(rows[2]?.bad).toBeUndefined();
  });
});

describe("VoiceDiagnostics wiring", () => {
  const ui = readFileSync("src/components/friday/VoiceDiagnostics.tsx", "utf8");
  it("merges the gate's track rows right after the echo reference rows", () => {
    const echo = ui.indexOf("...echoReferenceRows(echoDiagnostics()),");
    const track = ui.indexOf("...voiceGate.trackProcessingRows(),");
    expect(echo).toBeGreaterThan(-1);
    expect(track).toBe(echo + "...echoReferenceRows(echoDiagnostics()),".length + 5);
  });
});
