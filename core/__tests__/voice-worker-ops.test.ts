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
      { text: "  Good morning sir  ", rate: 1.2, lang: "en-IN", style: "m2", seq: 4 },
      {
        resolvePy: async () => ["python", []],
        request: async (_py: unknown, payload: Record<string, unknown>) => {
          sent.push(payload);
          return { ok: true, sampleRate: 44100, pcm16: samples.toString("base64"), ms: 85, seq: 4 };
        },
      },
    );
    expect(sent).toEqual([
      { op: "speak-pcm", text: "Good morning sir", speed: 1.2, lang: "en-IN", style: "M2", seq: 4 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.cloud).toBe(false);
    expect(result.sampleRate).toBe(44100);
    expect(Buffer.isBuffer(result.pcm)).toBe(true);
    expect(result.pcm.equals(samples)).toBe(true);
    expect(result.ms).toBe(85);
    expect(result.seq).toBe(4);
  });

  it("passes only the two known engine names to the worker and drops everything else", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const deps = {
      resolvePy: async () => ["python", []],
      request: async (_py: unknown, payload: Record<string, unknown>) => {
        sent.push(payload);
        return { ok: true, sampleRate: 22050, pcm16: Buffer.from([1, 0, 2, 0]).toString("base64") };
      },
    };
    await neuralVoice.speakPcm({ text: "नमस्ते", engine: "hindi-light" }, deps);
    await neuralVoice.speakPcm({ text: "hi", engine: "supertonic" }, deps);
    for (const bad of [
      "HINDI-LIGHT",
      " hindi-light",
      "edge-tts",
      "cloud",
      "../x",
      "hindi-light\n",
      "",
      42,
      null,
      ["hindi-light"],
      { toString: () => "hindi-light" },
    ]) {
      await neuralVoice.speakPcm({ text: "hi", engine: bad }, deps);
    }
    await neuralVoice.speakPcm({ text: "hi" }, deps);
    expect(sent[0]).toEqual({
      op: "speak-pcm",
      text: "नमस्ते",
      speed: 1,
      lang: "",
      style: "",
      engine: "hindi-light",
    });
    expect(sent[1]?.["engine"]).toBe("supertonic");
    for (const payload of sent.slice(2)) expect("engine" in payload).toBe(false);
    expect(sent).toHaveLength(2 + 11 + 1);
  });

  it("returns the engine that answered and the fallback reason, and trusts neither blindly", async () => {
    const pcm = Buffer.from([1, 0, 2, 0]).toString("base64");
    const run = (answer: Record<string, unknown>) =>
      neuralVoice.speakPcm(
        { text: "नमस्ते", engine: "hindi-light" },
        {
          resolvePy: async () => ["python", []],
          request: async () => ({ ok: true, pcm16: pcm, ...answer }),
        },
      );
    const light = await run({ engine: "hindi-light" });
    expect(light).toMatchObject({ ok: true, engine: "hindi-light", cloud: false });
    expect("fallback" in light).toBe(false);
    const fell = await run({ engine: "supertonic-3", fallback: "hindi-light-failed" });
    expect(fell).toMatchObject({
      ok: true,
      engine: "supertonic-3",
      fallback: "hindi-light-failed",
    });
    const plain = await run({});
    expect(plain.engine).toBe("supertonic-3");
    expect("fallback" in plain).toBe(false);
    for (const engine of ["edge-tts", "cloud", "", 7, null, "hindi-light "]) {
      const odd = await run({ engine });
      expect(odd.engine).toBe("supertonic-3");
      expect(odd.cloud).toBe(false);
    }
    for (const fallback of ["x".repeat(65), "has space", "<b>", 5, "", "../up", "a\nb"]) {
      const odd = await run({ engine: "supertonic-3", fallback });
      expect("fallback" in odd).toBe(false);
    }
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

describe("per-utterance cancel of speak-pcm", () => {
  const pcm = Buffer.from(Int16Array.from([0, 900, -900, 20000]).buffer);
  const okAnswer = { ok: true, sampleRate: 22050, pcm16: pcm.toString("base64") };
  const deps = (request: (py: unknown, payload: Record<string, unknown>) => unknown) => ({
    resolvePy: async () => ["python", []],
    request: request as never,
  });

  it("sends a clean utterance id to the worker and returns it; a request without one is unchanged", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const request = async (_py: unknown, payload: Record<string, unknown>) => {
      sent.push(payload);
      return { ...okAnswer, utt: payload["utt"] };
    };
    const tagged = await neuralVoice.speakPcm({ text: "one", utt: "p1-7", seq: 2 }, deps(request));
    expect(sent[0]).toMatchObject({ op: "speak-pcm", utt: "p1-7", seq: 2 });
    expect(tagged).toMatchObject({ ok: true, utt: "p1-7", seq: 2 });
    for (const bad of [
      "",
      "has space",
      "x".repeat(65),
      "../up",
      7,
      null,
      ["a"],
      "a\nb",
      "\u0928\u092e",
    ]) {
      const before = sent.length;
      const answered = await neuralVoice.speakPcm({ text: "one", utt: bad }, deps(request));
      expect("utt" in (sent[before] ?? {})).toBe(false);
      expect("utt" in answered).toBe(false);
    }
  });

  it("answers a cancelled utterance as cancelled without asking the worker, and keeps others working", async () => {
    let asked = 0;
    const request = async () => {
      asked += 1;
      return okAnswer;
    };
    const notified: Array<Record<string, unknown>> = [];
    const done = await neuralVoice.cancelPcm(
      { utt: "c-1" },
      { notify: (payload: Record<string, unknown>) => (notified.push(payload), true) },
    );
    expect(done).toEqual({ ok: true, utt: "c-1", sent: true });
    expect(notified).toEqual([{ op: "cancel", utt: "c-1" }]);
    const dropped = await neuralVoice.speakPcm(
      { text: "late clause", utt: "c-1", seq: 5 },
      deps(request),
    );
    expect(dropped).toEqual({
      ok: false,
      engine: "local",
      cloud: false,
      reason: "cancelled",
      cancelled: true,
      utt: "c-1",
      seq: 5,
    });
    expect(asked).toBe(0);
    const next = await neuralVoice.speakPcm({ text: "next", utt: "c-2" }, deps(request));
    expect(next.ok).toBe(true);
    expect(asked).toBe(1);
  });

  it("drops a result that comes back after its utterance was cancelled while it was running", async () => {
    let release: (value: unknown) => void = () => {};
    const request = () => new Promise<unknown>((resolve) => (release = resolve));
    const pending = neuralVoice.speakPcm({ text: "slow clause", utt: "c-3" }, deps(request));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await neuralVoice.cancelPcm({ utt: "c-3" }, { notify: () => true });
    release(okAnswer);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, cancelled: true, reason: "cancelled", utt: "c-3" });
    expect("pcm" in result).toBe(false);
  });

  it("turns the worker's own cancelled answer into the same refusal", async () => {
    const result = await neuralVoice.speakPcm(
      { text: "one", utt: "c-4" },
      deps(async () => ({ ok: false, reason: "cancelled", utt: "c-4" })),
    );
    expect(result).toMatchObject({ ok: false, cancelled: true, reason: "cancelled", utt: "c-4" });
  });

  it("refuses a cancel without a clean id and never throws when there is no worker to tell", async () => {
    for (const bad of [undefined, "", "bad id", 4, null, "x".repeat(65)]) {
      const refused = await neuralVoice.cancelPcm({ utt: bad }, { notify: () => true });
      expect(refused).toMatchObject({ ok: false, reason: "bad-request" });
    }
    expect(await neuralVoice.cancelPcm(undefined, { notify: () => true })).toMatchObject({
      ok: false,
    });
    // No worker running: the id is still remembered here, so a clause that arrives later is refused.
    const idle = await neuralVoice.cancelPcm({ utt: "c-5" }, { notify: () => false });
    expect(idle).toEqual({ ok: true, utt: "c-5", sent: false });
    const late = await neuralVoice.speakPcm(
      { text: "late", utt: "c-5" },
      deps(async () => okAnswer),
    );
    expect(late).toMatchObject({ ok: false, cancelled: true });
  });

  it("does not start a worker just to cancel, and remembers only the newest ids", async () => {
    const source = read("electron/neural-voice.cjs");
    expect(source).toMatch(/function speakerNotify\(/);
    const notify = source.slice(source.indexOf("function speakerNotify("));
    expect(notify.slice(0, notify.indexOf("\n}\n"))).not.toMatch(/spawn\(/);
    for (let index = 0; index < neuralVoice.PCM_CANCELLED_KEEP + 20; index += 1) {
      await neuralVoice.cancelPcm({ utt: `bulk-${index}` }, { notify: () => false });
    }
    let asked = 0;
    const request = async () => {
      asked += 1;
      return okAnswer;
    };
    const oldest = await neuralVoice.speakPcm({ text: "old", utt: "bulk-0" }, deps(request));
    expect(oldest.ok).toBe(true);
    const newest = await neuralVoice.speakPcm(
      { text: "new", utt: `bulk-${neuralVoice.PCM_CANCELLED_KEEP + 19}` },
      deps(request),
    );
    expect(newest).toMatchObject({ ok: false, cancelled: true });
    expect(asked).toBe(1);
  });

  it("registers one cancel handler, one preload entry and one quick budget row", () => {
    const main = read("electron/main.cjs");
    expect(main.match(/ipcMain\.handle\("voice:neural-cancel-pcm"/g)).toHaveLength(1);
    expect(main).toMatch(
      /ipcMain\.handle\("voice:neural-cancel-pcm",\s*\(_e, payload\) =>\s*neuralVoice\.cancelPcm\(payload \|\| \{\}\)/,
    );
    expect(read("electron/preload.cjs")).toMatch(
      /cancelNeuralPcm: \(payload\) => ipcRenderer\.invoke\("voice:neural-cancel-pcm", payload\)/,
    );
    expect(budget.CHANNEL_CLASS["voice:neural-cancel-pcm"]).toBe("quick");
    expect(budget.CHANNEL_CLASS[CHANNEL]).toBe("stream");
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

describe("speak-pcm delivery fields and the warm-up op", () => {
  const pcm = Buffer.from([1, 0, 2, 0]).toString("base64");
  const run = async (input: Record<string, unknown>, reply: Record<string, unknown>) => {
    const sent: Array<Record<string, unknown>> = [];
    const result = await neuralVoice.speakPcm(
      { text: "hello", ...input },
      {
        resolvePy: async () => ["python", []],
        request: async (_py: unknown, payload: Record<string, unknown>) => {
          sent.push(payload);
          return { ok: true, sampleRate: 44100, pcm16: pcm, ...reply };
        },
      },
    );
    return { sent, result };
  };

  it("forwards trusted, first and a clamped pauseMs, and only strict values", async () => {
    const a = await run({ trusted: true, first: true, pauseMs: 99999 }, {});
    expect(a.sent[0]).toMatchObject({ trusted: true, first: true, pauseMs: 1200 });
    const b = await run({ trusted: "true", first: 1, pauseMs: Number.NaN }, {});
    expect(b.sent[0]).not.toHaveProperty("trusted");
    expect(b.sent[0]).not.toHaveProperty("first");
    expect(b.sent[0]).not.toHaveProperty("pauseMs");
    const c = await run({ pauseMs: -5 }, {});
    expect(c.sent[0]).not.toHaveProperty("pauseMs");
  });

  it("returns a clean pausedMs and wordTimes and nothing else from the worker", async () => {
    const { result } = await run(
      {},
      {
        pausedMs: 220.6,
        secret: "x",
        wordTimes: [
          { word: "hello", startMs: 0, endMs: 300, extra: 1 },
          { word: "bad", startMs: Number.NaN, endMs: 5 },
          { word: 7, startMs: 400, endMs: 500 },
          { word: "back", startMs: 100, endMs: 200 },
          { word: "x".repeat(65), startMs: 400, endMs: 500 },
          { word: "world", startMs: 300, endMs: 600 },
        ],
      },
    );
    expect(result.pausedMs).toBe(221);
    expect(result.wordTimes).toEqual([
      { word: "hello", startMs: 0, endMs: 300 },
      { word: "world", startMs: 300, endMs: 600 },
    ]);
    expect(result).not.toHaveProperty("secret");
  });

  it("survives hostile replies: huge arrays, NaN and non-strings", async () => {
    const huge = Array.from({ length: 5000 }, (_, i) => ({ word: "w", startMs: i, endMs: i + 1 }));
    const a = await run({}, { wordTimes: huge, pausedMs: 1e9 });
    expect(a.result.wordTimes).toHaveLength(400);
    expect(a.result.pausedMs).toBe(5000);
    const b = await run({}, { wordTimes: "nope", pausedMs: "50" });
    expect(b.result).not.toHaveProperty("wordTimes");
    expect(b.result.pausedMs).toBe(0);
    const c = await run({}, { wordTimes: [null, 3, [], { word: "a" }], pausedMs: Number.NaN });
    expect(c.result).not.toHaveProperty("wordTimes");
    expect(c.result.pausedMs).toBe(0);
  });

  it("sends the warm-up op once per run and ignores a failure", async () => {
    neuralVoice.resetWarmUp();
    const sent: Array<Record<string, unknown>> = [];
    const deps = {
      resolvePy: async () => ["python", []],
      request: async (_py: unknown, payload: Record<string, unknown>) => {
        sent.push(payload);
        throw new Error("boom");
      },
    };
    const first = await neuralVoice.speakPcm({ warm: true, style: "f2" }, deps);
    const second = await neuralVoice.speakPcm({ warm: true }, deps);
    expect(sent).toEqual([{ op: "warm-up", style: expect.any(String) }]);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    neuralVoice.resetWarmUp();
  });

  it("voice-prewarm asks for the warm-up once before the first clip", () => {
    const src = read("src/lib/friday/voice-prewarm.ts");
    expect(src).toMatch(/warm: true/);
    expect(src).toMatch(/engineWarmed/);
  });
});
