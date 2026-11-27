/**
 * The main process learns "Stop everything" twice: a synchronous signal from the FRIDAY window and the stored autonomy
 * file that follows on a short delay. The signal bridges that delay and nothing more: it ends once the file agrees or
 * the write window has passed, a stored value that is not a plain record with a boolean `halted` is an unreadable
 * state (halted), and an unreadable state is never opened by a resume signal. Time is a counter, never the wall clock.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const gate = createRequire(import.meta.url)("../../electron/tool-gate.cjs") as {
  UNREADABLE: symbol;
  createAutonomyReader: (
    readStored: () => unknown,
    options?: { now?: () => number; windowMs?: number },
  ) => {
    read: () => { dial: string; halted: boolean };
    signalHalted: (value: unknown) => boolean;
  };
};

const WINDOW = 1000;
const open = { approvalLevel: "full", halted: false };
const stopped = { approvalLevel: "full", halted: true };

function rig(initial: unknown) {
  const clock = { t: 0 };
  const disk = { value: initial as unknown };
  const reader = gate.createAutonomyReader(() => disk.value, {
    now: () => clock.t,
    windowMs: WINDOW,
  });
  return { clock, disk, reader };
}

describe("a stored value that is not a plain record with a boolean halted is unreadable", () => {
  it.each([
    ["an array", []],
    ["a string", "halted"],
    ["a number", 7],
    ["halted as a string", { approvalLevel: "full", halted: "true" }],
    ["halted as a number", { approvalLevel: "full", halted: 1 }],
    ["halted as null", { approvalLevel: "full", halted: null }],
  ])("%s reads as stopped", (_name, stored) => {
    const { reader } = rig(stored);
    expect(reader.read().halted).toBe(true);
  });

  it("a record with no halted at all is still the shipped open state", () => {
    expect(rig({ approvalLevel: "ask" }).reader.read()).toEqual({ dial: "ask", halted: false });
  });

  it("a resume signal never opens an unreadable state", () => {
    for (const bad of [gate.UNREADABLE, [], "x", { halted: "false" }]) {
      const { reader } = rig(bad);
      reader.signalHalted(false);
      expect(reader.read().halted).toBe(true);
    }
  });
});

describe("the signal ends when the stored file agrees or the write window passes", () => {
  it("a resume signal holds inside the window while the file still says stopped", () => {
    const { reader, clock } = rig(stopped);
    reader.signalHalted(false);
    clock.t = WINDOW - 1;
    expect(reader.read().halted).toBe(false);
  });

  it("after the window a resume signal no longer outranks a file that still says stopped", () => {
    const { reader, clock } = rig(stopped);
    reader.signalHalted(false);
    clock.t = WINDOW + 1;
    expect(reader.read().halted).toBe(true);
  });

  it("once the file agrees with a resume, a later change of the file by restore or rollback is read as it is", () => {
    const { reader, disk } = rig(stopped);
    reader.signalHalted(false);
    disk.value = open;
    expect(reader.read().halted).toBe(false);
    disk.value = stopped;
    expect(reader.read().halted).toBe(true);
  });

  it("once the file agrees with a stop, a later restore that opens the file is not held stopped", () => {
    const { reader, disk } = rig(open);
    reader.signalHalted(true);
    expect(reader.read().halted).toBe(true);
    disk.value = stopped;
    expect(reader.read().halted).toBe(true);
    disk.value = open;
    expect(reader.read().halted).toBe(false);
  });

  it("a stop whose write never landed keeps FRIDAY stopped: the file is unchanged, so the window does not open it", () => {
    const { reader, clock } = rig(open);
    reader.signalHalted(true);
    clock.t = WINDOW * 50;
    expect(reader.read().halted).toBe(true);
  });

  it("a stop is released when the file itself changed to open after the window", () => {
    const { reader, clock, disk } = rig(stopped);
    reader.signalHalted(true);
    clock.t = WINDOW + 1;
    disk.value = open;
    expect(reader.read().halted).toBe(false);
  });

  it("inside the window a stop outranks a file that has not caught up", () => {
    const { reader, clock } = rig(open);
    reader.signalHalted(true);
    clock.t = WINDOW - 1;
    expect(reader.read().halted).toBe(true);
  });
});

describe("any sequence of signals and file states: an unreadable file is never open", () => {
  // A small deterministic generator (no Math.random), so a failing sequence reproduces.
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }
  const states: unknown[] = [
    open,
    stopped,
    null,
    gate.UNREADABLE,
    [],
    "text",
    { halted: "true" },
    { approvalLevel: "full", halted: 0 },
  ];

  it("holds over 400 random runs of 40 steps", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = lcg(seed);
      const { reader, clock, disk } = rig(open);
      for (let step = 0; step < 40; step += 1) {
        const pick = next();
        if (pick < 0.3) {
          reader.signalHalted(next() < 0.5);
        } else if (pick < 0.6) {
          disk.value = states[Math.floor(next() * states.length)];
        } else if (pick < 0.8) {
          clock.t += Math.floor(next() * WINDOW * 2);
        }
        // The file as it is right now decides whether it is unreadable.
        const now = disk.value;
        const bad =
          now === gate.UNREADABLE ||
          Array.isArray(now) ||
          typeof now === "string" ||
          (now !== null &&
            typeof now === "object" &&
            "halted" in (now as object) &&
            typeof (now as { halted?: unknown }).halted !== "boolean");
        const seen = reader.read().halted;
        if (bad) expect(seen, `seed ${seed} step ${step}`).toBe(true);
      }
    }
  });

  it("a stop signal read at once is always stopped, whatever the file says", () => {
    for (const value of states) {
      const { reader, disk } = rig(open);
      disk.value = value;
      reader.signalHalted(true);
      expect(reader.read().halted).toBe(true);
    }
  });
});
