/**
 * The tray pause, Stop everything and Mute each close the microphone: the capture track is stopped, not only the
 * recogniser. Driven with a fake getUserMedia that counts live tracks, so no device is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const g = globalThis as unknown as Record<string, unknown>;
g["window"] ??= globalThis;
g["requestAnimationFrame"] = () => 1;
g["cancelAnimationFrame"] = () => undefined;

type Track = { readyState: string; stop(): void; addEventListener(): void; getSettings(): object };
const tracks: Track[] = [];
const mkTrack = (): Track => {
  const t: Track = {
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
    addEventListener() {},
    getSettings: () => ({ sampleRate: 48000 }),
  };
  tracks.push(t);
  return t;
};
Object.defineProperty(globalThis.navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: async () => {
      const t = mkTrack();
      return { getAudioTracks: () => [t], getTracks: () => [t] };
    },
    addEventListener() {},
    removeEventListener() {},
    enumerateDevices: async () => [],
  },
});
class Ctx {
  state = "running";
  sampleRate = 48000;
  baseLatency = 0;
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return {
      fftSize: 1024,
      smoothingTimeConstant: 0,
      connect() {},
      disconnect() {},
      getFloatTimeDomainData() {},
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
g["AudioContext"] = Ctx;
(g["window"] as Record<string, unknown>)["AudioContext"] = Ctx;

import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import { voiceGate } from "../../src/lib/friday/voice-audio";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    paused: boolean;
    muted: boolean;
    micReady: boolean;
  };
  arbiter: SpeechArbiter;
  autoMicDeferred: boolean;
  setPaused: (paused: boolean) => void;
  setMuted: (muted: boolean) => void;
  cancelSpeech: () => void;
  stopRecognition: () => void;
  startRecognition: () => void;
  openAutoMic: () => void;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
const realStop = d.stopRecognition;
const realStart = d.startRecognition;
const realOpen = d.openAutoMic;
let opens = 0;

beforeEach(async () => {
  await preferences.hydrate();
  preferences.setVoice({ hinglish: false, speechLang: "en-US" });
  autonomy.reset();
  tracks.length = 0;
  opens = 0;
  Object.assign(d.state, { mode: "auto", paused: false, muted: false, micReady: true });
  d.autoMicDeferred = false;
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  d.cancelSpeech = () => undefined;
  d.stopRecognition = () => undefined;
  d.startRecognition = () => undefined;
  d.openAutoMic = () => void (opens += 1);
  d.emit = () => undefined;
  vi.spyOn(brain, "stop").mockImplementation(() => undefined);
  expect(await voiceGate.acquire("auto-mode")).toBe(true);
  expect(voiceGate.liveTracks()).toBe(1);
});

afterEach(() => {
  autonomy.resume();
  autonomy.reset();
  voiceGate.release("auto-mode");
  voiceGate.stop();
  d.stopRecognition = realStop;
  d.startRecognition = realStart;
  d.openAutoMic = realOpen;
  vi.restoreAllMocks();
});

describe("the capture track is closed, not only the recogniser", () => {
  it("the tray pause leaves no live track, and Resume reopens through the deferred open", () => {
    d.setPaused(true);
    expect(voiceGate.liveTracks()).toBe(0);
    expect(d.state.micReady).toBe(false);
    expect(d.autoMicDeferred).toBe(true);
    d.setPaused(false);
    expect(opens).toBe(1);
    expect(d.autoMicDeferred).toBe(false);
  });

  it("Stop everything leaves no live track", () => {
    autonomy.stopEverything();
    expect(d.state.paused).toBe(true);
    expect(voiceGate.liveTracks()).toBe(0);
    expect(d.autoMicDeferred).toBe(true);
  });

  it("Mute leaves no live track", () => {
    d.setMuted(true);
    expect(voiceGate.liveTracks()).toBe(0);
  });

  it("Manual and Chat never owned the microphone: pausing there releases nothing", () => {
    d.state.mode = "manual";
    d.setPaused(true);
    expect(voiceGate.liveTracks()).toBe(1);
    expect(d.autoMicDeferred).toBe(false);
  });
});
