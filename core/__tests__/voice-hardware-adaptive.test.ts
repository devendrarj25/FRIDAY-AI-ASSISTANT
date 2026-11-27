/**
 * The live streaming ear adapts to the PC: `voice.streamEngine` "auto" (the default) is on only with 12 GB of RAM,
 * 4 cores and a passing first-run self-bench (p95 of 10 chunks of 320 ms within 160 ms), stored and re-run when the
 * hardware facts change. A named engine or "off" (the owner's choice) always wins. Fake facts, a fake store and a fake
 * bench: no GPU, no network, no clock.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  STREAM_ENGINE_DEFAULT,
  STREAM_ENGINE_PICKS,
  type FridayPreferences,
} from "../../src/lib/friday/preferences";

const require = createRequire(import.meta.url);
const stt = require("../../electron/stt.cjs");
const weights = require("../../electron/voice-weights.cjs");
const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

type Facts = { totalRamGb: number; cores: number; cpu: string; gpu: boolean };
type Payload = { op?: unknown; bench?: unknown; streamId?: unknown; [key: string]: unknown };

const PC16: Facts = { totalRamGb: 15.9, cores: 8, cpu: "Test CPU", gpu: false };

function makeAuto(start: Facts) {
  let facts = { ...start };
  let record: unknown = null;
  const writes: unknown[] = [];
  const auto = stt.createStreamAuto({
    facts: () => facts,
    readStore: () => record,
    writeStore: (value: unknown) => {
      record = value;
      writes.push(value);
    },
  });
  return {
    auto,
    writes,
    setFacts: (next: Facts) => {
      facts = { ...next };
    },
    stored: () => record,
  };
}

function makeEar(auto: unknown, benchMs: number | null, warmFirst = true) {
  const calls: Payload[] = [];
  const session = { alive: true };
  const request = vi.fn(async (_s: unknown, payload: Payload) => {
    calls.push(payload);
    if (payload.op === "stream-warm") {
      const reply: Payload = { ok: true, op: "stream-warm", engine: "stream-ear-nemotron" };
      if (payload.bench && benchMs !== null) {
        reply.bench = {
          chunks: 10,
          chunkMs: 320,
          p95Ms: benchMs,
          providers: ["CPUExecutionProvider"],
        };
      }
      return reply;
    }
    if (payload.op === "stream-open")
      return { ok: true, op: "stream-open", streamId: payload.streamId };
    return { ok: true, op: payload.op };
  });
  let free = true;
  const gate = {
    tryEnter: () => {
      if (!free) return null;
      free = false;
      return () => {
        free = true;
      };
    },
  };
  const ear = stt.createStreamEar({
    gate,
    getWorker: () => session,
    request,
    auto,
    warmFirst,
    setTimer: () => null,
    clearTimer: () => undefined,
  });
  return { ear, calls };
}

const warms = (calls: Payload[]) => calls.filter((c) => c.op === "stream-warm");

describe("the auto rule (electron/voice-weights.cjs)", () => {
  it("holds the owner's numbers", () => {
    expect(weights.STREAM_AUTO).toEqual({
      minRamGb: 12,
      minCores: 4,
      benchChunks: 10,
      chunkMs: 320,
      p95LimitMs: 160,
    });
  });

  it("needs 12 GB and 4 cores, and says why it is off", () => {
    expect(weights.streamAutoHardware({ totalRamGb: 16, cores: 4 })).toMatchObject({
      eligible: true,
      reason: "ok",
    });
    const small = weights.streamAutoHardware({ totalRamGb: 8, cores: 8 });
    expect(small).toMatchObject({ eligible: false, reason: "low-ram" });
    expect(small.detail).toContain("8 GB");
    expect(weights.streamAutoHardware({ totalRamGb: 11.9, cores: 8 }).reason).toBe("low-ram");
    expect(weights.streamAutoHardware({ totalRamGb: 32, cores: 2 }).reason).toBe("few-cores");
    expect(weights.streamAutoHardware({}).reason).toBe("low-ram");
    expect(weights.streamAutoHardware({ totalRamGb: 16 }).reason).toBe("few-cores");
  });

  it("passes a bench only when a real number is within 160 ms", () => {
    expect(weights.streamAutoBenchPassed(160)).toBe(true);
    expect(weights.streamAutoBenchPassed(42.5)).toBe(true);
    for (const bad of [160.1, 400, -1, Number.NaN, null, undefined, "slow"]) {
      expect(weights.streamAutoBenchPassed(bad)).toBe(false);
    }
  });
});

describe("auto on a 16 GB, 8-core PC", () => {
  it("a fast bench turns the ear on, is stored, and is not run again", async () => {
    const pc = makeAuto(PC16);
    const { ear, calls } = makeEar(pc.auto, 92);
    const first = await ear.warm({ streamEngine: "auto", locale: "hi" });
    expect(first).toMatchObject({ ok: true });
    expect(warms(calls)).toHaveLength(1);
    expect(warms(calls)[0]?.bench).toEqual({ chunks: 10, chunkMs: 320 });
    expect(pc.stored()).toMatchObject({ v: 1, p95Ms: 92, providers: ["CPUExecutionProvider"] });
    expect(pc.auto.view()).toMatchObject({ state: "on", reason: "ok", p95Ms: 92, limitMs: 160 });

    const again = await ear.warm({ streamEngine: "auto", locale: "hi" });
    expect(again.ok).toBe(true);
    expect(warms(calls)).toHaveLength(2);
    expect(warms(calls)[1]?.bench).toBeUndefined();
    expect(pc.writes).toHaveLength(1);
  });

  it("a slow bench keeps the ear off with the reason, stored, and the open never runs", async () => {
    const pc = makeAuto(PC16);
    const { ear, calls } = makeEar(pc.auto, 230);
    expect(await ear.open({ streamEngine: "auto", locale: "en" })).toEqual({
      ok: false,
      fallback: true,
      reason: "auto-slow",
    });
    expect(calls.some((c) => c.op === "stream-open")).toBe(false);
    expect(pc.auto.view().state).toBe("off");
    expect(pc.auto.view().detail).toContain("230 ms");
    const before = calls.length;
    expect(await ear.warm({ streamEngine: "auto" })).toMatchObject({ reason: "auto-slow" });
    expect(calls.length).toBe(before);
  });

  it("a bench that measured nothing is a fallback and is not stored, so the next use measures again", async () => {
    const pc = makeAuto(PC16);
    const { ear, calls } = makeEar(pc.auto, null);
    expect(await ear.warm({ streamEngine: "auto" })).toMatchObject({ ok: false, fallback: true });
    expect(pc.stored()).toBeNull();
    await ear.warm({ streamEngine: "auto" });
    expect(warms(calls).every((c) => c.bench)).toBe(true);
    expect(warms(calls)).toHaveLength(2);
  });

  it("a stored record without a real number, or of another version, is not trusted", async () => {
    for (const record of [
      { v: 1, fingerprint: stt.streamAutoFingerprint(PC16), p95Ms: null },
      { v: 1, fingerprint: stt.streamAutoFingerprint(PC16), p95Ms: "12" },
      { v: 2, fingerprint: stt.streamAutoFingerprint(PC16), p95Ms: 12 },
    ]) {
      const auto = stt.createStreamAuto({
        facts: () => PC16,
        readStore: () => record,
        writeStore: () => undefined,
      });
      expect(auto.known()).toBe(false);
      const bench = vi.fn(async () => ({ ok: true, bench: { p95Ms: 300 } }));
      expect(await auto.decide(bench)).toMatchObject({ on: false, reason: "slow" });
      expect(bench).toHaveBeenCalledTimes(1);
    }
  });

  it("changed hardware facts re-run the bench", async () => {
    const pc = makeAuto(PC16);
    const { ear, calls } = makeEar(pc.auto, 100);
    await ear.warm({ streamEngine: "auto" });
    pc.setFacts({ ...PC16, totalRamGb: 31.8 });
    await ear.warm({ streamEngine: "auto" });
    pc.setFacts({ ...PC16, totalRamGb: 31.8, gpu: true });
    await ear.warm({ streamEngine: "auto" });
    expect(warms(calls).map((c) => Boolean(c.bench))).toEqual([true, true, true]);
    expect(pc.writes).toHaveLength(3);
    expect(stt.streamAutoFingerprint({ ...PC16, totalRamGb: 16.2 })).toBe(
      stt.streamAutoFingerprint(PC16),
    );
  });

  it("an open with no verdict yet warms (and benches) first even without warmFirst", async () => {
    const pc = makeAuto(PC16);
    const { ear, calls } = makeEar(pc.auto, 80, false);
    expect(await ear.open({ streamEngine: "auto", locale: "hi" })).toMatchObject({ ok: true });
    expect(calls.map((c) => c.op)).toEqual(["stream-warm", "stream-open"]);
  });
});

describe("auto on a small PC", () => {
  it("8 GB is off at once with no worker call and the reason in the status line", async () => {
    const pc = makeAuto({ ...PC16, totalRamGb: 7.8 });
    const { ear, calls } = makeEar(pc.auto, 50);
    expect(await ear.warm({ streamEngine: "auto" })).toEqual({
      ok: false,
      fallback: true,
      reason: "auto-low-ram",
    });
    expect(await ear.open({ streamEngine: "auto" })).toMatchObject({ reason: "auto-low-ram" });
    expect(calls).toHaveLength(0);
    expect(pc.auto.view()).toMatchObject({ state: "off", reason: "low-ram" });
    expect(pc.auto.view().detail).toContain("12 GB");
  });

  it("two cores is off", async () => {
    const pc = makeAuto({ ...PC16, cores: 2 });
    const { ear, calls } = makeEar(pc.auto, 50, false);
    expect(await ear.open({ streamEngine: "auto" })).toMatchObject({ reason: "auto-few-cores" });
    expect(calls).toHaveLength(0);
  });
});

describe("the owner's explicit choice wins", () => {
  it("a named engine runs on a small, slow PC with no bench", async () => {
    const pc = makeAuto({ ...PC16, totalRamGb: 4, cores: 2 });
    const { ear, calls } = makeEar(pc.auto, 999);
    expect(await ear.open({ streamEngine: "nemotron", locale: "hi" })).toMatchObject({ ok: true });
    expect(calls.every((c) => !c.bench)).toBe(true);
    expect(pc.writes).toHaveLength(0);
  });

  it("off stays off on a big fast PC", async () => {
    const pc = makeAuto({ ...PC16, totalRamGb: 64, cores: 16 });
    const { ear, calls } = makeEar(pc.auto, 10);
    expect(await ear.open({ streamEngine: "off" })).toEqual({
      ok: false,
      fallback: true,
      reason: "off",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("the stored setting", () => {
  async function hydrateFrom(stored: unknown) {
    vi.resetModules();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => JSON.stringify(stored), setItem: () => undefined },
    });
    const { preferences } = await import("../../src/lib/friday/preferences");
    return (await preferences.hydrate()) as FridayPreferences;
  }
  afterEach(() => vi.unstubAllGlobals());

  it("auto is the shipped default", () => {
    expect(STREAM_ENGINE_DEFAULT).toBe("auto");
    expect(DEFAULT_PREFERENCES.voice.streamEngine).toBe("auto");
  });

  it("a shape from before the setting reads auto; a stored off or engine is the owner's and stays", async () => {
    expect((await hydrateFrom({ voice: { liveWords: true } })).voice.streamEngine).toBe("auto");
    expect((await hydrateFrom({ voice: { streamEngine: "off" } })).voice.streamEngine).toBe("off");
    expect((await hydrateFrom({ voice: { streamEngine: "nemotron" } })).voice.streamEngine).toBe(
      "nemotron",
    );
    expect((await hydrateFrom({ voice: { streamEngine: "bogus" } })).voice.streamEngine).toBe(
      "off",
    );
  });

  it("the safety defaults do not move", () => {
    expect(DEFAULT_PREFERENCES.voice.privacyMode).toBe(false);
    expect(DEFAULT_PREFERENCES.voice.liveWords).toBe(false);
  });
});

describe("one word list in three places", () => {
  it("renderer, Electron and kernel offer the same words", () => {
    expect([...STREAM_ENGINE_PICKS]).toEqual(stt.STREAM_ENGINES);
    const kernel = read("kernel/stream_ear.py");
    const name = /^ENGINE_NAME = "([^"]+)"/m.exec(kernel)?.[1];
    const words = /^SETTING_WORDS = \(([^)]*)\)/m.exec(kernel)?.[1] ?? "";
    const list = words
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean)
      .map((w) => (w === "ENGINE_NAME" ? name : w.replace(/"/g, "")));
    expect(list).toEqual([...STREAM_ENGINE_PICKS]);
  });

  it("the kernel bench uses the same chunk count and size as the rule", () => {
    const kernel = read("kernel/stream_ear.py");
    expect(kernel).toMatch(new RegExp(`^BENCH_CHUNKS = ${weights.STREAM_AUTO.benchChunks}$`, "m"));
    expect(kernel).toMatch(new RegExp(`^BENCH_CHUNK_MS = ${weights.STREAM_AUTO.chunkMs}$`, "m"));
  });

  it("the live ear carries the auto gate and the status shows its line", () => {
    const src = read("electron/stt.cjs");
    expect(src).toContain("auto: streamAuto,");
    expect(src).toContain("value.streamAuto = streamAuto.view();");
  });
});
