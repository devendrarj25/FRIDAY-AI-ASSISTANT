/**
 * The speaking engine tells the truth about itself: the status comes from the running worker first (and says when
 * the view is cold), the WAV cache never mixes recipes or engines, a failed warm-up is retried a few times, and a
 * reply's numbers and flags are clamped. The worker is a fake; no model, network or clock is used.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const neuralVoice = require_("../../electron/neural-voice.cjs");

const pcm = Buffer.from([1, 0, 2, 0]).toString("base64");
const python = async () => ["python", []];

describe("the status asks the running worker first", () => {
  const live = {
    tts: {
      engine: "friday-voice",
      own: true,
      ready: true,
      live: true,
      voiceId: "friday",
      sampleRate: 44100,
      recipeVersion: 3,
      engineState: "ready",
      failures: 2,
    },
  };

  it("returns the live section with live:true and never starts the cold process", async () => {
    let cold = 0;
    const status = await neuralVoice.fridayVoiceStatus(["python", []], {
      ask: async () => live,
      cold: async () => {
        cold += 1;
        return null;
      },
    });
    expect(cold).toBe(0);
    expect(status).toMatchObject({
      engine: "friday-voice",
      own: true,
      ready: true,
      live: true,
      state: "ready",
      failures: 2,
      recipeVersion: 3,
    });
  });

  it("falls back to the cold process and marks live:false when no worker answers", async () => {
    for (const asked of [null, undefined, { ok: false }, { tts: { engine: "friday-voice" } }]) {
      const status = await neuralVoice.fridayVoiceStatus(["python", []], {
        ask: async () => asked,
        cold: async () => ({ tts: { engine: "friday-voice", own: true, ready: true } }),
      });
      expect(status.live).toBe(false);
      expect(status.engine).toBe("friday-voice");
    }
  });

  it("says live:false and why when nothing answers at all, and when Python is missing", async () => {
    const none = await neuralVoice.fridayVoiceStatus(["python", []], {
      ask: async () => null,
      cold: async () => null,
    });
    expect(none).toMatchObject({ engine: "none", live: false });
    expect(none.reason).toMatch(/did not answer/);
    const noPython = await neuralVoice.fridayVoiceStatus(null);
    expect(noPython).toMatchObject({ engine: "none", live: false });
    expect(noPython.reason).toMatch(/Python/);
  });

  it("keeps a worker that throws from breaking the status", async () => {
    const status = await neuralVoice.fridayVoiceStatus(["python", []], {
      ask: async () => {
        throw new Error("pipe closed");
      },
      cold: async () => ({ tts: { engine: "supertonic-3", ready: true } }),
    });
    expect(status).toMatchObject({ engine: "supertonic-3", live: false });
  });

  it("bounds the live counters", () => {
    const status = neuralVoice.normaliseFridayVoiceStatus({
      tts: { engine: "friday-voice", live: true, failures: -4, state: "<script>" },
    });
    expect(status.failures).toBe(0);
    expect(status).not.toHaveProperty("state");
  });
});

describe("the WAV cache key and what is stored under it", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-cache-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (reply: Record<string, unknown>, sent: Array<Record<string, unknown>>) => ({
    cacheDir: () => dir,
    resolvePy: python,
    request: async (_py: unknown, payload: Record<string, unknown>) => {
      sent.push(payload);
      fs.writeFileSync(String(payload["out"]), Buffer.alloc(64, 1));
      return { ok: true, ...reply };
    },
  });
  const wavs = () => fs.readdirSync(dir).filter((name) => name.endsWith(".wav"));

  it("answers a repeated line from the cache while the recipe is the same", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const deps = make({ engine: "friday-voice", recipeVersion: 3 }, sent);
    const first = await neuralVoice.speakLocal({ text: "cache line one" }, deps);
    const again = await neuralVoice.speakLocal({ text: "cache line one" }, deps);
    expect(first.ok && again.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(again.engine).toBe("friday-voice");
  });

  it("does not serve a line made by an older recipe once a newer recipe has answered", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await neuralVoice.speakLocal(
      { text: "recipe line" },
      make({ engine: "friday-voice", recipeVersion: 3 }, sent),
    );
    await neuralVoice.speakLocal(
      { text: "another line" },
      make({ engine: "friday-voice", recipeVersion: 4 }, sent),
    );
    const again = await neuralVoice.speakLocal(
      { text: "recipe line" },
      make({ engine: "friday-voice", recipeVersion: 4 }, sent),
    );
    expect(again.ok).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it("never keeps a fallback reply under the FRIDAY key", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const deps = make(
      { engine: "supertonic-3", recipeVersion: 4, fallback: "engine-failed" },
      sent,
    );
    const first = await neuralVoice.speakLocal({ text: "fallback line" }, deps);
    expect(first).toMatchObject({ ok: true, engine: "supertonic-3", fallback: "engine-failed" });
    expect(wavs()).toEqual([]);
    await neuralVoice.speakLocal({ text: "fallback line" }, deps);
    expect(sent).toHaveLength(2);
  });

  it("names the engine that answered, not a fixed one", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const made = await neuralVoice.speakLocal(
      { text: "package line" },
      make({ engine: "supertonic-3", recipeVersion: 4 }, sent),
    );
    expect(made.engine).toBe("supertonic-3");
    const own = await neuralVoice.speakLocal(
      { text: "own line" },
      make({ engine: "friday-voice", recipeVersion: 4, own: true }, sent),
    );
    expect(own).toMatchObject({ engine: "friday-voice", own: true });
  });
});

describe("the warm-up is retried until it works, at most three times a run", () => {
  beforeEach(() => neuralVoice.resetWarmUp());
  afterEach(() => neuralVoice.resetWarmUp());

  it("retries after a failure, then stays quiet once it worked", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let ok = false;
    const deps = {
      resolvePy: python,
      request: async (_py: unknown, payload: Record<string, unknown>) => {
        sent.push(payload);
        return ok ? { ok: true } : { ok: false, reason: "model not ready" };
      },
    };
    const first = await neuralVoice.speakPcm({ warm: true }, deps);
    expect(first).toMatchObject({ ok: false, reason: "model not ready" });
    ok = true;
    const second = await neuralVoice.speakPcm({ warm: true }, deps);
    expect(second).toMatchObject({ ok: true, warmed: true });
    const third = await neuralVoice.speakPcm({ warm: true }, deps);
    expect(third).toMatchObject({ ok: true, warmed: false });
    expect(sent).toHaveLength(2);
  });

  it("gives up after three failed tries", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const deps = {
      resolvePy: python,
      request: async (_py: unknown, payload: Record<string, unknown>) => {
        sent.push(payload);
        throw new Error("boom");
      },
    };
    for (let i = 0; i < 6; i += 1) await neuralVoice.speakPcm({ warm: true }, deps);
    expect(sent).toHaveLength(3);
  });

  it("a missing Python does not use up a try", async () => {
    const deps = { resolvePy: async () => null };
    for (let i = 0; i < 5; i += 1) await neuralVoice.speakPcm({ warm: true }, deps);
    const sent: unknown[] = [];
    const ok = await neuralVoice.speakPcm(
      { warm: true },
      {
        resolvePy: python,
        request: async (_py: unknown, payload: unknown) => {
          sent.push(payload);
          return { ok: true };
        },
      },
    );
    expect(ok.warmed).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("speakPcm reports what the worker said, clamped", () => {
  const ask = (answer: Record<string, unknown>, input: Record<string, unknown> = {}) =>
    neuralVoice.speakPcm(
      { text: "hello", ...input },
      {
        resolvePy: python,
        request: async () => ({ ok: true, pcm16: pcm, sampleRate: 44100, ...answer }),
      },
    );

  it("clamps the sample rate to 8000..192000 and reads anything else as 0", async () => {
    for (const [given, wanted] of [
      [44100, 44100],
      [8000, 8000],
      [192000, 192000],
      [7999, 0],
      [192001, 0],
      [-5, 0],
      [Number.NaN, 0],
      ["44100", 44100],
      ["x", 0],
      [1e12, 0],
    ] as const) {
      expect((await ask({ sampleRate: given })).sampleRate, String(given)).toBe(wanted);
    }
  });

  it("carries engine, own, recipeVersion and voiceId from the reply", async () => {
    const own = await ask({
      engine: "friday-voice",
      own: true,
      recipeVersion: 3,
      voiceId: "friday-calm",
    });
    expect(own).toMatchObject({
      ok: true,
      engine: "friday-voice",
      own: true,
      recipeVersion: 3,
      voiceId: "friday-calm",
    });
    expect("fallback" in own).toBe(false);
    const odd = await ask({
      engine: "friday-voice",
      own: true,
      recipeVersion: -2,
      voiceId: "../x",
    });
    expect(odd).not.toHaveProperty("recipeVersion");
    expect(odd).not.toHaveProperty("voiceId");
  });

  it("marks a fallback reply and never calls it the own voice", async () => {
    const fell = await ask({
      engine: "friday-voice",
      own: true,
      fallback: "friday-voice-unavailable",
    });
    expect(fell.fallback).toBe("friday-voice-unavailable");
    expect(fell.own).toBe(false);
    const named = await ask({ engine: "supertonic-3", fallback: "engine-failed" });
    expect(named.own).toBe(false);
    expect(named.fallback).toBeTruthy();
  });

  it("passes a failed clause of a started utterance through as engine-failed", async () => {
    const failed = await neuralVoice.speakPcm(
      { text: "hello", utt: "u-1", seq: 4 },
      { resolvePy: python, request: async () => ({ ok: false, reason: "engine-failed" }) },
    );
    expect(failed).toMatchObject({ ok: false, reason: "engine-failed" });
  });
});
