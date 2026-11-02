/**
 * A second transcription waits for the first instead of being refused (the utterance it carried was lost).
 * Only a real backlog or a very long wait is refused, and then with the same "busy" answer callers already handle.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const stt = require("../../electron/stt.cjs");

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
  // A real child process, never a made-up pid: on Windows the stop goes through taskkill by pid.
  function sleeper() {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    return { child, session: { alive: true, pending: new Map(), child } };
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function until(check: () => boolean, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
  }

  it("stops a worker that misses its deadline instead of leaking it", async () => {
    const { child, session } = sleeper();
    try {
      expect(await until(() => alive(child.pid!))).toBe(true);
      await expect(stt.workerRequest(session, { op: "transcribe" }, 300)).rejects.toThrow(
        "STT worker timed out",
      );
      expect(session.pending.size).toBe(0);
      expect(await until(() => !alive(child.pid!))).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("leaves a worker that answered in time alone", async () => {
    const { child, session } = sleeper();
    try {
      const request = stt.workerRequest(session, { op: "status" }, 600);
      const [wait] = [...session.pending.values()] as Array<{ resolve: (m: unknown) => void }>;
      wait!.resolve({ ok: true });
      expect(await request).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(alive(child.pid!)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
