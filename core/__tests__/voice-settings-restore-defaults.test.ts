/**
 * "Reset voice defaults" in Settings > Voice must not switch hands-free on: hands-free starts off, so the reset puts the
 * wake word back and saves that choice (the safety rule: hands-free initialises false).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const source = readFileSync(
  resolve(root, "src/components/friday/settings/VoiceSettings.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

/** The click handler of the reset button: from its `onClick` to the success toast. */
function resetHandler(): string {
  const toast = source.indexOf('toast.success("Voice defaults restored');
  expect(toast).toBeGreaterThan(0);
  const from = source.lastIndexOf("onClick={() => {", toast);
  return source.slice(from, toast);
}

const g = globalThis as unknown as Record<string, unknown>;
const HANDS_FREE_KEY = "friday.assistant.handsfree";

/** A fresh controller whose durable hands-free copy says ON, as if the owner had switched it on before. */
async function loadWithHandsFreeOn() {
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
    getState: async (namespace: string) => (namespace === HANDS_FREE_KEY ? true : null),
    setState: async () => undefined,
  };
  const { assistantMode } = await import("../../src/lib/friday/assistant-mode");
  assistantMode.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  return assistantMode;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe("F14: the real reset handler leaves hands-free off", () => {
  it("runs the button's own statements: hands-free ON before, OFF and unmuted after", async () => {
    const mode = await loadWithHandsFreeOn();
    expect(mode.getSnapshot().handsFree).toBe(true);
    mode.setMuted(true);
    const calls: string[] = [];
    const preferences = {
      setVoice: (voice: unknown) => calls.push(`setVoice:${JSON.stringify(voice)}`),
      flush: () => Promise.resolve(calls.push("flush")),
    };
    const toast = { success: (message: string) => calls.push(`toast:${message}`) };
    const resetToBestVoice = () => calls.push("resetToBestVoice");
    // The handler body is plain statements; running the source itself keeps the twin honest if it is edited.
    const body = resetHandler().replace(/^onClick=\{\(\) => \{/, "") + 'toast.success("done");';
    new Function("preferences", "resetToBestVoice", "assistantMode", "toast", body)(
      preferences,
      resetToBestVoice,
      mode,
      toast,
    );
    expect(mode.getSnapshot().handsFree).toBe(false);
    expect(mode.getSnapshot().muted).toBe(false);
    expect(mode.getSnapshot().paused).toBe(false);
    expect(calls).toContain("resetToBestVoice");
    expect(calls).toContain("flush");
    expect(calls.find((c) => c.startsWith("setVoice:"))).toContain('"wakeWord":"friday"');
  });
});

describe("G4-1: Reset voice defaults", () => {
  it("restores the voice preferences and mutes nothing", () => {
    const handler = resetHandler();
    expect(handler).toContain("resetToBestVoice();");
    expect(handler).toContain("assistantMode.setMuted(false);");
    expect(handler).toContain("assistantMode.setPaused(false);");
  });

  it("puts hands-free back to its default, off, and never turns it on", () => {
    const handler = resetHandler();
    expect(handler).toContain("assistantMode.setHandsFree(false);");
    expect(handler).not.toContain("setHandsFree(true)");
  });
});
