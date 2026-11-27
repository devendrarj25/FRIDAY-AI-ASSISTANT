/**
 * The "remembered" half of hands-free and the wake match around it, pinned as behaviour on a freshly loaded
 * controller (fake storage, fake desktop bridge, fake clock; no microphone, speaker, model or network):
 *
 *  - turning hands-free off is written as the boolean `false`, and true -> off -> a new controller stays off;
 *  - a refused wake with hands-free off is not a wake, so a line addressed to another assistant is dropped;
 *  - a refused wake with hands-free ON still counts as a wake today (the "Friday," prefix is stripped in
 *    hands-free); that is pinned under its current name so the later wake-guard packet flips it on purpose;
 *  - the follow-up window defaults to 8 s and never exceeds 60 s;
 *  - nothing stored, and a fresh preferences hydrate, keep hands-free off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HANDS_FREE_KEY = "friday.assistant.handsfree";
const g = globalThis as unknown as Record<string, unknown>;

type Log = { stage: string; detail: string };
type Driver = {
  state: {
    handsFree: boolean;
    mode: string;
    paused: boolean;
    micReady: boolean;
    voiceLog: Log[];
  } & Record<string, unknown>;
  wakeWordRequired: boolean;
  setHandsFree: (on: boolean, persist?: boolean) => void;
  handleHeard: (text: string, probe?: unknown) => void;
  followMs: () => number;
  heldForWake: (matched: boolean) => boolean;
};

/** Both copies the app keeps: the browser cache and the durable desktop copy. They outlive a controller. */
type Machine = { cache: Map<string, string>; disk: Map<string, unknown> };
const newMachine = (): Machine => ({ cache: new Map(), disk: new Map() });

/** A freshly loaded controller on top of `machine` (a reload keeps the machine and drops every module). */
async function load(machine: Machine = newMachine()) {
  vi.resetModules();
  g["window"] = globalThis;
  g["localStorage"] = {
    getItem: (key: string) => machine.cache.get(key) ?? null,
    setItem: (key: string, value: string) => void machine.cache.set(key, value),
    removeItem: (key: string) => void machine.cache.delete(key),
  };
  g["addEventListener"] ??= () => undefined;
  g["removeEventListener"] ??= () => undefined;
  g["document"] ??= {
    hidden: false,
    documentElement: { classList: { toggle: () => undefined } },
    addEventListener: () => undefined,
    hasFocus: () => true,
    head: { appendChild: () => undefined },
    getElementsByTagName: () => [{ appendChild: () => undefined }],
    createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined }),
    createTextNode: () => ({}),
  };
  const setStateCalls: Array<[string, unknown]> = [];
  g["friday"] = {
    onVoicePartial: () => () => undefined,
    getState: async (namespace: string) => machine.disk.get(namespace) ?? null,
    setState: async (namespace: string, value: unknown) => {
      setStateCalls.push([namespace, value]);
      machine.disk.set(namespace, value);
    },
  };
  const { assistantMode } = await import("../../src/lib/friday/assistant-mode");
  const { voiceGate } = await import("../../src/lib/friday/voice-audio");
  const { preferences } = await import("../../src/lib/friday/preferences");
  assistantMode.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  return { d: assistantMode as unknown as Driver, voiceGate, preferences, machine, setStateCalls };
}

/** Let the browser-copy write (150 ms) and the desktop write (400 ms) both land. */
const settle = () => vi.advanceTimersByTimeAsync(500);

// The first load of the controller module is cold and can take a few seconds.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe("hands-free is remembered, on and off", () => {
  it("setHandsFree(false) after true writes the boolean false to both copies", async () => {
    const { d, machine, setStateCalls } = await load();
    d.setHandsFree(true);
    d.setHandsFree(false);
    await settle();
    expect(d.state.handsFree).toBe(false);
    expect(d.wakeWordRequired).toBe(true);
    expect(machine.cache.get(HANDS_FREE_KEY)).toBe("false");
    expect(machine.disk.get(HANDS_FREE_KEY)).toBe(false);
    expect(setStateCalls.filter(([key]) => key === HANDS_FREE_KEY).at(-1)).toEqual([
      HANDS_FREE_KEY,
      false,
    ]);
  });

  it("writing false while it is already off still stores an explicit false", async () => {
    const { d, machine } = await load();
    d.setHandsFree(false);
    await settle();
    expect(machine.cache.get(HANDS_FREE_KEY)).toBe("false");
    expect(machine.disk.get(HANDS_FREE_KEY)).toBe(false);
  });

  it("persist=false changes the live state and writes nothing", async () => {
    const { d, machine } = await load();
    d.setHandsFree(true, false);
    await settle();
    expect(d.state.handsFree).toBe(true);
    expect(machine.cache.has(HANDS_FREE_KEY)).toBe(false);
    expect(machine.disk.has(HANDS_FREE_KEY)).toBe(false);
  });

  it("true -> off -> a new controller on the same stores stays off, wake word required", async () => {
    const first = await load();
    first.d.setHandsFree(true);
    await settle();
    expect(first.machine.cache.get(HANDS_FREE_KEY)).toBe("true");
    first.d.setHandsFree(false);
    await settle();

    const second = await load(first.machine);
    expect(second.d).not.toBe(first.d);
    expect(second.d.state.handsFree).toBe(false);
    expect(second.d.wakeWordRequired).toBe(true);
    expect(second.voiceGate.wake.handsFree).toBe(false);
  });

  it("true -> a new controller on the same stores comes back on (the round trip is real)", async () => {
    const first = await load();
    first.d.setHandsFree(true);
    await settle();

    const second = await load(first.machine);
    expect(second.d.state.handsFree).toBe(true);
    expect(second.d.wakeWordRequired).toBe(false);
    expect(second.voiceGate.wake.handsFree).toBe(true);
  });

  it("a stale browser copy of true loses to the desktop copy of false after a reload", async () => {
    const machine = newMachine();
    machine.cache.set(HANDS_FREE_KEY, "true");
    machine.disk.set(HANDS_FREE_KEY, false);
    const { d } = await load(machine);
    expect(d.state.handsFree).toBe(false);
    expect(d.wakeWordRequired).toBe(true);
  });
});

