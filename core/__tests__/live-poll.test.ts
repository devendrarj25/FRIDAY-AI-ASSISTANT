import { describe, expect, it } from "vitest";
import { backoffMs, createPoller, type PollerEnv } from "../../src/lib/friday/live-poll";

function fakeEnv() {
  let t = 0;
  let hidden = false;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  let visible: (() => void) | null = null;
  const env: PollerEnv = {
    now: () => t,
    setTimer: (fn, ms) => {
      const h = ++id;
      timers.set(h, { at: t + ms, fn });
      return h;
    },
    clearTimer: (h) => void timers.delete(h as number),
    hidden: () => hidden,
    onVisible: (fn) => {
      visible = fn;
      return () => {
        visible = null;
      };
    },
  };
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      t = Math.max(t, next[1].at);
      next[1].fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    t = end;
  };
  return {
    env,
    advance,
    timers,
    setHidden(v: boolean) {
      hidden = v;
      visible?.();
    },
    hasVisible: () => visible !== null,
  };
}

describe("shared poller", () => {
  it("backs off on failures up to 8x", () => {
    expect(backoffMs(1000, 0)).toBe(1000);
    expect(backoffMs(1000, 2)).toBe(4000);
    expect(backoffMs(1000, 9)).toBe(8000);
  });

  it("runs a shared key once per interval for every subscriber", async () => {
    const f = fakeEnv();
    const p = createPoller(f.env);
    let runs = 0;
    const seen: unknown[] = [];
    const offA = p.subscribe(
      "k",
      () => void runs++,
      1000,
      (e) => seen.push(e),
    );
    const offB = p.subscribe(
      "k",
      () => void runs++,
      1000,
      (e) => seen.push(e),
    );
    await f.advance(0);
    expect(runs).toBe(1);
    expect(seen).toHaveLength(2);
    await f.advance(1000);
    expect(runs).toBe(2);
    offA();
    offB();
    expect(p.size()).toBe(0);
    expect(f.timers.size).toBe(0);
    expect(f.hasVisible()).toBe(false);
  });

  it("does not run while hidden and catches up when visible again", async () => {
    const f = fakeEnv();
    const p = createPoller(f.env);
    let runs = 0;
    p.subscribe("k", () => void runs++, 1000);
    await f.advance(0);
    f.setHidden(true);
    expect(f.timers.size).toBe(0);
    await f.advance(10_000);
    expect(runs).toBe(1);
    f.setHidden(false);
    await f.advance(0);
    expect(runs).toBe(2);
  });

  it("backs off after a failure, reports it, and recovers", async () => {
    const f = fakeEnv();
    const p = createPoller(f.env);
    let ok = false;
    let runs = 0;
    const results: boolean[] = [];
    p.subscribe(
      "k",
      () => {
        runs++;
        if (!ok) throw new Error("down");
      },
      1000,
      (e) => results.push(e === null),
    );
    await f.advance(0);
    expect(results).toEqual([false]);
    await f.advance(1000);
    expect(runs).toBe(1); // next try is at 2000 after one failure
    await f.advance(1000);
    expect(runs).toBe(2);
    ok = true;
    await f.advance(4000);
    expect(results.at(-1)).toBe(true);
  });

  it("refresh runs the job now", async () => {
    const f = fakeEnv();
    const p = createPoller(f.env);
    let runs = 0;
    p.subscribe("k", () => void runs++, 60_000, undefined, false);
    await p.refresh("k");
    expect(runs).toBe(1);
  });
});
