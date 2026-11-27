/**
 * A second transcription waits for the first instead of being refused (the utterance it carried was lost).
 * Only a real backlog or a very long wait is refused, and then with the same "busy" answer callers already handle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { healthyReplies, installFakeWorker, settle } from "./helpers/fake-stt-worker";

const require = createRequire(import.meta.url);
const stt = require("../../electron/stt.cjs");

describe("the streaming ear and the turn gate", () => {
  it("a stream holds the gate from open to close, so a final decode waits and a probe is refused", async () => {
    const gate = stt.createTurnGate();
    const session = { alive: true };
    const ear = stt.createStreamEar({
      gate,
      getWorker: () => session,
      request: async (_s: unknown, payload: { op: string; streamId: string }) => ({
        ok: true,
        op: payload.op,
        streamId: payload.streamId,
        final: true,
      }),
      setTimer: () => ({}),
      clearTimer: () => {},
    });
    expect((await ear.open({ streamEngine: "auto", locale: "en", streamId: "t" })).ok).toBe(true);
    expect(gate.tryEnter()).toBeNull();
    const finalDecode = gate.enter();
    expect(gate.waiting()).toBe(1);
    await ear.close({ streamId: "t" });
    expect(typeof (await finalDecode)).toBe("function");
  });
});

describe("speech transcription turn gate", () => {
  it("lets one run, queues the next in order and starts it when the first leaves", async () => {
    const gate = stt.createTurnGate();
    const order: string[] = [];
    const first = await gate.enter();
    expect(typeof first).toBe("function");
    expect(gate.busy()).toBe(true);

    const second = gate.enter().then((release: (() => void) | null) => {
      order.push("second");
      return release;
    });
    const third = gate.enter().then((release: (() => void) | null) => {
      order.push("third");
      return release;
    });
    expect(gate.waiting()).toBe(2);
    await Promise.resolve();
    expect(order).toEqual([]);

    first!();
    const secondRelease = await second;
    expect(order).toEqual(["second"]);
    secondRelease!();
    const thirdRelease = await third;
    expect(order).toEqual(["second", "third"]);
    thirdRelease!();
    expect(gate.busy()).toBe(false);
    expect(gate.waiting()).toBe(0);
  });

  it("refuses only a real backlog, and a release called twice frees one slot, not two", async () => {
    const gate = stt.createTurnGate({ maxWaiting: 1 });
    const held = await gate.enter();
    const waiter = gate.enter();
    expect(await gate.enter()).toBeNull();
    held!();
    held!();
    const next = await waiter;
    expect(typeof next).toBe("function");
    expect(gate.busy()).toBe(true);
    next!();
    expect(gate.busy()).toBe(false);
  });

  it("gives up on a wait that runs out and leaves the queue clean", async () => {
    const timers: Array<() => void> = [];
    const gate = stt.createTurnGate({
      waitMs: 10,
      setTimer: (fn: () => void) => {
        timers.push(fn);
        return 0;
      },
      clearTimer: () => {},
    });
    const held = await gate.enter();
    const waiter = gate.enter();
    expect(gate.waiting()).toBe(1);
    timers[0]!();
    expect(await waiter).toBeNull();
    expect(gate.waiting()).toBe(0);
    held!();
    expect(gate.busy()).toBe(false);
  });
});

describe("speech worker deadline", () => {
  const WAV = new Uint8Array(64);
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => {
    stt.useForTests();
    vi.useRealTimers();
  });

  it("stops a worker that misses its deadline instead of leaking it", async () => {
    const r = installFakeWorker(stt);
    r.control.respond = (msg, child) =>
      msg.op === "transcribe" && child === r.children[0] ? undefined : healthyReplies(msg);
    const turn = stt.transcribe({ audioBytes: WAV, localOnly: true });
    await settle();
    expect(r.sent("transcribe")).toHaveLength(1);
    expect(r.killTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(r.killTree).toHaveBeenCalledWith(r.children[0]);
    // The turn is answered by a fresh child; the hung one is gone, not left holding its model.
    expect(await turn).toMatchObject({ ok: true, text: "hello" });
    expect(r.children).toHaveLength(2);
    expect(r.killTree).toHaveBeenCalledTimes(1);
  });

  it("leaves a worker that answered in time alone", async () => {
    const r = installFakeWorker(stt);
    expect(await stt.transcribe({ audioBytes: WAV, localOnly: true })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(r.killTree).not.toHaveBeenCalled();
    expect(r.children).toHaveLength(1);
  });
});
