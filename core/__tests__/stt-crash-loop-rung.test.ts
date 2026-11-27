/**
 * While the speech worker's crash-loop breaker is open, a short turn is heard through the offline Windows-speech
 * rung (a one-shot PowerShell, no Python child) when that rung was seen ready; otherwise the "Listening paused"
 * lines stay. Fake child, fake PowerShell, fake clock: no Python, no model, no Windows.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWorker, STATUS_OK } from "./helpers/fake-stt-worker";

const req = createRequire(import.meta.url);
const stt = req("../../electron/stt.cjs");
const paths = req("../../electron/friday-paths.cjs");
const WAV = new Uint8Array(64);
const turn = () => stt.transcribe({ audioBytes: WAV, mime: "audio/wav", localOnly: true });

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "friday-stt-rung-"));
  paths.setRoot(root);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  stt.useForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  paths.setRoot(null);
  fs.rmSync(root, { recursive: true, force: true });
});

/** A worker that crashes on every transcribe; `windowsSpeech` is what its status ping reports. */
function crashingRig(windowsSpeech: boolean, platform: string, said: string | null) {
  const r = installFakeWorker();
  r.control.respond = (msg, child) => {
    if (msg.op === "transcribe") {
      child.die(1, null);
      return undefined;
    }
    if (msg.op === "status") return { id: msg.id, ...STATUS_OK, windowsSpeech };
    if (msg.op === "load") return { id: msg.id, ok: true, loadCount: 1 };
    return { id: msg.id, ok: true };
  };
  const probe = JSON.stringify({ ok: true, dependency: "ready", available: true, model: "small" });
  const shell = vi.fn(async (exe: string, _args?: string[]) =>
    exe === "powershell"
      ? { ok: said !== null, stdout: said ?? "", stderr: "" }
      : { ok: true, stdout: probe, stderr: "" },
  );
  stt.useForTests({
    spawn: r.spawn,
    killTree: r.killTree,
    python: async () => ["python-test", ["-3"]],
    run: shell,
    platform,
    weights: async (wanted: string) => ({ ok: true, dir: `/weights/${wanted}`, size: wanted }),
  });
  const powershell = () => shell.mock.calls.filter((c) => c[0] === "powershell");
  return { r, powershell };
}

async function fiveTurns() {
  const out = [];
  for (let i = 0; i < 5; i += 1) out.push(await turn());
  return out;
}

describe("crash-loop fallback through the Windows-speech rung", () => {
  it("hears the turn through windows-speech once the breaker is open, and starts no new child", async () => {
    const { r, powershell } = crashingRig(true, "win32", "open the notes");
    const turns = await fiveTurns();
    expect(turns.map((t) => t.reason)).not.toContain("crash-loop");
    const heard = turns.filter((t) => t.engine === "windows-speech");
    expect(heard.length).toBeGreaterThan(0);
    expect(heard[0]).toMatchObject({ ok: true, text: "open the notes", model: "windows-speech" });
    const script = String(powershell()[0]?.[1]?.at(-1));
    expect(script).toContain("System.Speech.Recognition.SpeechRecognitionEngine");
    expect(script).toContain(".wav'");
    const spawned = r.spawn.mock.calls.length;
    await turn();
    expect(r.spawn.mock.calls.length).toBe(spawned);
  });

  it("keeps the Listening paused answer when the rung heard nothing", async () => {
    const { powershell } = crashingRig(true, "win32", null);
    const turns = await fiveTurns();
    expect(turns.map((t) => t.reason)).toContain("crash-loop");
    expect(powershell().length).toBeGreaterThan(0);
  });

  it("keeps the Listening paused answer when the rung was never seen ready", async () => {
    const { powershell } = crashingRig(false, "win32", "hello");
    const turns = await fiveTurns();
    expect(turns.map((t) => t.reason)).toContain("crash-loop");
    expect(powershell()).toHaveLength(0);
  });

  it("keeps the Listening paused answer off Windows", async () => {
    const { powershell } = crashingRig(true, "linux", "hello");
    const turns = await fiveTurns();
    expect(turns.map((t) => t.reason)).toContain("crash-loop");
    expect(powershell()).toHaveLength(0);
  });
});
