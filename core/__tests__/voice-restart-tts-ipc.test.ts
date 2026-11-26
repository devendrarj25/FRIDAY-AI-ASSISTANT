/**
 * The restart-tts remedy end to end: renderer restartTts -> preload -> voice:restart-tts -> electron/voice-ipc.cjs
 * restartTts -> neuralVoice.restartSpeaker. The answer is always { ok, state } with state one of restarted,
 * not-running, breaker-open or error (an error carries a path-scrubbed short text). The supervisor in Auto mode asks
 * for it when speech fails twice in a row, at most once per failure streak, and says nothing unless speech fails again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) =>
  fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

const budget = require_("../../electron/ipc-budget-table.cjs");
const voiceIpc = require_("../../electron/voice-ipc.cjs");
const { scrubPaths } = require_("../../electron/stt.cjs");

const CHANNEL = "voice:restart-tts";

function fakeVoice(health: Record<string, unknown> = { state: "ready" }, restart?: () => unknown) {
  const calls: string[] = [];
  return {
    calls,
    speakerHealth: () => health,
    restartSpeaker: () => {
      calls.push("restart");
      return restart ? restart() : { ok: true, restarted: true };
    },
  };
}

describe("restart-tts wiring", () => {
  it("has one handler, one preload entry, one quick budget row and one renderer type", () => {
    const main = read("electron/main.cjs");
    expect(main.match(new RegExp(`ipcMain\\.handle\\("${CHANNEL}"`, "g"))).toHaveLength(1);
    expect(main).toMatch(/ipcMain\.handle\("voice:restart-tts", \(\) =>\s*voiceIpc\.restartTts\(/);
    const preload = read("electron/preload.cjs");
    expect(preload.match(/voice:restart-tts/g)).toHaveLength(1);
    expect(preload).toMatch(/restartTts: \(\) => ipcRenderer\.invoke\("voice:restart-tts"\)/);
    expect(budget.CHANNEL_CLASS[CHANNEL]).toBe("quick");
    expect(budget.budgetFor(CHANNEL).class).toBe("quick");
    expect(read("src/lib/friday/desktop.ts")).toMatch(/\brestartTts\?: \(\) => Promise</);
  });
});

describe("restartTts handler shapes", () => {
  it("restarts a running speaker: { ok: true, state: restarted }", async () => {
    const voice = fakeVoice({ state: "ready", pid: 7 });
    expect(await voiceIpc.restartTts({ neuralVoice: voice, scrubPaths })).toEqual({
      ok: true,
      state: "restarted",
    });
    expect(voice.calls).toEqual(["restart"]);
  });

  it("answers not-running (ok) for a speaker that never started, and does not restart anything", async () => {
    const voice = fakeVoice({ state: "cold", pid: null });
    expect(await voiceIpc.restartTts({ neuralVoice: voice, scrubPaths })).toEqual({
      ok: true,
      state: "not-running",
    });
    expect(voice.calls).toEqual([]);
  });

  it("refuses while the crash breaker is open (a restart must not bypass it)", async () => {
    const voice = fakeVoice({ state: "breaker-open", breakerUntil: 123 });
    expect(await voiceIpc.restartTts({ neuralVoice: voice, scrubPaths })).toEqual({
      ok: false,
      state: "breaker-open",
    });
    expect(voice.calls).toEqual([]);
  });

  it("scrubs a failure to a short path-free text", async () => {
    const voice = fakeVoice({ state: "ready" }, () => {
      throw new Error("cannot kill C:\\Users\\someone\\AppData\\Roaming\\FRIDAY\\python.exe now");
    });
    const out = await voiceIpc.restartTts({ neuralVoice: voice, scrubPaths });
    expect(out.ok).toBe(false);
    expect(out.state).toBe("error");
    expect(out.error).toBeTypeOf("string");
    expect(out.error).not.toMatch(/someone|AppData|C:\\/);
    expect(out.error.length).toBeLessThanOrEqual(200);
  });

  it("answers a fixed code when the voice module or scrubber is missing, never throws", async () => {
    expect(await voiceIpc.restartTts({ neuralVoice: null, scrubPaths })).toEqual({
      ok: false,
      state: "error",
      error: "voice-unavailable",
    });
    const voice = fakeVoice({ state: "ready" }, () => {
      throw new Error("boom");
    });
    expect(await voiceIpc.restartTts({ neuralVoice: voice })).toEqual({
      ok: false,
      state: "error",
      error: "restart-failed",
    });
  });
});

type Driver = {
  noteTtsOutcome: (ok: boolean) => void;
  superviseTick: () => void;
};
const g = globalThis as unknown as {
  window?: unknown;
  localStorage?: unknown;
  document?: unknown;
  friday?: unknown;
  addEventListener?: unknown;
  removeEventListener?: unknown;
};

async function loadMode(restartTts?: () => Promise<unknown>) {
  vi.resetModules();
  const store = new Map<string, string>();
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
  g.friday = {
    onVoicePartial: () => () => undefined,
    ...(restartTts ? { restartTts } : {}),
  };
  const { assistantMode } = await import("../../src/lib/friday/assistant-mode");
  assistantMode.subscribe(() => undefined);
  return assistantMode as unknown as Driver & { state: { error?: string | null } };
}

describe("the supervisor asks for a speaker restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("calls restartTts on the second failure in a row, once per streak, and a success starts a new streak", async () => {
    const restart = vi.fn(async () => ({ ok: true, state: "restarted" }));
    const d = await loadMode(restart);
    d.noteTtsOutcome(false);
    expect(restart).toHaveBeenCalledTimes(0);
    d.noteTtsOutcome(false);
    expect(restart).toHaveBeenCalledTimes(1);
    d.noteTtsOutcome(false);
    d.noteTtsOutcome(false);
    expect(restart).toHaveBeenCalledTimes(1);
    d.noteTtsOutcome(true);
    d.noteTtsOutcome(false);
    expect(restart).toHaveBeenCalledTimes(1);
    d.noteTtsOutcome(false);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("a failed restart answer or a thrown call is silent and never retried inside the streak", async () => {
    const restart = vi.fn(async () => {
      throw new Error("ipc gone");
    });
    const d = await loadMode(restart);
    d.noteTtsOutcome(false);
    d.noteTtsOutcome(false);
    await vi.advanceTimersByTimeAsync(10);
    d.noteTtsOutcome(false);
    expect(restart).toHaveBeenCalledTimes(1);
    const refused = vi.fn(async () => ({ ok: false, state: "breaker-open" }));
    const e = await loadMode(refused);
    e.noteTtsOutcome(false);
    e.noteTtsOutcome(false);
    await vi.advanceTimersByTimeAsync(10);
    e.noteTtsOutcome(false);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("a bridge without restartTts (a browser, an old build) does nothing and does not throw", async () => {
    const d = await loadMode();
    expect(() => {
      d.noteTtsOutcome(false);
      d.noteTtsOutcome(false);
    }).not.toThrow();
  });

  it("is wired at both failure sites, the success site and the restart-tts verdict", () => {
    const src = read("src/lib/friday/assistant-mode.ts");
    expect(src.match(/this\.noteTtsOutcome\(false\)/g)).toHaveLength(2);
    expect(src.match(/this\.noteTtsOutcome\(true\)/g)).toHaveLength(1);
    expect(src).toMatch(/verdict\.remedy === "restart-tts"/);
  });
});
