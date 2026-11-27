import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Windows microphone states: Bluetooth call profile, mic held by another app, Windows privacy switch off (with
 * Retry), and a track that ended or a device change reacquired with a backoff. Fake devices and fake timers only;
 * what a real headset, driver or Windows setting does is unverified until the owner's PC shows it.
 */
const g = globalThis as unknown as Record<string, unknown>;
g["window"] ??= globalThis;
g["requestAnimationFrame"] = () => 1;
g["cancelAnimationFrame"] = () => undefined;

type Tr = {
  stopped: boolean;
  readyState: string;
  label: string;
  stop(): void;
  addEventListener(name: string, fn: () => void): void;
  getSettings(): object;
};
const tracks: Tr[] = [];
const ended: Array<() => void> = [];
const changes: Array<() => void> = [];
let label = "Microphone Array";
let rate = 48000;
let down: string | null = null;
const gum = vi.fn(async () => {
  if (down) throw Object.assign(new Error(down), { name: down });
  const t: Tr = {
    stopped: false,
    readyState: "live",
    label,
    stop() {
      this.stopped = true;
      this.readyState = "ended";
    },
    addEventListener(name, fn) {
      if (name === "ended") ended.push(fn);
    },
    getSettings: () => ({ sampleRate: rate }),
  };
  tracks.push(t);
  return { getAudioTracks: () => [t], getTracks: () => [t] };
});
Object.defineProperty(globalThis.navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: gum,
    addEventListener: (_: string, fn: () => void) => changes.push(fn),
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

import {
  MIC_PRIVACY_LINK,
  accessFault,
  bluetoothHandsFree,
  bluetoothNotice,
  busyFault,
  faultView,
  reacquireDelay,
} from "../../src/lib/friday/mic-faults";
import { VoiceGate } from "../../src/lib/friday/voice-audio";

const live = () => tracks.filter((t) => !t.stopped).length;
const reset = () => {
  tracks.length = 0;
  ended.length = 0;
  changes.length = 0;
  label = "Microphone Array";
  rate = 48000;
  down = null;
  gum.mockClear();
};
afterEach(() => {
  vi.useRealTimers();
  reset();
});

describe("Bluetooth call profile", () => {
  it("recognises a Bluetooth or Hands-Free label and a thin headset, never a wired or built-in one", () => {
    expect(bluetoothHandsFree("Headset (Hands-Free AG Audio)")).toBe(true);
    expect(bluetoothHandsFree("Headset Microphone (Bluetooth)")).toBe(true);
    expect(bluetoothHandsFree("AirPods Pro")).toBe(true);
    expect(bluetoothHandsFree("Headset Earphone", 16000)).toBe(true);
    expect(bluetoothHandsFree("Headset Earphone", 48000)).toBe(false);
    expect(bluetoothHandsFree("Microphone Array (Realtek)", 16000)).toBe(false);
    expect(bluetoothHandsFree("USB Headset", 16000)).toBe(false);
    expect(bluetoothHandsFree("")).toBe(false);
  });

  it("the notice is empty for a normal microphone and plain for a Bluetooth one", () => {
    expect(bluetoothNotice("Microphone Array")).toBe("");
    expect(bluetoothNotice("Headset (Hands-Free AG Audio)")).toMatch(/Bluetooth/);
  });

  it("the gate warns once per headset, clears it on stop and warns again for a new open", async () => {
    reset();
    label = "Headset (Hands-Free AG Audio)";
    const gate = new VoiceGate();
    expect(await gate.acquire("auto", null)).toBe(true);
    expect(gate.bluetoothNotice()).toMatch(/Bluetooth/);
    await gate.restart(null);
    expect(gate.recentErrors().filter((e) => /Bluetooth/.test(e))).toHaveLength(1);
    gate.release("auto");
    expect(gate.bluetoothNotice()).toBe("");
    expect(live()).toBe(0);
  });

  it("a built-in microphone raises no warning", async () => {
    reset();
    const gate = new VoiceGate();
    await gate.acquire("auto", null);
    expect(gate.bluetoothNotice()).toBe("");
    gate.release("auto");
  });
});

describe("faults the owner can fix", () => {
  it("Windows privacy denied or restricted is a fault with Retry and the Settings link", () => {
    for (const status of ["denied", "restricted"]) {
      const f = accessFault(status);
      expect(f?.state).toBe("permission-denied");
      expect(f?.retry).toBe(true);
      expect(f?.settingsLink).toBe(MIC_PRIVACY_LINK);
    }
    expect(accessFault("not-determined")?.state).toBe("permission-required");
    expect(accessFault("granted")).toBeNull();
    expect(accessFault("unknown")).toBeNull();
    expect(accessFault(null)).toBeNull();
    expect(MIC_PRIVACY_LINK).toBe("ms-settings:privacy-microphone");
  });

  it("a mic held by another app says so, names it, and offers Retry", () => {
    expect(busyFault("Zoom").line).toMatch(/Zoom/);
    expect(busyFault().line).toMatch(/Another app/);
    expect(busyFault().retry).toBe(true);
    expect(busyFault().state).toBe("device-offline");
  });

  it("the gate's own failures become views: permission carries the link, a busy open carries Retry only", async () => {
    reset();
    down = "NotAllowedError";
    const denied = new VoiceGate();
    expect(await denied.start(null)).toBe(false);
    const dv = faultView(denied.lastCaptureFailure());
    expect(dv?.state).toBe("permission-denied");
    expect(dv?.settingsLink).toBe(MIC_PRIVACY_LINK);
    expect(dv?.retry).toBe(true);

    reset();
    down = "NotReadableError";
    const busy = new VoiceGate();
    expect(await busy.start(null)).toBe(false);
    const bv = faultView(busy.lastCaptureFailure());
    expect(bv?.state).toBe("device-offline");
    expect(bv?.retry).toBe(true);
    expect(bv?.settingsLink).toBeUndefined();
    expect(live()).toBe(0);
    expect(faultView(null)).toBeNull();
  });

  it("Retry after the Windows switch is turned on opens the microphone", async () => {
    reset();
    down = "NotAllowedError";
    const gate = new VoiceGate();
    expect(await gate.start(null)).toBe(false);
    down = null;
    expect(await gate.start(null)).toBe(true);
    expect(live()).toBe(1);
    expect(gate.lastCaptureFailure()).toBeNull();
    gate.stop(true);
  });
});

describe("ended track and device change reacquire", () => {
  it("the backoff doubles from one second and stops growing at eight", () => {
    expect([0, 1, 2, 3, 4, 9].map(reacquireDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(reacquireDelay(-3)).toBe(1000);
    expect(reacquireDelay(Number.NaN)).toBe(1000);
  });

  it("an unplugged microphone is retried on the backoff and the holder is kept until it returns", async () => {
    reset();
    vi.useFakeTimers();
    const gate = new VoiceGate();
    expect(await gate.acquire("auto", null)).toBe(true);
    expect(gum).toHaveBeenCalledTimes(1);

    down = "NotFoundError";
    tracks[0]!.stop();
    ended[0]!();
    await vi.advanceTimersByTimeAsync(0);
    const afterFirst = gum.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(1);
    expect(live()).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(gum.mock.calls.length).toBe(afterFirst);
    await vi.advanceTimersByTimeAsync(600);
    const afterSecond = gum.mock.calls.length;
    expect(afterSecond).toBeGreaterThan(afterFirst);

    down = null;
    await vi.advanceTimersByTimeAsync(2100);
    expect(live()).toBe(1);
    expect(gate.liveTracks()).toBe(1);
    gate.release("auto");
    expect(live()).toBe(0);
  });

  it("a device change with no live stream reacquires; one with a live stream does not open a second", async () => {
    reset();
    vi.useFakeTimers();
    const gate = new VoiceGate();
    await gate.acquire("auto", null);
    changes.forEach((fn) => fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(live()).toBe(1);
    gate.release("auto");
  });

  it("when the last holder lets go during the backoff, no reopen follows", async () => {
    reset();
    vi.useFakeTimers();
    const gate = new VoiceGate();
    await gate.acquire("auto", null);
    down = "NotFoundError";
    tracks[0]!.stop();
    ended[0]!();
    await vi.advanceTimersByTimeAsync(0);
    gate.release("auto");
    const calls = gum.mock.calls.length;
    down = null;
    await vi.advanceTimersByTimeAsync(20000);
    expect(gum.mock.calls.length).toBe(calls);
    expect(live()).toBe(0);
  });
});
