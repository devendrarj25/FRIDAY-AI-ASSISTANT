/**
 * A provisional (speculative) speech decode can be cancelled without killing the worker, never queues behind a
 * final one, and only the cancel jumps the line.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const stt = createRequire(import.meta.url)("../../electron/stt.cjs");

function fakeSession() {
  const writes: string[] = [];
  const kill = vi.fn();
  return {
    writes,
    kill,
    session: {
      alive: true,
      loaded: true,
      pending: new Map(),
      child: {
        pid: 4242,
        kill,
        stdin: { destroyed: false, write: (line: string) => writes.push(line) },
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("the turn gate", () => {
  it("tryEnter takes the gate only when it is free and never queues", async () => {
    const gate = stt.createTurnGate();
    const first = gate.tryEnter();
    expect(typeof first).toBe("function");
    expect(gate.busy()).toBe(true);
    expect(gate.tryEnter()).toBeNull();
    expect(gate.waiting()).toBe(0);
    first();
    first(); // a second release is harmless
    expect(gate.busy()).toBe(false);
    expect(typeof gate.tryEnter()).toBe("function");
  });

  it("a waiting final keeps its place: a provisional never takes it", async () => {
    const gate = stt.createTurnGate();
    const running = await gate.enter();
    const waiting = gate.enter();
    expect(gate.tryEnter()).toBeNull();
    running();
    const next = await waiting;
    expect(typeof next).toBe("function");
    expect(gate.tryEnter()).toBeNull();
  });
});

describe("running a provisional decode", () => {
  it("answers busy at once while a final decode holds the worker", async () => {
    const gate = stt.createTurnGate();
    const release = await gate.enter();
    const run = vi.fn();
    const out = await stt.runProvisional({ provisional: true, utteranceId: "p-1" }, run, gate);
    expect(out).toMatchObject({ ok: false, reason: "busy" });
    expect(run).not.toHaveBeenCalled();
    release();
  });

  it("returns the not-final answer and frees the gate", async () => {
    const gate = stt.createTurnGate();
    const out = await stt.runProvisional(
      { provisional: true, utteranceId: "p-2" },
      async () => ({ ok: true, text: "open chrome", audio: { durationMs: 1800 } }),
      gate,
    );
    expect(out).toMatchObject({ ok: true, final: false, audioMs: 1800, utteranceId: "p-2" });
    expect(gate.busy()).toBe(false);
  });

  it("a cancel while it runs signals the worker once, keeps the worker alive, and the answer is cancelled", async () => {
    const gate = stt.createTurnGate();
    const { session, writes, kill } = fakeSession();
    const slow = deferred<Record<string, unknown>>();
    const decoding = stt.runProvisional(
      { provisional: true, utteranceId: "p-3" },
      () => slow.promise,
      gate,
    );
    const answer = stt.cancelTranscribe({ utteranceId: "p-3" }, session);
    expect(answer).toMatchObject({ ok: true, cancelled: true, signalled: true });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] as string)).toEqual({ op: "cancel", utteranceId: "p-3" });
    expect(session.pending.size).toBe(0);
    // the decode finished just before the cancel landed: the text is still thrown away
    slow.resolve({ ok: true, text: "open chrome" });
    const out = await decoding;
    expect(out).toMatchObject({
      ok: false,
      reason: "cancelled",
      cancelled: true,
      final: false,
      utteranceId: "p-3",
    });
    expect(out).not.toHaveProperty("text");
    expect(kill).not.toHaveBeenCalled();
    expect(gate.busy()).toBe(false);
  });

  it("a worker that reports its own cancel is passed through as cancelled", async () => {
    const out = await stt.runProvisional(
      { provisional: true, utteranceId: "p-4" },
      async () => ({ ok: false, reason: "cancelled" }),
      stt.createTurnGate(),
    );
    expect(out).toMatchObject({ ok: false, reason: "cancelled", cancelled: true });
  });

  it("the cancel does not wait for the gate: a final queued behind the provisional goes next", async () => {
    const gate = stt.createTurnGate();
    const { session } = fakeSession();
    const slow = deferred<Record<string, unknown>>();
    const decoding = stt.runProvisional(
      { provisional: true, utteranceId: "p-5" },
      () => slow.promise,
      gate,
    );
    const finalWait = gate.enter();
    stt.cancelTranscribe({ utteranceId: "p-5" }, session);
    slow.resolve({ ok: false, reason: "cancelled" });
    await decoding;
    expect(typeof (await finalWait)).toBe("function");
  });

  it("a cancel with nothing in flight (or for another utterance) writes nothing", () => {
    const { session, writes } = fakeSession();
    expect(stt.cancelTranscribe({ utteranceId: "gone" }, session)).toMatchObject({
      ok: true,
      cancelled: false,
      signalled: false,
    });
    expect(stt.cancelTranscribe({}, session)).toMatchObject({ cancelled: false });
    expect(writes).toHaveLength(0);
  });

  it("a cancel with no worker or a dead one still flags the decode and never throws", async () => {
    const gate = stt.createTurnGate();
    const slow = deferred<Record<string, unknown>>();
    const decoding = stt.runProvisional(
      { provisional: true, utteranceId: "p-6" },
      () => slow.promise,
      gate,
    );
    const dead = { alive: false, child: null, pending: new Map() };
    expect(stt.cancelTranscribe({ utteranceId: "p-6" }, dead)).toMatchObject({
      cancelled: true,
      signalled: false,
    });
    slow.resolve({ ok: true, text: "x" });
    expect(await decoding).toMatchObject({ reason: "cancelled" });
  });

  it("an utterance id that is not a plain token is dropped, and an empty cancel flags every provisional", async () => {
    const gate = stt.createTurnGate();
    const { session, writes } = fakeSession();
    const slow = deferred<Record<string, unknown>>();
    const decoding = stt.runProvisional(
      { provisional: true, utteranceId: "bad id\n{" },
      () => slow.promise,
      gate,
    );
    expect(stt.cancelTranscribe({ utteranceId: "bad id\n{" }, session)).toMatchObject({
      cancelled: true,
    });
    expect(JSON.parse(writes[0] as string)).toEqual({ op: "cancel", utteranceId: "" });
    slow.resolve({ ok: true, text: "x" });
    expect(await decoding).toMatchObject({ reason: "cancelled" });
  });

  it("a thrown decode frees the gate and forgets the utterance", async () => {
    const gate = stt.createTurnGate();
    await expect(
      stt.runProvisional(
        { provisional: true, utteranceId: "p-7" },
        async () => {
          throw new Error("boom");
        },
        gate,
      ),
    ).rejects.toThrow("boom");
    expect(gate.busy()).toBe(false);
    const { session, writes } = fakeSession();
    expect(stt.cancelTranscribe({ utteranceId: "p-7" }, session).cancelled).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

describe("the worker request carries the utterance id", () => {
  it("decodeExtras keeps a clean id for a provisional pass only", () => {
    expect(stt.decodeExtras({ provisional: true, utteranceId: "p-9" })).toEqual({
      provisional: true,
      utteranceId: "p-9",
    });
    expect(stt.decodeExtras({ utteranceId: "p-9" })).toEqual({});
    expect(stt.decodeExtras({ provisional: true, utteranceId: "a b" })).toEqual({
      provisional: true,
    });
  });
});

describe("an early read never leaves this PC", () => {
  it("is refused for any engine but the local speech worker, and when no worker is loaded", async () => {
    const source = readFileSync("electron/stt.cjs", "utf8").replace(/\r\n/g, "\n");
    expect(source).toMatch(
      /if \(req\.provisional === true && state\.engine !== "faster-whisper"\) \{\s*return \{ ok: false, reason: "not-ready"/,
    );
    expect(source).toMatch(
      /worker\?\.alive && worker\.loaded\s*\?\s*transcribeNow\(r, onPartial\)/,
    );
    // no worker at all: the answer is "not-ready" at once, nothing is started
    const out = await stt.transcribe({
      provisional: true,
      utteranceId: "p-x",
      audioBytes: new Uint8Array(4),
    });
    expect(out).toMatchObject({ ok: false, reason: "not-ready" });
  });
});
