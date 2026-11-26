/**
 * The speech bridge's worker deadlines (electron/stt.cjs): the first start of a run may take 90 s to answer its ping and
 * later starts 30 s; a model warm-up (voice:stt-stream-warm) has its own 120 s limit whose miss never kills the worker
 * or counts toward the breaker; a cold stream-open warms first with the same providers; the speech profile's idle time
 * reaches the worker; a crash loop cools 30 s the first time and 5 minutes after that, with a "listening paused,
 * Retry" line in English, Hindi and Hinglish (no offline recogniser exists to fall back on, so none is claimed).
 * Fake child, fake timers, no Python, no model, no microphone, no Windows.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWorker, settle, STATUS_OK, type Msg } from "./helpers/fake-stt-worker";

const req = createRequire(import.meta.url);
const stt = req("../../electron/stt.cjs");
const paths = req("../../electron/friday-paths.cjs");
const read = (file: string) =>
  fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const WAV = new Uint8Array(64);
const OPEN = { streamEngine: "nemotron", locale: "hi-en", streamId: "s1" };

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "friday-stt-deadlines-"));
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

const healthy = (msg: Msg): Record<string, unknown> | undefined => {
  if (msg.op === "status") return { id: msg.id, ...STATUS_OK };
  if (msg.op === "load") return { id: msg.id, ok: true, loadCount: 1 };
  if (msg.op === "stream-warm")
    return {
      id: msg.id,
      ok: true,
      op: "stream-warm",
      engine: "stream-ear-nemotron",
      loadedMs: 900,
    };
  if (msg.op === "stream-open") return { id: msg.id, ok: true, op: "stream-open" };
  return { id: msg.id, ok: true };
};

describe("init ping deadline: 90 s for the first ready of a run, 30 s after", () => {
  it("a first start whose ping is slow survives 30 s and dies at 90 s", async () => {
    const r = installFakeWorker(stt);
    r.control.respond = (msg) => (msg.op === "status" ? undefined : healthy(msg));
    const turn = stt.transcribe({ audioBytes: WAV, localOnly: true });
    turn.catch(() => {});
    await settle();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(r.killTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(56_000);
    expect(r.killTree).toHaveBeenCalledTimes(1);
  });

  it("a first start whose ping answers at 40 s is a good start", async () => {
    const r = installFakeWorker(stt);
    let held: Msg | null = null;
    r.control.respond = (msg) => {
      if (msg.op === "status") {
        held = msg;
        return undefined;
      }
      return healthy(msg);
    };
    const turn = stt.transcribe({ audioBytes: WAV, localOnly: true });
    await settle();
    await vi.advanceTimersByTimeAsync(40_000);
    r.children[0]!.emitLine({ id: held!.id, ...STATUS_OK });
    await vi.advanceTimersByTimeAsync(10);
    expect(await turn).toMatchObject({ ok: true });
    expect(r.killTree).not.toHaveBeenCalled();
    expect(r.spawn).toHaveBeenCalledTimes(1);
  });

  it("after one start reached ready, the next start's ping gets 30 s", async () => {
    const r = installFakeWorker(stt);
    r.control.respond = healthy;
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    r.children[0]!.die(null, "SIGKILL");
    await settle();
    r.control.respond = (msg) => (msg.op === "status" ? undefined : healthy(msg));
    const turn = stt.transcribe({ audioBytes: WAV, localOnly: true });
    turn.catch(() => {});
    await settle();
    r.killTree.mockClear();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(r.killTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.killTree).toHaveBeenCalledTimes(1);
  });

  it("the two limits are named constants in the source", () => {
    const src = read("electron/stt.cjs");
    expect(src).toMatch(/INIT_FIRST_MS = 90_000/);
    expect(src).toMatch(/INIT_MS = 30_000/);
  });
});

describe("voice:stt-stream-warm: one warm-up, its own 120 s limit, a miss is only a fallback", () => {
  async function ready(r: ReturnType<typeof installFakeWorker>) {
    r.control.respond = healthy;
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
  }

  it("sends op stream-warm with the engine and locale to the live worker and answers its reply", async () => {
    const r = installFakeWorker(stt);
    await ready(r);
    const out = await stt.streamWarm({ streamEngine: "nemotron", locale: "hi-en" });
    expect(out).toMatchObject({ ok: true, loadedMs: 900, engine: "stream-ear-nemotron" });
    expect(r.sent("stream-warm")[0]).toMatchObject({
      op: "stream-warm",
      streamEngine: "nemotron",
      locale: "hi-en",
    });
  });

  it("off, a bad engine, or no live worker refuse before any worker call and never start one", async () => {
    const r = installFakeWorker(stt);
    expect(await stt.streamWarm({ streamEngine: "off" })).toEqual({
      ok: false,
      fallback: true,
      reason: "off",
    });
    expect(await stt.streamWarm({})).toMatchObject({ ok: false, fallback: true, reason: "off" });
    expect(await stt.streamWarm({ streamEngine: "bogus" })).toMatchObject({
      reason: "bad-engine",
    });
    expect(await stt.streamWarm({ streamEngine: "auto" })).toMatchObject({
      ok: false,
      fallback: true,
      reason: "worker",
    });
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it("a kernel answer of reason warming is a fallback, not an error, and the worker lives", async () => {
    const r = installFakeWorker(stt);
    await ready(r);
    r.control.respond = (msg) =>
      msg.op === "stream-warm"
        ? { id: msg.id, ok: false, op: "stream-warm", reason: "warming", fallback: true }
        : healthy(msg);
    expect(await stt.streamWarm({ streamEngine: "auto" })).toMatchObject({
      ok: false,
      fallback: true,
      reason: "warming",
    });
    expect(r.killTree).not.toHaveBeenCalled();
  });

  it("a warm-up that is not answered in 120 s falls back, kills nothing and leaves the breaker clean", async () => {
    const r = installFakeWorker(stt);
    await ready(r);
    let held: Msg | null = null;
    r.control.respond = (msg) => {
      if (msg.op === "stream-warm") {
        held = msg;
        return undefined;
      }
      return healthy(msg);
    };
    const warming = stt.streamWarm({ streamEngine: "auto", locale: "en" });
    await settle();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(r.killTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await warming).toMatchObject({ ok: false, fallback: true, reason: "warming" });
    expect(r.killTree).not.toHaveBeenCalled();
    // The late answer is swallowed; the worker still serves and no child was spawned again.
    r.children[0]!.emitLine({ id: held!.id, ok: true, op: "stream-warm" });
    await settle();
    r.control.respond = healthy;
    expect(await stt.transcribe({ audioBytes: WAV, localOnly: true })).toMatchObject({ ok: true });
    expect(r.spawn).toHaveBeenCalledTimes(1);
  });

  it("a second warm-up while one runs joins it: one op reaches the worker", async () => {
    const r = installFakeWorker(stt);
    await ready(r);
    let held: Msg | null = null;
    r.control.respond = (msg) => {
      if (msg.op === "stream-warm") {
        held = msg;
        return undefined;
      }
      return healthy(msg);
    };
    const a = stt.streamWarm({ streamEngine: "auto" });
    const b = stt.streamWarm({ streamEngine: "auto" });
    await settle();
    expect(r.sent("stream-warm")).toHaveLength(1);
    r.children[0]!.emitLine({ id: held!.id, ok: true, op: "stream-warm", loadedMs: 5 });
    expect(await a).toMatchObject({ ok: true });
    expect(await b).toMatchObject({ ok: true });
  });
});

describe("a cold stream-open warms first, with the same providers", () => {
  async function ready(r: ReturnType<typeof installFakeWorker>) {
    r.control.respond = healthy;
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
  }

  it("the worker sees stream-warm then stream-open, carrying equal providers", async () => {
    const r = installFakeWorker(stt);
    await ready(r);
    const out = await stt.streamOpen({ ...OPEN, providers: ["CPUExecutionProvider"] });
    expect(out).toMatchObject({ ok: true, streamId: "s1" });
    const ops = r.children[0]!.seen.map((m) => m.op).filter((op) => /^stream-/.test(String(op)));
    expect(ops).toEqual(["stream-warm", "stream-open"]);
    const warm = r.sent("stream-warm")[0]!;
    const open = r.sent("stream-open")[0]!;
    expect(warm["providers"]).toEqual(["CPUExecutionProvider"]);
    expect(open["providers"]).toEqual(warm["providers"]);
  });

  it("without providers neither call carries the field", async () => {
    const r = installFakeWorker(stt);
    await ready(r);
    await stt.streamOpen(OPEN);
    expect(r.sent("stream-warm")[0]).not.toHaveProperty("providers");
    expect(r.sent("stream-open")[0]).not.toHaveProperty("providers");
  });

  it("a warm-up the kernel is still running answers a fallback and frees the turn gate", async () => {
    const r = installFakeWorker(stt);
    await ready(r);
    r.control.respond = (msg) =>
      msg.op === "stream-warm"
        ? { id: msg.id, ok: false, op: "stream-warm", reason: "warming", fallback: true }
        : healthy(msg);
    expect(await stt.streamOpen(OPEN)).toMatchObject({
      ok: false,
      fallback: true,
      reason: "warming",
    });
    expect(r.sent("stream-open")).toHaveLength(0);
    r.control.respond = healthy;
    expect(await stt.streamOpen({ ...OPEN, streamId: "s2" })).toMatchObject({ ok: true });
  });

  it("a kernel stream-open that answers warming is a fallback, never an error", async () => {
    const r = installFakeWorker(stt);
    await ready(r);
    r.control.respond = (msg) =>
      msg.op === "stream-open"
        ? { id: msg.id, ok: false, op: "stream-open", reason: "warming", fallback: true }
        : healthy(msg);
    expect(await stt.streamOpen(OPEN)).toMatchObject({
      ok: false,
      fallback: true,
      reason: "warming",
    });
    expect(r.killTree).not.toHaveBeenCalled();
  });

  it("stream-open keeps its own 25 s limit; the injected default ear does not warm first", async () => {
    const src = read("electron/stt.cjs");
    expect(src).toMatch(/STREAM_OPEN_MS = 25_000/);
    expect(src).toMatch(/STREAM_WARM_MS = 120_000/);
    expect(src).toMatch(/warmFirst: true/);
  });
});

describe("the light status leaves the Windows recogniser out: the lazy probe is asked only when it is needed", () => {
  const MISSING = { ok: true, dependency: "missing", available: false, error: "no package" };

  it("a start with no speech package and no windowsSpeech answer sends one probe", async () => {
    const r = installFakeWorker(stt);
    r.control.respond = (msg) => {
      if (msg.op === "status") return { id: msg.id, ...MISSING };
      if (msg.op === "probe") return { id: msg.id, ...MISSING, windowsSpeech: true };
      return healthy(msg);
    };
    await stt.transcribe({ audioBytes: WAV, localOnly: true }).catch(() => null);
    // One probe per start, never more.
    expect(r.sent("probe").length).toBeGreaterThanOrEqual(1);
    expect(r.sent("probe")).toHaveLength(r.spawn.mock.calls.length);
  });

  it("a healthy start, or a ping that already says windowsSpeech, sends no probe", async () => {
    const r = installFakeWorker(stt);
    r.control.respond = healthy;
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(r.sent("probe")).toHaveLength(0);
  });
});

describe("the speech profile's idle time reaches the worker", () => {
  it("the first ping of a start carries idleUnloadSec from the profile", async () => {
    const r = installFakeWorker(stt);
    r.control.respond = healthy;
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    const sec = r.sent("status")[0]!["idleUnloadSec"] as number;
    expect(Number.isInteger(sec)).toBe(true);
    expect([180, 600, 900]).toContain(sec);
  });

  it("a profile change is sent to the live worker as a light status", async () => {
    const r = installFakeWorker(stt);
    r.control.respond = healthy;
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    await stt.setSpeechProfile({ profile: "quality", idleUnloadMs: 900_000 });
    await settle();
    expect(r.sent("status").at(-1)).toMatchObject({ op: "status", idleUnloadSec: 900 });
    // A profile with no usable idle time changes nothing and sends nothing.
    const before = r.sent("status").length;
    await stt.setSpeechProfile({ profile: "x" });
    await stt.setSpeechProfile(null);
    expect(r.sent("status").length).toBe(before);
  });

  it("a profile set before any worker is used the next start", async () => {
    const r = installFakeWorker(stt);
    r.control.respond = healthy;
    await stt.setSpeechProfile({ profile: "lite", idleUnloadMs: 180_000 });
    expect(r.spawn).not.toHaveBeenCalled();
    await stt.transcribe({ audioBytes: WAV, localOnly: true });
    expect(r.sent("status")[0]).toMatchObject({ idleUnloadSec: 180 });
  });
});

describe("crash loop: 30 s the first time, 5 minutes after, and a paused line in three languages", () => {
  function crashing() {
    const r = installFakeWorker(stt);
    r.control.respond = (msg, child) => {
      if (msg.op === "transcribe") {
        child.die(1, null);
        return undefined;
      }
      return healthy(msg);
    };
    return r;
  }
  const turn = () => stt.transcribe({ audioBytes: WAV, localOnly: true });

  async function openBreaker(r: ReturnType<typeof crashing>) {
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 4; i += 1) last = await turn();
    expect(last["reason"]).toBe("crash-loop");
    return last;
  }

  it("answers the paused line in English, Hindi and Hinglish with a Retry hint", async () => {
    const r = crashing();
    const out = (await openBreaker(r)) as {
      error: string;
      retry: boolean;
      retryAfterMs: number;
      lines: Record<string, string>;
    };
    expect(out.retry).toBe(true);
    expect(out.retryAfterMs).toBeGreaterThan(0);
    expect(out.retryAfterMs).toBeLessThanOrEqual(30_000);
    expect(Object.keys(out.lines).sort()).toEqual(["en", "hi", "hinglish"]);
    expect(out.lines["en"]).toMatch(/paused/i);
    expect(out.lines["en"]).toMatch(/Retry/);
    expect(out.lines["hi"]).toMatch(/[ऀ-ॿ]/);
    expect(out.lines["hi"]).toMatch(/Retry/);
    expect(out.lines["hinglish"]).toMatch(/Retry/);
    expect(out.lines["hinglish"]).not.toMatch(/[ऀ-ॿ]/);
    expect(out.error).toBe(out.lines["en"]);
  });

  it("spawns nothing while open, then one probe after 30 s that closes the breaker when it works", async () => {
    const r = crashing();
    await openBreaker(r);
    const spawned = r.spawn.mock.calls.length;
    await turn();
    expect(r.spawn.mock.calls.length).toBe(spawned);
    await vi.advanceTimersByTimeAsync(31_000);
    r.control.respond = healthy;
    expect(await turn()).toMatchObject({ ok: true });
    expect(r.spawn.mock.calls.length).toBe(spawned + 1);
    expect(await turn()).toMatchObject({ ok: true });
  });

  it("a second open with no good turn between holds the next start for 5 minutes", async () => {
    const r = crashing();
    await openBreaker(r);
    await vi.advanceTimersByTimeAsync(31_000);
    // The probe start works, but every turn still crashes: three more in a minute open the breaker again.
    let again: Record<string, unknown> = {};
    for (let i = 0; i < 4 && again["reason"] !== "crash-loop"; i += 1) again = await turn();
    expect(again["reason"]).toBe("crash-loop");
    const spawned = r.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    r.control.respond = healthy;
    const held = (await turn()) as { reason?: string; retryAfterMs?: number };
    expect(held.reason).toBe("crash-loop");
    expect(held.retryAfterMs).toBeGreaterThan(200_000);
    expect(r.spawn.mock.calls.length).toBe(spawned);
    await vi.advanceTimersByTimeAsync(245_000);
    expect(await turn()).toMatchObject({ ok: true });
    expect(r.spawn.mock.calls.length).toBe(spawned + 1);
  });

  it("the source names both cool-downs and builds the worker with the first", () => {
    const src = read("electron/stt.cjs");
    expect(src).toMatch(/BREAKER_COOL_MS = 30_000/);
    expect(src).toMatch(/breaker: \{ max: 3, windowMs: 60_000, coolMs: BREAKER_COOL_MS \}/);
    expect(src).toMatch(/CRASH_LOOP_HOLD_MS = 300_000/);
  });
});

describe("wiring: one new channel, in main, preload and the budget table", () => {
  it("main handles it, preload allowlists it and the budget table calls it quick", () => {
    const budget = req("../../electron/ipc-budget-table.cjs");
    expect(budget.CHANNEL_CLASS["voice:stt-stream-warm"]).toBe(
      budget.CHANNEL_CLASS["voice:stt-stream-open"],
    );
    expect(read("electron/main.cjs")).toContain(
      'ipcMain.handle("voice:stt-stream-warm", (_e, payload) => stt.streamWarm(payload || {}));',
    );
    expect(read("electron/preload.cjs")).toContain(
      'warmSttStream: (payload) => ipcRenderer.invoke("voice:stt-stream-warm", payload || {}),',
    );
  });

  it("main hands the voice budget's profile to the speech worker and the speaker", () => {
    const main = read("electron/main.cjs");
    expect(main).toMatch(/stt\.setSpeechProfile\(/);
    expect(main).toMatch(/setIdleUnloadMs\(/);
  });

  it("the warm-up pass asks for the streaming ear only when streamEngine is not off", () => {
    const src = read("src/lib/friday/voice-prewarm.ts");
    expect(src).toMatch(/warmSttStream/);
    expect(src).toMatch(/streamWanted\(voice\.streamEngine\)/);
  });
});

describe("the speaker's idle unload follows the voice budget", () => {
  it("keeps ten minutes until main passes a profile, then uses it; a bad value changes nothing", () => {
    const neural = req("../../electron/neural-voice.cjs");
    expect(neural.ttsIdleUnloadMs()).toBe(600_000);
    expect(neural.setIdleUnloadMs(0)).toBe(false);
    expect(neural.setIdleUnloadMs("soon")).toBe(false);
    expect(neural.ttsIdleUnloadMs()).toBe(600_000);
    expect(neural.setIdleUnloadMs(180_000)).toBe(true);
    expect(neural.ttsIdleUnloadMs()).toBe(180_000);
  });
});
