/**
 * Three lifecycle guards of the Auto-mode conductor, each pinned by a behaviour test on a freshly loaded controller
 * (fake storage, fake desktop bridge, fake clock; no microphone, speaker, model or network):
 *
 *  - hands-free starts OFF and turns on only when the owner's stored choice says so (a fresh install keeps the wake
 *    word required, also after Auto mode starts);
 *  - a second identical microphone fault is acted on again once the microphone recovered or the first report is old,
 *    while a burst of the same message inside that window still heals once;
 *  - there is exactly one provisional-transcript handler and it ignores words while FRIDAY is paused.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PartialHandler = (payload: { text?: string }) => void;
type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    paused: boolean;
    handsFree: boolean;
    interim: string;
  };
  wakeWordRequired: boolean;
  noteMicFault: (message: string) => void;
  applyVoiceHeal: (fault: string, manual?: boolean, execute?: boolean) => unknown;
  shownMicFault: string;
};

const HANDS_FREE_KEY = "friday.assistant.handsfree";
const g = globalThis as unknown as {
  window?: unknown;
  localStorage?: unknown;
  document?: unknown;
  friday?: unknown;
  addEventListener?: unknown;
  removeEventListener?: unknown;
};
const root = resolve(import.meta.dirname, "../..");
const modeSource = readFileSync(resolve(root, "src/lib/friday/assistant-mode.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** Load the controller module from scratch, with the given stored values in a fake local storage. */
async function load(stored: Record<string, string> = {}) {
  vi.resetModules();
  const store = new Map(Object.entries(stored));
  g.window = globalThis;
  g.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  g.addEventListener ??= () => undefined;
  g.removeEventListener ??= () => undefined;
  g.document ??= {
    hidden: false,
    documentElement: { classList: { toggle: () => undefined } },
    addEventListener: () => undefined,
    hasFocus: () => true,
    head: { appendChild: () => undefined },
    getElementsByTagName: () => [{ appendChild: () => undefined }],
    createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined }),
    createTextNode: () => ({}),
  };
  const handlers: PartialHandler[] = [];
  g.friday = {
    onVoicePartial: (cb: PartialHandler) => {
      handlers.push(cb);
      return () => undefined;
    },
  };
  const { assistantMode } = await import("../../src/lib/friday/assistant-mode");
  const { voiceGate } = await import("../../src/lib/friday/voice-audio");
  assistantMode.subscribe(() => undefined);
  return { d: assistantMode as unknown as Driver, handlers, voiceGate };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe("hands-free default", () => {
  it("a fresh install starts in Auto with hands-free OFF and the wake word required", async () => {
    const { d, voiceGate } = await load();
    expect(d.state.mode).toBe("auto");
    expect(d.state.handsFree).toBe(false);
    expect(d.wakeWordRequired).toBe(true);
    expect(voiceGate.wake.handsFree).toBe(false);
  });

  it("a stored false stays off, a stored true is honoured", async () => {
    const off = await load({ [HANDS_FREE_KEY]: "false" });
    expect(off.d.state.handsFree).toBe(false);
    expect(off.d.wakeWordRequired).toBe(true);
    const on = await load({ [HANDS_FREE_KEY]: "true" });
    expect(on.d.state.handsFree).toBe(true);
    expect(on.d.wakeWordRequired).toBe(false);
    expect(on.voiceGate.wake.handsFree).toBe(true);
  });

  it("the source never switches hands-free on by itself", () => {
    expect(modeSource).not.toMatch(
      /else if \(this\.state\.mode === "auto"\) this\.state\.handsFree = true/,
    );
    expect(modeSource).not.toMatch(/if \(!this\.wakeWordRequired\) this\.state\.handsFree = true/);
    expect(modeSource).toMatch(/\n {4}handsFree: false,/);
  });
});

describe("a repeated microphone fault", () => {
  async function faultDriver() {
    const { d } = await load();
    const heals: string[] = [];
    vi.spyOn(d, "applyVoiceHeal").mockImplementation((fault: string) => {
      heals.push(fault);
      return { retry: false };
    });
    return { d, heals };
  }

  it("heals again for the same message once the first report is old", async () => {
    const { d, heals } = await faultDriver();
    d.noteMicFault("Microphone was taken by another app");
    vi.setSystemTime(Date.now() + 11_000);
    d.noteMicFault("Microphone was taken by another app");
    expect(heals).toEqual([
      "Microphone was taken by another app",
      "Microphone was taken by another app",
    ]);
  });

  it("still heals once for a burst of the same message", async () => {
    const { d, heals } = await faultDriver();
    d.noteMicFault("Microphone was taken by another app");
    vi.setSystemTime(Date.now() + 500);
    d.noteMicFault("Microphone was taken by another app");
    expect(heals).toHaveLength(1);
  });

  it("forgets the shown fault when the microphone reports it is open again", () => {
    expect(modeSource).toMatch(/this\.soak\.recovered\(\);\s*this\.shownMicFault = "";/);
  });
});

describe("the provisional transcript handler", () => {
  it("is registered once", async () => {
    const { handlers } = await load();
    expect(handlers).toHaveLength(1);
    expect(modeSource.match(/onVoicePartial\?\.\(/g)).toHaveLength(1);
  });

  it("shows no interim words while FRIDAY is paused", async () => {
    const { d, handlers } = await load();
    d.state.paused = true;
    d.state.interim = "";
    for (const handler of handlers) handler({ text: "open the browser" });
    expect(d.state.interim).toBe("");
  });

  it("shows interim words when Auto is live and not paused", async () => {
    const { d, handlers } = await load();
    d.state.paused = false;
    d.state.mode = "auto";
    for (const handler of handlers) handler({ text: "open the browser" });
    expect(d.state.interim).toBe("open the browser");
  });
});
