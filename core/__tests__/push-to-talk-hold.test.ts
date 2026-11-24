import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRE_ROLL_MS, PcmRing, TARGET_RATE } from "../../src/lib/friday/pcm-capture";
import {
  normalizePttTailMs,
  PTT_GRACE_MS,
  PTT_HOLD_MAX_MS,
  PTT_PRE_ROLL_MS,
  PTT_TAIL_DEFAULT_MS,
  PTT_TAIL_MAX_MS,
  PTT_TAIL_MIN_MS,
  PTT_TAP_MS,
  PTT_TOGGLE_MAX_MS,
  pttActive,
  pttAdmits,
  pttCapturing,
  pttCloseNow,
  pttFocusLost,
  pttHeldForMs,
  pttPhase,
  pttPress,
  pttRelease,
  pttSetAllowed,
  pttTailMs,
  pttTapsIgnored,
  pttToggle,
  resetPtt,
  setPttTailMs,
  subscribePtt,
} from "../../src/lib/friday/push-to-talk";

/** A fake clock: every call passes the time in, nothing reads the real one. */
const T0 = 1_000_000;

describe("push-to-talk hold: release tail and phase", () => {
  beforeEach(() => {
    resetPtt();
    setPttTailMs(undefined);
  });
  afterEach(() => setPttTailMs(undefined));

  it("keeps capturing for the tail after release, then finishes", () => {
    pttPress(T0);
    expect(pttPhase(T0 + 100)).toBe("listening");
    pttRelease(T0 + 2000);
    expect(pttActive(T0 + 2000)).toBe(false);
    expect(pttPhase(T0 + 2000)).toBe("finishing");
    expect(pttCapturing(T0 + 2000 + PTT_TAIL_DEFAULT_MS - 1)).toBe(true);
    expect(pttPhase(T0 + 2000 + PTT_TAIL_DEFAULT_MS)).toBe("idle");
    expect(pttCapturing(T0 + 2000 + PTT_TAIL_DEFAULT_MS)).toBe(false);
  });

  it("bounds the tail to 100..800 ms and falls back to 350 for junk", () => {
    expect(normalizePttTailMs(undefined)).toBe(PTT_TAIL_DEFAULT_MS);
    expect(normalizePttTailMs("900")).toBe(PTT_TAIL_DEFAULT_MS);
    expect(normalizePttTailMs(Number.NaN)).toBe(PTT_TAIL_DEFAULT_MS);
    expect(normalizePttTailMs(5)).toBe(PTT_TAIL_MIN_MS);
    expect(normalizePttTailMs(99_999)).toBe(PTT_TAIL_MAX_MS);
    expect(normalizePttTailMs(500.4)).toBe(500);
    expect(setPttTailMs(800)).toBe(800);
    pttPress(T0);
    pttRelease(T0 + 1000);
    expect(pttCapturing(T0 + 1799)).toBe(true);
    expect(pttCapturing(T0 + 1800)).toBe(false);
  });

  it("never lets the tail drop under the Hindi closing hangover", () => {
    setPttTailMs(100);
    expect(pttTailMs("en")).toBe(100);
    expect(pttTailMs("hi")).toBe(140);
    pttPress(T0);
    pttRelease(T0 + 1000);
    expect(pttCapturing(T0 + 1120, "hi")).toBe(true);
    expect(pttCapturing(T0 + 1120, "en")).toBe(false);
  });

  it("uses the one pre-roll of the capture ring and keeps speech from before the press", () => {
    expect(PTT_PRE_ROLL_MS).toBe(PRE_ROLL_MS);
    expect(PRE_ROLL_MS).toBe(500);
    pttPress(T0);
    expect(pttHeldForMs(T0 + 300)).toBe(300);
    // The owner began to speak 200 ms before the key went down (speech 500 ms ago, key 300 ms ago).
    const ring = new PcmRing();
    const speech = new Float32Array(TARGET_RATE / 100).fill(0.5);
    const nowMono = 10_000;
    for (let ms = 0; ms < 1000; ms += 10) {
      ring.push(ms >= 500 ? speech : new Float32Array(speech.length), nowMono - 1000 + ms);
    }
    const loud = (samples: Float32Array) => samples.filter((value) => value > 0.4).length;
    const withPreRoll = ring.takeSince(nowMono - (pttHeldForMs(T0 + 300) + PTT_PRE_ROLL_MS));
    const fromPress = ring.takeSince(nowMono - pttHeldForMs(T0 + 300));
    expect(loud(withPreRoll)).toBeGreaterThanOrEqual(loud(fromPress) + TARGET_RATE * 0.19);
  });

  it("surfaces the phase to subscribers when it changes", () => {
    let calls = 0;
    const off = subscribePtt(() => (calls += 1));
    pttPress(T0);
    pttRelease(T0 + 1000);
    off();
    expect(calls).toBe(2);
  });
});

