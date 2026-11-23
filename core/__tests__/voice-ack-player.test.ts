import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { playAckSamples, stopAckClip } from "../../src/lib/friday/voice-engine/ack-player";

const g = globalThis as unknown as { window?: unknown };
const saved = g.window;
afterEach(() => {
  g.window = saved;
});

describe("the acknowledgement player (local samples only)", () => {
  it("plays nothing and says so when there is no audio context (a browser preview, a test)", async () => {
    g.window = {};
    const onStart = vi.fn();
    expect(await playAckSamples(new Int16Array(100).fill(500), 24_000, { onStart })).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("an audio context that will not start plays nothing and never throws", async () => {
    class Stuck {
      sampleRate = 48_000;
      state = "closed";
      currentTime = 0;
    }
    g.window = { AudioContext: Stuck };
    const onStart = vi.fn();
    expect(await playAckSamples(new Int16Array(100).fill(500), 24_000, { onStart })).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("stopping with nothing playing is safe", () => {
    expect(() => stopAckClip()).not.toThrow();
  });

  it("is local only: no bridge, no network, no cloud voice, no voice engine call", () => {
    const source = readFileSync("src/lib/friday/voice-engine/ack-player.ts", "utf8");
    expect(source.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(
      /fetch\(|desktopApi|speakNeural|cloudClip|XMLHttpRequest|WebSocket/,
    );
  });
});
