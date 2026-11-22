/**
 * Worker ops that stream: local speak-pcm (raw PCM, no disk, no cache) and the provisional speech-to-text flush.
 * Both are additive and not wired into the live path yet; these tests pin the main, preload and budget wiring and
 * the Electron side of each op. The Python side is kernel/tests/test_voice_worker_ops.py.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const neuralVoice = require_("../../electron/neural-voice.cjs");
const stt = require_("../../electron/stt.cjs");
const budget = require_("../../electron/ipc-budget-table.cjs");

const CHANNEL = "voice:neural-speak-pcm";

describe("speak-pcm wiring", () => {
  it("registers one handler, one preload entry and one stream budget row", () => {
    const main = read("electron/main.cjs");
    expect(main.match(new RegExp(`ipcMain\\.handle\\("${CHANNEL}"`, "g"))).toHaveLength(1);
    expect(main).toMatch(
      /ipcMain\.handle\("voice:neural-speak-pcm",\s*\(_e, payload\) =>\s*neuralVoice\.speakPcm\(payload \|\| \{\}\)/,
    );
    const preload = read("electron/preload.cjs");
    expect(preload).toMatch(
      /speakNeuralPcm: \(payload\) => ipcRenderer\.invoke\("voice:neural-speak-pcm", payload\)/,
    );
    expect(budget.CHANNEL_CLASS[CHANNEL]).toBe("stream");
    expect(budget.budgetFor(CHANNEL).class).toBe("stream");
    // The existing speak channel keeps its class and its handler.
    expect(budget.CHANNEL_CLASS["voice:neural-speak"]).toBe("quick");
    expect(main).toMatch(
      /ipcMain\.handle\("voice:neural-speak", \(_e, payload\) =>\s*neuralVoice\.speak\(/,
    );
  });

  it("sends the request to the worker as op speak-pcm and returns the samples as a Buffer", async () => {
    const samples = Buffer.from(Int16Array.from([0, 1200, -1200, 32767]).buffer);
    const sent: Array<Record<string, unknown>> = [];
    const result = await neuralVoice.speakPcm(
      { text: "  Good morning sir  ", rate: 1.2, lang: "en-IN", style: "m3", seq: 4 },
      {
        resolvePy: async () => ["python", []],
        request: async (_py: unknown, payload: Record<string, unknown>) => {
          sent.push(payload);
          return { ok: true, sampleRate: 44100, pcm16: samples.toString("base64"), ms: 85, seq: 4 };
        },
      },
    );
    expect(sent).toEqual([
      { op: "speak-pcm", text: "Good morning sir", speed: 1.2, lang: "en-IN", style: "M3", seq: 4 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.cloud).toBe(false);
    expect(result.sampleRate).toBe(44100);
    expect(Buffer.isBuffer(result.pcm)).toBe(true);
    expect(result.pcm.equals(samples)).toBe(true);
    expect(result.ms).toBe(85);
    expect(result.seq).toBe(4);
  });

  it("never reaches a cloud voice, the disk or the system voice, even for sensitive text", async () => {
    const source = read("electron/neural-voice.cjs");
    const body = source.slice(
      source.indexOf("async function speakPcm"),
      source.indexOf("function pitchOffsetHz"),
    );
    expect(body).not.toMatch(/speakCloud|speakSystem|writeFileSync|cacheDir|createHash|edge/);
    let asked = 0;
    const result = await neuralVoice.speakPcm(
      { text: "my password is hunter2 and my card number is 4111 1111 1111 1111" },
      {
        resolvePy: async () => ["python", []],
        request: async () => {
          asked += 1;
          return { ok: false, reason: "no local model" };
        },
      },
    );
    expect(asked).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      engine: "local",
      cloud: false,
      reason: "no local model",
    });
  });

  it("refuses empty text, caps long text, drops a bad style and tolerates a dead worker", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const deps = {
      resolvePy: async () => ["python", []],
      request: async (_py: unknown, payload: Record<string, unknown>) => {
        calls.push(payload);
        return null;
      },
    };
    expect(await neuralVoice.speakPcm({ text: "   " }, deps)).toMatchObject({ ok: false });
    expect(await neuralVoice.speakPcm({}, deps)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
    const dead = await neuralVoice.speakPcm(
      { text: "x".repeat(2000), style: "../evil", seq: "no" },
      deps,
    );
    expect(dead).toMatchObject({ ok: false, cloud: false });
    expect(String(calls[0]?.["text"])).toHaveLength(500);
    expect(calls[0]?.["style"]).toBe("");
    expect("seq" in (calls[0] ?? {})).toBe(false);
    const noPython = await neuralVoice.speakPcm({ text: "hi" }, { resolvePy: async () => null });
    expect(noPython).toMatchObject({ ok: false, reason: expect.stringMatching(/Python/) });
    const empty = await neuralVoice.speakPcm(
      { text: "hi" },
      { resolvePy: async () => ["python", []], request: async () => ({ ok: true, pcm16: "" }) },
    );
    expect(empty.ok).toBe(false);
  });
});

describe("provisional speech-to-text", () => {
  it("passes provisional and the utterance id through, with no new channel and the same class", () => {
    expect(budget.CHANNEL_CLASS["voice:transcribe"]).toBe("stream");
    const main = read("electron/main.cjs");
    expect(main.match(/ipcMain\.handle\("voice:transcribe"/g)).toHaveLength(1);
    expect(main).not.toMatch(/ipcMain\.handle\("voice:(flush|transcribe-provisional)/);
    expect(stt.decodeExtras({ provisional: true })).toEqual({ provisional: true });
    expect(stt.decodeExtras({ provisional: "true" })).toEqual({});
    expect(stt.decodeExtras({})).toEqual({});
  });

  it("marks a provisional answer as not final and leaves a final answer untouched", () => {
    const heard = { ok: true, text: "open the calendar", audio: { durationMs: 1830.4 } };
    expect(stt.provisionalReply({}, heard)).toBe(heard);
    expect(stt.provisionalReply({ provisional: false, utteranceId: "u" }, heard)).toBe(heard);
    expect(stt.provisionalReply({ provisional: true, utteranceId: " u-7 " }, heard)).toEqual({
      ...heard,
      final: false,
      audioMs: 1830,
      utteranceId: "u-7",
    });
    const bare = stt.provisionalReply({ provisional: true }, { ok: true, text: "hi" });
    expect(bare).toEqual({ ok: true, text: "hi", final: false, audioMs: 0 });
    const long = stt.provisionalReply({ provisional: true, utteranceId: "x".repeat(300) }, heard);
    expect(long.utteranceId).toHaveLength(64);
    const failed = { ok: false, reason: "no-audio" };
    expect(stt.provisionalReply({ provisional: true }, failed)).toBe(failed);
  });

  it("refuses an empty provisional capture with a reason, like a final one", async () => {
    const result = await stt.transcribe({ audioBase64: "", provisional: true, utteranceId: "u" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.final).toBeUndefined();
  }, 60_000);
});