describe("push-to-talk hold: taps, key repeat, focus loss, stuck keys", () => {
  beforeEach(() => resetPtt());

  it("ignores a tap under 250 ms: no tail, no grace, nothing transcribed", () => {
    pttPress(T0);
    pttRelease(T0 + PTT_TAP_MS - 1);
    expect(pttActive(T0 + PTT_TAP_MS)).toBe(false);
    expect(pttCapturing(T0 + PTT_TAP_MS)).toBe(false);
    expect(pttPhase(T0 + PTT_TAP_MS)).toBe("idle");
    expect(pttAdmits("push-to-talk", T0 + PTT_TAP_MS)).toBe(false);
    expect(pttTapsIgnored()).toBe(1);
  });

  it("counts a press of exactly 250 ms as a real hold", () => {
    pttPress(T0);
    pttRelease(T0 + PTT_TAP_MS);
    expect(pttPhase(T0 + PTT_TAP_MS)).toBe("finishing");
    expect(pttAdmits("push-to-talk", T0 + PTT_TAP_MS + PTT_GRACE_MS)).toBe(true);
    expect(pttTapsIgnored()).toBe(0);
  });

  it("key repeat does not restart the hold or the tap clock", () => {
    pttPress(T0);
    for (let step = 1; step <= 20; step += 1) pttPress(T0 + step * 30);
    expect(pttHeldForMs(T0 + 600)).toBe(600);
    pttRelease(T0 + 600);
    expect(pttPhase(T0 + 600)).toBe("finishing");
  });

  it("focus loss ends the hold safely, and a slip of focus right after the press is a tap", () => {
    pttPress(T0);
    pttFocusLost(T0 + 3000);
    expect(pttActive(T0 + 3000)).toBe(false);
    expect(pttPhase(T0 + 3000)).toBe("finishing");
    resetPtt();
    pttPress(T0);
    pttFocusLost(T0 + 100);
    expect(pttPhase(T0 + 100)).toBe("idle");
    pttFocusLost(T0 + 200);
    expect(pttPhase(T0 + 200)).toBe("idle");
  });

  it("a hold whose key-up never arrived ends by itself", () => {
    pttPress(T0);
    expect(pttActive(T0 + PTT_HOLD_MAX_MS - 1)).toBe(true);
    expect(pttActive(T0 + PTT_HOLD_MAX_MS)).toBe(false);
    expect(pttPhase(T0 + PTT_HOLD_MAX_MS + 10)).toBe("finishing");
    expect(pttPhase(T0 + PTT_HOLD_MAX_MS + PTT_TAIL_DEFAULT_MS)).toBe("idle");
    expect(pttHeldForMs(T0 + PTT_HOLD_MAX_MS + 1)).toBe(0);
  });

  it("toggle keeps its 60 s auto-close, with the tail after it", () => {
    expect(pttToggle(T0)).toBe(true);
    expect(pttPhase(T0 + PTT_TOGGLE_MAX_MS - 1)).toBe("listening");
    expect(pttPhase(T0 + PTT_TOGGLE_MAX_MS)).toBe("finishing");
    expect(pttPhase(T0 + PTT_TOGGLE_MAX_MS + PTT_TAIL_DEFAULT_MS)).toBe("idle");
  });

  it("a toggle closed by hand also finishes through the tail", () => {
    pttToggle(T0);
    expect(pttToggle(T0 + 5000)).toBe(false);
    expect(pttPhase(T0 + 5000)).toBe("finishing");
    expect(pttPhase(T0 + 5000 + PTT_TAIL_DEFAULT_MS)).toBe("idle");
  });
});

describe("push-to-talk hold: Auto only, kill switches", () => {
  beforeEach(() => resetPtt());

  it("pttCloseNow ends a hold with no tail and no grace", () => {
    pttPress(T0);
    pttCloseNow();
    expect(pttActive(T0 + 1)).toBe(false);
    expect(pttCapturing(T0 + 1)).toBe(false);
    expect(pttAdmits("push-to-talk", T0 + 1)).toBe(false);
  });

  it("pttCloseNow ends a toggle and a tail that is already running", () => {
    pttToggle(T0);
    pttCloseNow();
    expect(pttPhase(T0 + 10)).toBe("idle");
    pttPress(T0 + 20);
    pttRelease(T0 + 2000);
    expect(pttPhase(T0 + 2100)).toBe("finishing");
    pttCloseNow();
    expect(pttPhase(T0 + 2100)).toBe("idle");
    expect(pttAdmits("push-to-talk", T0 + 2100)).toBe(false);
  });

  it("while Auto may not listen (mute, pause, stop) a press or toggle opens nothing", () => {
    pttSetAllowed(false);
    pttPress(T0);
    expect(pttActive(T0 + 1)).toBe(false);
    expect(pttToggle(T0)).toBe(false);
    expect(pttPhase(T0 + 1)).toBe("idle");
    pttSetAllowed(true);
    pttPress(T0 + 10);
    expect(pttActive(T0 + 11)).toBe(true);
  });

  it("losing permission mid-hold closes the hold at once, tail included", () => {
    pttPress(T0);
    pttSetAllowed(false);
    expect(pttPhase(T0 + 500)).toBe("idle");
    pttRelease(T0 + 600);
    expect(pttPhase(T0 + 600)).toBe("idle");
    expect(pttAdmits("push-to-talk", T0 + 700)).toBe(false);
  });

  it("keeps always-listening untouched: it admits everything and the gate is irrelevant", () => {
    pttSetAllowed(false);
    expect(pttAdmits("always", T0)).toBe(true);
  });
});
