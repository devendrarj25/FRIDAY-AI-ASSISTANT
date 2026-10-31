import { describe, expect, it } from "vitest";
import {
  earlyClause,
  realtimeSilenceMs,
  realtimeStatus,
  type RealtimeInput,
} from "../../src/lib/friday/voice-realtime";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

const base: RealtimeInput = {
  enabled: true,
  surface: "auto",
  paused: false,
  gpuVramGb: 0,
  s2sRuntimeInstalled: false,
  paidAccess: false,
  cloudKey: false,
  privacyMode: true,
};

describe("realtime voice experiment", () => {
  it("is off by default in a fresh install", () => {
    expect(DEFAULT_PREFERENCES.voice.realtimeExperiment).toBe(false);
    expect(realtimeStatus({ ...base, enabled: false }).active).toBe(false);
  });

  it("never opens in Chat or Manual, nor while listening is paused", () => {
    expect(realtimeStatus({ ...base, surface: "manual" }).active).toBe(false);
    expect(realtimeStatus({ ...base, paused: true }).active).toBe(false);
    expect(realtimeStatus({ ...base, surface: "manual" }).reasons.join(" ")).toMatch(/Auto mode/);
  });

  it("runs the pipeline overlap and says why the other engines are unavailable", () => {
    const status = realtimeStatus(base);
    expect(status.active).toBe(true);
    expect(status.engine).toBe("pipeline-overlap");
    const why = Object.fromEntries(status.unavailable.map((row) => [row.engine, row.why]));
    expect(why["local-speech-to-speech"]).toMatch(/runtime/);
    expect(why["cloud-realtime"]).toMatch(/paid access/);
  });

  it("keeps the cloud engine unavailable while speech must stay on this PC", () => {
    const status = realtimeStatus({ ...base, paidAccess: true, cloudKey: true });
    expect(status.unavailable.find((row) => row.engine === "cloud-realtime")?.why).toMatch(
      /stays here/,
    );
    const open = realtimeStatus({ ...base, paidAccess: true, cloudKey: true, privacyMode: false });
    expect(open.unavailable.some((row) => row.engine === "cloud-realtime")).toBe(false);
    expect(open.engine).toBe("pipeline-overlap");
  });

  it("shortens only an open conversation's pause, with a floor", () => {
    expect(realtimeSilenceMs(420, true, true, false)).toBe(294);
    expect(realtimeSilenceMs(300, true, true, false)).toBe(280);
    expect(realtimeSilenceMs(700, true, false, false)).toBe(700);
    expect(realtimeSilenceMs(1200, true, true, true)).toBe(1200);
    expect(realtimeSilenceMs(420, false, true, false)).toBe(420);
  });

  it("speaks the first phrase at a clause break once it is long enough", () => {
    const text = "Sure, here is what I found about your request, and then some more detail follows";
    const out = earlyClause(text);
    expect(out.spoken).toBe("Sure, here is what I found about your request,");
    expect(out.consumed).toBeGreaterThan(out.spoken.length - 1);
    expect(earlyClause("Short, yes. And more").spoken).toBe("");
    expect(earlyClause("no break at all in this long line of words that keeps going").spoken).toBe(
      "",
    );
  });
});
