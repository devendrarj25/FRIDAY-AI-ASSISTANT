/**
 * Stop everything reaches the main process twice: a synchronous signal and the stored copy on a 400 ms delay. When the
 * main process refuses the signal (a destroyed window, a frame that is not the window's own page), only the stored copy
 * carries the stop, so it must not wait for the delay. A resume, or an accepted stop, keeps the delay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("a refused stop signal writes the stop to disk at once", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function install(answer: () => unknown) {
    const store = new Map<string, string>();
    const signalHalted = vi.fn(answer);
    const setState = vi.fn(async () => true);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
      friday: { signalHalted, setState },
    });
    return { signalHalted, setState };
  }
  const stop = { approvalLevel: "full", halted: true };
  const resume = { approvalLevel: "full", halted: false };

  it("flushes the stop when the signal answer is false", async () => {
    const { setState } = install(() => false);
    const { writeState } = await import("../../src/lib/friday/persist");
    writeState("friday.autonomy.v1", stop);
    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledWith("friday.autonomy.v1", stop);
    // The delayed write that was queued earlier does not send it a second time.
    await vi.advanceTimersByTimeAsync(1000);
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("flushes the stop when the bridge throws or gives no answer", async () => {
    for (const answer of [
      () => {
        throw new Error("no ipc");
      },
      () => undefined,
    ]) {
      vi.resetModules();
      const { setState } = install(answer);
      const { writeState } = await import("../../src/lib/friday/persist");
      writeState("friday.autonomy.v1", stop);
      expect(setState).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the short delay for an accepted stop and for a resume", async () => {
    const accepted = install(() => true);
    const { writeState } = await import("../../src/lib/friday/persist");
    writeState("friday.autonomy.v1", stop);
    expect(accepted.setState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(accepted.setState).toHaveBeenCalledTimes(1);

    const refusedResume = install(() => false);
    vi.resetModules();
    const again = await import("../../src/lib/friday/persist");
    again.writeState("friday.autonomy.v1", resume);
    expect(refusedResume.setState).not.toHaveBeenCalled();
  });

  it("another namespace never takes this path", async () => {
    const { setState, signalHalted } = install(() => false);
    const { writeState } = await import("../../src/lib/friday/persist");
    writeState("friday.brain.v1", { halted: true });
    expect(signalHalted).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });
});
