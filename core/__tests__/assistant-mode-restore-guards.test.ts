/**
 * The stored hands-free choice is read strictly, on the desktop path too: only a stored boolean `true` opens it, and the
 * comments that describe the default say what the code does (hands-free starts off, the wake word is required).
 * Fake storage, fake desktop bridge, fake clock; no microphone, speaker, model or network.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HANDS_FREE_KEY = "friday.assistant.handsfree";
const g = globalThis as unknown as Record<string, unknown>;
const root = resolve(import.meta.dirname, "../..");
const modeSource = readFileSync(resolve(root, "src/lib/friday/assistant-mode.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** A fresh controller whose durable desktop copy holds `disk` for the hands-free key (and nothing in the cache). */
async function loadWithDisk(disk: unknown) {
  vi.resetModules();
  g["window"] = globalThis;
  const cache = new Map<string, string>();
  g["localStorage"] = {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => void cache.set(key, value),
    removeItem: (key: string) => void cache.delete(key),
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
  g["friday"] = {
    onVoicePartial: () => () => undefined,
    getState: async (namespace: string) => (namespace === HANDS_FREE_KEY ? disk : null),
    setState: async () => undefined,
  };
  const { assistantMode } = await import("../../src/lib/friday/assistant-mode");
  assistantMode.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  return assistantMode as unknown as { state: { handsFree: boolean }; wakeWordRequired: boolean };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe("G4-2: the durable hands-free copy is read strictly", () => {
  it.each([
    ["the string 'false'", "false"],
    ["the number 0", 0],
    ["null", null],
    ["the string 'true'", "true"],
    ["the number 1", 1],
  ])("%s leaves hands-free off and the wake word required", async (_label, stored) => {
    const d = await loadWithDisk(stored);
    expect(d.state.handsFree).toBe(false);
    expect(d.wakeWordRequired).toBe(true);
  });

  it("a stored boolean true opens it", async () => {
    const d = await loadWithDisk(true);
    expect(d.state.handsFree).toBe(true);
    expect(d.wakeWordRequired).toBe(false);
  });

  it("the source applies the disk value with a strict comparison", () => {
    expect(modeSource).toMatch(
      /restoreFromDisk<unknown>\(HANDS_FREE_KEY, \(on\) =>\s*this\.setHandsFree\(on === true\)/,
    );
    expect(modeSource).not.toMatch(/setHandsFree\(Boolean\(on\)\)/);
  });
});

describe("G4-6: the comments say what the default is", () => {
  it("no comment claims that Auto mode turns hands-free on", () => {
    expect(modeSource).not.toContain("A missing key leaves Auto");
    expect(modeSource).not.toContain("mode as the hands-free conversation");
    expect(modeSource).not.toContain("Auto mode turns it on in memory");
    expect(modeSource).toMatch(/Hands-free starts off; only a stored `true` opens it/);
  });
});