describe("hands-free default with nothing stored", () => {
  it("stays off through a fresh preferences hydrate and writes nothing", async () => {
    const { d, preferences, voiceGate, machine } = await load();
    await preferences.hydrate();
    await settle();
    expect(d.state.handsFree).toBe(false);
    expect(d.wakeWordRequired).toBe(true);
    expect(voiceGate.wake.handsFree).toBe(false);
    expect(machine.cache.has(HANDS_FREE_KEY)).toBe(false);
    expect(machine.disk.has(HANDS_FREE_KEY)).toBe(false);
  });

  it("preferences carry no hands-free field that could switch it on", async () => {
    const { preferences } = await load();
    const snapshot = JSON.stringify(preferences.getSnapshot());
    expect(snapshot).not.toMatch(/hands-?free/i);
  });
});

describe("the follow-up window", () => {
  it("defaults to 8 s and the preference default is 8", async () => {
    const { d, preferences } = await load();
    expect(preferences.getSnapshot().voice.addressWindowSec).toBe(8);
    expect(d.followMs()).toBe(8000);
  });

  it("honours a normal value and clamps a huge one to 60 s", async () => {
    const { d, preferences } = await load();
    preferences.setVoice({ addressWindowSec: 20 });
    expect(d.followMs()).toBe(20_000);
    preferences.setVoice({ addressWindowSec: 60 });
    expect(d.followMs()).toBe(60_000);
    preferences.setVoice({ addressWindowSec: 61 });
    expect(d.followMs()).toBe(60_000);
    preferences.setVoice({ addressWindowSec: 1_000_000 });
    expect(d.followMs()).toBe(60_000);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to 8 s for %s",
    async (value) => {
      const { d, preferences } = await load();
      preferences.setVoice({ addressWindowSec: value });
      expect(d.followMs()).toBe(8000);
    },
  );
});

describe("a refused wake word", () => {
  /** A controller with an open microphone whose wake guard refuses every wake (a fake cooldown). */
  async function refusing(handsFree: boolean) {
    const loaded = await load();
    const { d, voiceGate } = loaded;
    d.state.mode = "auto";
    d.state.paused = false;
    d.state.micReady = true;
    d.setHandsFree(handsFree, false);
    const consider = vi
      .spyOn(voiceGate.wake, "consider")
      .mockReturnValue({ accept: false, reason: "cooldown" } as never);
    // End the turn right after the wake decision: nothing reaches the brain.
    const held: boolean[] = [];
    vi.spyOn(d, "heldForWake").mockImplementation((matched: boolean) => {
      held.push(matched);
      return true;
    });
    return { d, consider, held };
  }

  const HEARD = "Friday hey google what is the weather today";
  const dropped = (d: Driver) =>
    d.state.voiceLog.some(
      (row) => row.stage === "dropped" && row.detail === "addressed to another assistant",
    );

  it("with hands-free off it is not a match: a line for another assistant is dropped", async () => {
    const { d, consider, held } = await refusing(false);
    d.handleHeard(HEARD);
    expect(consider).toHaveBeenCalled();
    expect(
      d.state.voiceLog.some(
        (row) => row.stage === "wake" && row.detail === "wake word not taken (cooldown)",
      ),
    ).toBe(true);
    expect(dropped(d)).toBe(true);
    expect(held).toEqual([]);
  });

  it("with hands-free off and an allowed wake, the same line is a match and is not dropped", async () => {
    const { d, consider, held } = await refusing(false);
    consider.mockReturnValue({ accept: true, reason: "ok" } as never);
    d.handleHeard(HEARD);
    expect(consider).toHaveBeenCalled();
    expect(dropped(d)).toBe(false);
    expect(held).toEqual([true]);
  });

  it("CURRENT BEHAVIOUR (WK-P3 flips this): with hands-free ON a refused wake still counts as matched", async () => {
    const { d, consider, held } = await refusing(true);
    d.handleHeard(HEARD);
    expect(consider).toHaveBeenCalled();
    // The gate refused it, yet the line is not dropped as "another assistant" and the turn carries matched=true.
    expect(dropped(d)).toBe(false);
    expect(held).toEqual([true]);
  });

  it("a line with no wake word is never judged by the guard at all", async () => {
    const { d, consider } = await refusing(false);
    d.handleHeard("what is the weather today in Jaipur");
    expect(consider).not.toHaveBeenCalled();
  });
});
