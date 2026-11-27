/**
 * The instant acknowledgement plays on the shared sample player, so its samples reach the echo reference tap
 * (`echoLive`): the microphone is cleaned against the ack the same way it is against the reply. Fake audio devices only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, preferences } from "../../src/lib/friday/preferences";
import { echoLive } from "../../src/lib/friday/voice-engine/echo-live";
import { playAckSamples, stopAckClip } from "../../src/lib/friday/voice-engine/ack-player";
import * as lib from "../../src/lib/friday/voice-library";

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect() {}
  start() {}
  stop() {}
}
class FakeContext {
  static made: FakeContext[] = [];
  currentTime = 0;
  sampleRate = 48_000;
  state = "running";
  destination = {};
  constructor() {
    FakeContext.made.push(this);
  }
  createBuffer() {
    return { copyToChannel: () => {} };
  }
  createBufferSource() {
    return new FakeSource();
  }
  resume() {
    return Promise.resolve();
  }
}

const g = globalThis as unknown as { window?: unknown };
const saved = g.window;

beforeEach(() => {
  FakeContext.made = [];
  lib.resetPcmPlayback();
  preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, echoReference: true } });
  g.window = { AudioContext: FakeContext };
});
afterEach(() => {
  stopAckClip();
  lib.resetPcmPlayback();
  g.window = saved;
  preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
});

describe("the acknowledgement on the echo reference", () => {
  it("the ack samples reach the echo reference and use the one shared audio context", async () => {
    const started = new Promise<void>((resolve) => {
      void playAckSamples(new Int16Array(2400).fill(4000), 24_000, { onStart: resolve });
    });
    await started;
    const d = echoLive.diagnostics();
    expect(d.attached).toBe(true);
    expect(d.reference?.chunks ?? 0).toBeGreaterThan(0);
    expect(FakeContext.made).toHaveLength(1);
  });

  it("the ack player makes no audio context of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/friday/voice-engine/ack-player.ts", "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(src).not.toMatch(/new Ctor\(|AudioContext/);
  });
});
