/**
 * FRIDAY's own streaming ear, the Electron side: stream-open, stream-feed and stream-close ride the one speech
 * worker, hold the one turn gate for the life of a stream, and answer {ok:false, fallback:true, reason} (never a
 * throw) whenever the renderer must use the existing transcribe path. Off (or absent) refuses before any worker.
 * Fake worker, fake timers, no process, no model, no microphone.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const req = createRequire(import.meta.url);
const stt = req("../../electron/stt.cjs");
const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

type Payload = { op?: string; streamId?: string; locale?: string; [key: string]: unknown };

function rig(
  replies: Record<string, (payload: Payload) => unknown> = {},
  options: { alive?: boolean; guard?: (run: () => Promise<unknown>) => Promise<unknown> } = {},
) {
  const gate = stt.createTurnGate();
  const calls: { payload: Payload; timeoutMs: number }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const session = { alive: options.alive !== false, loaded: true, pending: new Map() };
  const request = vi.fn(async (_s: unknown, payload: Payload, timeoutMs: number) => {
    calls.push({ payload, timeoutMs });
    const make = replies[String(payload.op)];
    if (!make) return { ok: true, op: payload.op, streamId: payload.streamId };
    return make(payload);
  });
  const ear = stt.createStreamEar({
    gate,
    getWorker: () => (session.alive ? session : null),
    request,
    ...(options.guard ? { guard: options.guard } : {}),
    idleMs: 15_000,
    setTimer: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimer: (entry: { cleared: boolean } | null) => {
      if (entry) entry.cleared = true;
    },
  });
  return { ear, gate, calls, timers, session, request };
}

const OPEN = { streamEngine: "nemotron", locale: "hi-en" };
const PCM = Buffer.from(new Int16Array(2560).buffer).toString("base64");
const openOk = (p: Payload) => ({
  ok: true,
  op: "stream-open",
  streamId: p.streamId,
  engine: "stream-ear-nemotron",
  locale: p.locale,
  providers: ["cpu"],
  chunkMs: 160,
  loadMs: 900,
});

describe("stream-open", () => {
  it("refuses off, absent and non-string engines before touching the worker", async () => {
    const r = rig();
    for (const body of [{}, { streamEngine: "off" }, { streamEngine: "" }, { streamEngine: 7 }]) {
      const out = await r.ear.open({ locale: "en", ...body });
      expect(out).toEqual({ ok: false, fallback: true, reason: "off" });
    }
    expect(await r.ear.open({ streamEngine: "whisper-xl" })).toMatchObject({
      ok: false,
      reason: "bad-engine",
      fallback: true,
    });
    expect(r.request).not.toHaveBeenCalled();
    expect(r.gate.busy()).toBe(false);
  });

  it("opens through the worker, holds the turn gate and arms one idle timer after the model loaded", async () => {
    const r = rig({ "stream-open": openOk });
    const out = await r.ear.open({ ...OPEN, streamId: "u-1" });
    expect(out).toMatchObject({
      ok: true,
      streamId: "u-1",
      engine: "stream-ear-nemotron",
      chunkMs: 160,
      loadMs: 900,
    });
    expect(out).not.toHaveProperty("op");
    expect(r.calls[0]?.payload).toMatchObject({
      op: "stream-open",
      streamEngine: "nemotron",
      locale: "hi-en",
      streamId: "u-1",
    });
    expect(r.calls[0]?.timeoutMs).toBeLessThan(30_000); // the quick IPC budget is 30 s
    expect(r.gate.busy()).toBe(true);
    expect(r.ear.active()).toBe("u-1");
    expect(r.timers.filter((t) => !t.cleared)).toHaveLength(1);
  });

  it("makes an id when none comes, strips odd characters and caps the length", async () => {
    const r = rig({ "stream-open": openOk });
    const made = await r.ear.open(OPEN);
    expect(String(made.streamId)).toMatch(/^stream-\d+$/);
    await r.ear.close({});
    const odd = await r.ear.open({ ...OPEN, streamId: `a b/../c${"x".repeat(100)}` });
    expect(String(odd.streamId)).toMatch(/^[\w.:-]{1,64}$/);
    expect(String(odd.streamId).length).toBeLessThanOrEqual(64);
  });

  it("cleans hotwords (max 64, 40 chars, trimmed, deduped) and the locale, and passes endpoint only when boolean", async () => {
    const r = rig({ "stream-open": openOk });
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`);
    await r.ear.open({
      ...OPEN,
      locale: "HI_EN",
      hotwords: [" Friday ", "Friday", "", 5, "y".repeat(41), ...words],
      endpoint: "yes",
    });
    const sent = r.calls[0]?.payload as { hotwords: string[]; locale: string };
    expect(sent.locale).toBe("hi-en");
    expect(sent.hotwords).toHaveLength(64);
    expect(sent.hotwords[0]).toBe("Friday");
    expect(new Set(sent.hotwords).size).toBe(64);
    expect(sent.hotwords.every((w) => w.length <= 40)).toBe(true);
    expect(r.calls[0]?.payload).not.toHaveProperty("endpoint");
    await r.ear.close({});
    await r.ear.open({ ...OPEN, locale: "<script>", endpoint: true });
    expect(r.calls.at(-1)?.payload).toMatchObject({ locale: "", endpoint: true });
    expect(r.calls.at(-1)?.payload).not.toHaveProperty("hotwords");
  });

  it("a gate held by a final decode is never queued behind: busy fallback, nothing sent", async () => {
    const r = rig();
    const release = await r.gate.enter();
    expect(await r.ear.open(OPEN)).toEqual({ ok: false, fallback: true, reason: "busy" });
    expect(r.request).not.toHaveBeenCalled();
    release();
  });

  it("a second stream while one is open is busy and leaves the first untouched", async () => {
    const r = rig({ "stream-open": openOk });
    await r.ear.open({ ...OPEN, streamId: "one" });
    expect(await r.ear.open({ ...OPEN, streamId: "two" })).toMatchObject({
      reason: "busy",
      fallback: true,
    });
    expect(r.ear.active()).toBe("one");
    expect(r.gate.busy()).toBe(true);
  });

  it("never starts a worker: none alive is a worker fallback and holds nothing", async () => {
    const r = rig({}, { alive: false });
    expect(await r.ear.open(OPEN)).toEqual({ ok: false, fallback: true, reason: "worker" });
    expect(r.request).not.toHaveBeenCalled();
    expect(r.gate.busy()).toBe(false);
  });

  it("a worker refusal releases the gate and its reason is passed on", async () => {
    const r = rig({ "stream-open": () => ({ ok: false, reason: "pin-missing", fallback: true }) });
    expect(await r.ear.open(OPEN)).toEqual({ ok: false, fallback: true, reason: "pin-missing" });
    expect(r.gate.busy()).toBe(false);
    expect(r.ear.active()).toBe("");
  });

  it("a worker crash or timeout is a worker fallback and frees the gate", async () => {
    const r = rig({
      "stream-open": () => {
        throw new Error("STT worker timed out");
      },
    });
    expect(await r.ear.open(OPEN)).toEqual({ ok: false, fallback: true, reason: "worker" });
    expect(r.gate.busy()).toBe(false);
  });

  it("the model load runs inside the governor's guard, as loadWorker's does", async () => {
    const order: string[] = [];
    const r = rig(
      { "stream-open": (p) => (order.push("request"), openOk(p)) },
      {
        guard: async (run) => {
          order.push("guard-in");
          const out = await run();
          order.push("guard-out");
          return out;
        },
      },
    );
    await r.ear.open(OPEN);
    expect(order).toEqual(["guard-in", "request", "guard-out"]);
  });

  it("a retried open with the same id is never closed by the first open's late reply", async () => {
    let release: (value: unknown) => void = () => {};
    let first = true;
    const r = rig({
      "stream-open": (p) => {
        if (first) {
          first = false;
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return openOk(p);
      },
    });
    const firstOpen = r.ear.open({ ...OPEN, streamId: "same" });
    await Promise.resolve();
    await Promise.resolve();
    const second = await r.ear.open({ ...OPEN, streamId: "same" });
    expect(second).toMatchObject({ ok: true, streamId: "same" });
    const openIndex = r.calls.map((c) => c.payload.op).lastIndexOf("stream-open");
    release(openOk({ streamId: "same", locale: "hi-en" }));
    expect(await firstOpen).toMatchObject({ ok: false, reason: "aborted" });
    await Promise.resolve();
    await Promise.resolve();
    // Nothing may close the stream the retry opened: no stream-close after the retry's open.
    expect(r.calls.slice(openIndex + 1).some((c) => c.payload.op === "stream-close")).toBe(false);
    expect(r.gate.busy()).toBe(true);
  });

  it("a mute while the model loads ends the stream, answers aborted and discards what the worker opened", async () => {
    let finish: (v: unknown) => void = () => {};
    const r = rig({
      "stream-open": () => new Promise((resolve) => (finish = resolve)),
    });
    const pending = r.ear.open({ ...OPEN, streamId: "slow" });
    await Promise.resolve();
    await Promise.resolve();
    r.ear.abort();
    expect(r.gate.busy()).toBe(false);
    finish(openOk({ streamId: "slow", locale: "hi-en" }));
    expect(await pending).toMatchObject({ ok: false, fallback: true, reason: "aborted" });
    expect(r.calls.at(-1)?.payload).toMatchObject({ op: "stream-close", finalize: false });
  });
});

describe("stream-feed", () => {
  it("returns the worker's partials and endpoint verdict and re-arms one idle timer", async () => {
    const r = rig({
      "stream-open": openOk,
      "stream-feed": (p) => ({
        ok: true,
        op: "stream-feed",
        streamId: p.streamId,
        events: [{ type: "partial", text: "aaj ka mausam", revision: 2, audioMs: 320 }],
        text: "aaj ka mausam",
        committed: "aaj",
        audioMs: 320,
        endpoint: { event: null, inTurn: true, audioMs: 320 },
      }),
    });
    await r.ear.open({ ...OPEN, streamId: "u-2" });
    const out = await r.ear.feed({ streamId: "u-2", pcm: PCM });
    expect(out).toMatchObject({
      ok: true,
      streamId: "u-2",
      text: "aaj ka mausam",
      committed: "aaj",
      audioMs: 320,
      endpoint: { event: null, inTurn: true },
    });
    expect(out.events).toHaveLength(1);
    expect(r.calls.at(-1)?.payload).toEqual({ op: "stream-feed", streamId: "u-2", pcm: PCM });
    expect(r.timers.filter((t) => !t.cleared)).toHaveLength(1);
    expect(r.gate.busy()).toBe(true);
  });

  it("feeding with no stream, or for another id, is a no-stream fallback", async () => {
    const r = rig({ "stream-open": openOk });
    expect(await r.ear.feed({ pcm: PCM })).toEqual({
      ok: false,
      fallback: true,
      reason: "no-stream",
    });
    await r.ear.open({ ...OPEN, streamId: "mine" });
    expect(await r.ear.feed({ streamId: "other", pcm: PCM })).toMatchObject({
      reason: "no-stream",
    });
    expect(r.ear.active()).toBe("mine");
  });

  it("missing, non-string or oversized audio ends the stream (gate freed) and says why", async () => {
    const r = rig({ "stream-open": openOk });
    await r.ear.open(OPEN);
    expect(await r.ear.feed({ pcm: 123 })).toMatchObject({
      ok: false,
      fallback: true,
      reason: "bad-audio",
    });
    expect(r.gate.busy()).toBe(false);
    await r.ear.open(OPEN);
    const big = "A".repeat(Math.ceil((1_048_576 * 4) / 3) + 100);
    expect(await r.ear.feed({ pcm: big })).toMatchObject({
      ok: false,
      fallback: true,
      reason: "too-large",
    });
    expect(r.gate.busy()).toBe(false);
    expect(r.calls.filter((c) => c.payload.op === "stream-feed")).toHaveLength(0);
  });

  it("a worker refusal or crash mid-stream ends the stream and frees the gate", async () => {
    const r = rig({
      "stream-open": openOk,
      "stream-feed": () => ({ ok: false, reason: "no-stream" }),
    });
    await r.ear.open(OPEN);
    expect(await r.ear.feed({ pcm: PCM })).toEqual({
      ok: false,
      fallback: true,
      reason: "no-stream",
    });
    expect(r.gate.busy()).toBe(false);
    expect(r.ear.active()).toBe("");

    const dead = rig({
      "stream-open": openOk,
      "stream-feed": () => {
        throw new Error("STT worker exited");
      },
    });
    await dead.ear.open(OPEN);
    expect(await dead.ear.feed({ pcm: PCM })).toEqual({
      ok: false,
      fallback: true,
      reason: "worker",
    });
    expect(dead.gate.busy()).toBe(false);
  });
});

describe("stream-close", () => {
  it("finalizes by default, returns the final words and frees the gate", async () => {
    const r = rig({
      "stream-open": openOk,
      "stream-close": (p) => ({
        ok: true,
        op: "stream-close",
        streamId: p.streamId,
        final: true,
        text: "kal meeting hai",
        words: [{ text: "kal", startMs: 0, endMs: 200 }],
        audioMs: 1800,
        rtf: 0.21,
      }),
    });
    await r.ear.open({ ...OPEN, streamId: "u-3" });
    const out = await r.ear.close({ streamId: "u-3" });
    expect(out).toMatchObject({
      ok: true,
      streamId: "u-3",
      final: true,
      text: "kal meeting hai",
      audioMs: 1800,
      rtf: 0.21,
    });
    expect(out.words).toHaveLength(1);
    expect(r.calls.at(-1)?.payload).toMatchObject({ op: "stream-close", finalize: true });
    expect(r.gate.busy()).toBe(false);
    expect(r.timers.every((t) => t.cleared)).toBe(true);
  });

  it("finalize false drops the audio and still answers the full shape", async () => {
    const r = rig({
      "stream-open": openOk,
      "stream-close": () => ({ ok: true, op: "stream-close", final: false }),
    });
    await r.ear.open(OPEN);
    expect(await r.ear.close({ finalize: false })).toMatchObject({
      ok: true,
      final: false,
      text: "",
      words: [],
      audioMs: 0,
      rtf: 0,
    });
    expect(r.calls.at(-1)?.payload).toMatchObject({ finalize: false });
  });

  it("frees the gate even when the worker fails while closing", async () => {
    const r = rig({
      "stream-open": openOk,
      "stream-close": () => {
        throw new Error("STT worker timed out");
      },
    });
    await r.ear.open(OPEN);
    expect(await r.ear.close({})).toEqual({ ok: false, fallback: true, reason: "worker" });
    expect(r.gate.busy()).toBe(false);
  });

  it("closing with nothing open is a no-stream fallback, harmless twice", async () => {
    const r = rig({ "stream-open": openOk });
    expect(await r.ear.close({})).toEqual({ ok: false, fallback: true, reason: "no-stream" });
    await r.ear.open(OPEN);
    await r.ear.close({});
    expect(await r.ear.close({})).toMatchObject({ ok: false, reason: "no-stream" });
  });

  it("a final transcribe waits for a stream and runs the moment it closes", async () => {
    const r = rig({ "stream-open": openOk });
    await r.ear.open(OPEN);
    const next = r.gate.enter();
    await r.ear.close({});
    expect(typeof (await next)).toBe("function");
  });
});

describe("idle, mute and worker loss", () => {
  it("a stream nobody feeds is closed by the idle timer: audio dropped, gate freed", async () => {
    const r = rig({ "stream-open": openOk });
    await r.ear.open(OPEN);
    const armed = r.timers.filter((t) => !t.cleared);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.ms).toBe(15_000);
    armed[0]?.fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.gate.busy()).toBe(false);
    expect(r.ear.active()).toBe("");
    expect(r.calls.at(-1)?.payload).toMatchObject({ op: "stream-close", finalize: false });
  });

  it("abort (mute) drops the stream without finalizing; drop (worker gone) sends nothing", async () => {
    const r = rig({ "stream-open": openOk });
    await r.ear.open(OPEN);
    expect(r.ear.abort()).toBe(true);
    expect(r.gate.busy()).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.calls.at(-1)?.payload).toMatchObject({ op: "stream-close", finalize: false });
    expect(r.ear.abort()).toBe(false);
    await r.ear.open(OPEN);
    const sent = r.request.mock.calls.length;
    expect(r.ear.drop()).toBe(true);
    await Promise.resolve();
    expect(r.request.mock.calls.length).toBe(sent);
    expect(r.gate.busy()).toBe(false);
    expect(r.ear.active()).toBe("");
  });

  it("drop(session) only ends a stream that belongs to that worker", async () => {
    const r = rig({ "stream-open": openOk });
    await r.ear.open(OPEN);
    expect(r.ear.drop({ alive: false })).toBe(false);
    expect(r.ear.active()).not.toBe("");
    expect(r.ear.drop(r.session)).toBe(true);
  });
});

describe("wiring", () => {
  it("the module exports the calls and the engine list", () => {
    for (const name of ["streamOpen", "streamFeed", "streamClose", "createStreamEar"]) {
      expect(typeof stt[name]).toBe("function");
    }
    expect(stt.STREAM_ENGINES).toEqual(["off", "auto", "nemotron", "stream-ear-nemotron"]);
  });

  it("the live ear refuses off at once and answers no-stream with nothing open, never a throw", async () => {
    expect(await stt.streamOpen({ locale: "en" })).toEqual({
      ok: false,
      fallback: true,
      reason: "off",
    });
    expect(await stt.streamOpen(undefined)).toMatchObject({ reason: "off" });
    expect(await stt.streamFeed({ pcm: PCM })).toMatchObject({
      reason: "no-stream",
      fallback: true,
    });
    expect(await stt.streamClose({})).toMatchObject({ reason: "no-stream", fallback: true });
  });

  it("with no worker running, a requested engine is a worker fallback (no cold start)", async () => {
    expect(await stt.streamOpen({ streamEngine: "auto", locale: "hi" })).toEqual({
      ok: false,
      fallback: true,
      reason: "worker",
    });
  });

  it("main registers the three handlers, preload allowlists them, and the budget calls them quick", () => {
    const main = read("electron/main.cjs");
    for (const [channel, call] of [
      ["voice:stt-stream-open", "streamOpen"],
      ["voice:stt-stream-feed", "streamFeed"],
      ["voice:stt-stream-close", "streamClose"],
    ] as const) {
      expect(main).toContain(
        `ipcMain.handle("${channel}", (_e, payload) => stt.${call}(payload || {}));`,
      );
    }
    const preload = read("electron/preload.cjs");
    for (const [name, channel] of [
      ["openSttStream", "voice:stt-stream-open"],
      ["feedSttStream", "voice:stt-stream-feed"],
      ["closeSttStream", "voice:stt-stream-close"],
    ] as const) {
      expect(preload).toContain(
        `${name}: (payload) => ipcRenderer.invoke("${channel}", payload || {}),`,
      );
    }
    const table = req("../../electron/ipc-budget-table.cjs") as {
      CHANNEL_CLASS: Record<string, string>;
    };
    for (const channel of [
      "voice:stt-stream-open",
      "voice:stt-stream-feed",
      "voice:stt-stream-close",
    ]) {
      expect(table.CHANNEL_CLASS[channel]).toBe("quick");
    }
  });

  it("mute, shutdown, a crashed worker and idle release all end or protect an open stream", () => {
    const src = read("electron/stt.cjs");
    expect(src).toMatch(
      /function onMute\(muted\) \{\s*if \(!muted\) return \{ stopped: false \};\s*streamEar\.abort\(\);/,
    );
    expect(src).toMatch(
      /function shutdown\(session = worker\) \{\s*if \(worker === session\) streamEar\.drop\(session\);\s*onMute\(true\);/,
    );
    expect(src).toMatch(/session\.alive = false;\s*streamEar\.drop\(session\);/);
    expect(src).toMatch(/session\.pending\.size > 0 \|\| streamEar\.active\(\)\) return false;/);
  });

  it("the stream path is local only: no cloud engine, no microphone", () => {
    const src = read("electron/stt.cjs");
    const start = src.indexOf("function createStreamEar");
    const block = src.slice(start, src.indexOf("function snapshotStatus"));
    expect(block).not.toMatch(/cloudEngine|fetch\(|getUserMedia|navigator|https?:\/\//);
  });
});
