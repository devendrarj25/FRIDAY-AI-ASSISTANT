/**
 * Unexpected kernel crash must auto-restart with backoff, then give up.
 * Diagnostics "apply fix" still calls the same restartKernel() for a
 * broken environment that auto-recovery cannot heal.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const root = join(__dirname, "../..");
const requireCjs = createRequire(`${__dirname}/`);

type RestartEvent = {
  attempt?: number;
  attempts?: number;
  maxAttempts?: number;
  delayMs?: number;
  code?: number | null;
};

const { DELAYS_MS, STABLE_MS, MAX_ATTEMPTS, isUnexpectedExit, createKernelAutoRestart } =
  requireCjs("../../electron/kernel-auto-restart.cjs") as {
    DELAYS_MS: readonly number[];
    STABLE_MS: number;
    MAX_ATTEMPTS: number;
    isUnexpectedExit: (
      code: number | null,
      flags?: { shutdownStarted?: boolean; expectedStop?: boolean },
    ) => boolean;
    createKernelAutoRestart: (options: {
      restartKernel: () => Promise<unknown> | unknown;
      waitUntilReady: () => Promise<boolean> | boolean;
      delaysMs?: number[];
      stableMs?: number;
      setTimer?: (fn: () => void, ms: number) => unknown;
      clearTimer?: (id: unknown) => void;
      onAttempt?: (event: RestartEvent) => void;
      onRecovered?: (event: RestartEvent) => void;
      onGaveUp?: (event: RestartEvent) => void;
    }) => {
      onProcessExit: (
        code: number | null,
        ctx?: { shutdownStarted?: boolean },
      ) => { action: string; attempt?: number; delayMs?: number; attempts?: number };
      beginExpectedStop: () => void;
      endExpectedStop: () => void;
      noteManualRestart: () => void;
      waitIdle: () => Promise<unknown>;
      getState: () => { attempts: number; givenUp: boolean };
      getSequence: () => {
        action: string;
        attempt?: number;
        delayMs?: number;
        attempts?: number;
      }[];
    };
  };

const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function createClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { fn: () => void; due: number }>();
  return {
    now: () => now,
    setTimer(fn: () => void, ms: number) {
      const id = ++nextId;
      timers.set(id, { fn, due: now + Number(ms) });
      return id;
    },
    clearTimer(id: unknown) {
      timers.delete(Number(id));
    },
    async advance(ms: number) {
      now += ms;
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [id, timer] of [...timers]) {
          if (timer.due <= now) {
            timers.delete(id);
            timer.fn();
            progressed = true;
          }
        }
      }
    },
  };
}

describe("kernel auto-restart policy", () => {
  it("uses immediate, 2s, then 8s backoff and caps at three attempts", () => {
    expect(DELAYS_MS).toEqual([0, 2000, 8000]);
    expect(MAX_ATTEMPTS).toBe(3);
    expect(STABLE_MS).toBe(60_000);
  });

  it("treats only a non-zero numeric exit as unexpected", () => {
    expect(isUnexpectedExit(1)).toBe(true);
    expect(isUnexpectedExit(0)).toBe(false);
    expect(isUnexpectedExit(null)).toBe(false);
    expect(isUnexpectedExit(1, { shutdownStarted: true })).toBe(false);
    expect(isUnexpectedExit(1, { expectedStop: true })).toBe(false);
  });

  it("restarts immediately on an unexpected crash and clears failure on success", async () => {
    const clock = createClock();
    let restarts = 0;
    let failure = "The local AI service stopped (exit 1).";
    const attempts: { attempt: number; delayMs: number }[] = [];
    const auto = createKernelAutoRestart({
      restartKernel: async () => {
        restarts += 1;
      },
      waitUntilReady: async () => {
        failure = "";
        return true;
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onAttempt: (event) =>
        attempts.push({ attempt: event.attempt ?? 0, delayMs: event.delayMs ?? -1 }),
      onRecovered: () => {
        failure = "";
      },
    });

    const first = auto.onProcessExit(1);
    expect(first).toMatchObject({ action: "schedule", attempt: 1, delayMs: 0 });
    await clock.advance(0);
    await auto.waitIdle();

    expect(restarts).toBe(1);
    expect(attempts).toEqual([{ attempt: 1, delayMs: 0 }]);
    expect(auto.getSequence().map((e) => e.action)).toEqual(["schedule", "recovered"]);
    expect(failure).toBe("");
  });

  it("retries with the real backoff then gives up instead of looping", async () => {
    const clock = createClock();
    let restarts = 0;
    const attempts: { attempt: number; delayMs: number }[] = [];
    const gaveUp: { attempts: number; maxAttempts: number }[] = [];
    const auto = createKernelAutoRestart({
      restartKernel: async () => {
        restarts += 1;
      },
      waitUntilReady: async () => false,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onAttempt: (event) =>
        attempts.push({ attempt: event.attempt ?? 0, delayMs: event.delayMs ?? -1 }),
      onGaveUp: (event) =>
        gaveUp.push({
          attempts: event.attempts ?? 0,
          maxAttempts: event.maxAttempts ?? 0,
        }),
    });

    auto.onProcessExit(1);
    await clock.advance(0);
    await auto.waitIdle();
    expect(attempts).toEqual([
      { attempt: 1, delayMs: 0 },
      { attempt: 2, delayMs: 2000 },
    ]);

    await clock.advance(2000);
    await auto.waitIdle();
    expect(attempts).toEqual([
      { attempt: 1, delayMs: 0 },
      { attempt: 2, delayMs: 2000 },
      { attempt: 3, delayMs: 8000 },
    ]);

    await clock.advance(8000);
    await auto.waitIdle();
    expect(restarts).toBe(3);
    expect(gaveUp).toEqual([{ attempts: 3, maxAttempts: 3 }]);
    expect(auto.getState().givenUp).toBe(true);

    const after = auto.onProcessExit(1);
    expect(after.action).toBe("given-up");
    await clock.advance(30_000);
    await auto.waitIdle();
    expect(restarts).toBe(3);
    expect(attempts).toEqual([
      { attempt: 1, delayMs: 0 },
      { attempt: 2, delayMs: 2000 },
      { attempt: 3, delayMs: 8000 },
    ]);
  });

  it("recovers on a later attempt and keeps kernelFailure cleared", async () => {
    const clock = createClock();
    const readyAfter = 2;
    let calls = 0;
    let failure = "The local AI service stopped (exit 7).";
    const auto = createKernelAutoRestart({
      restartKernel: async () => {},
      waitUntilReady: async () => {
        calls += 1;
        const ok = calls >= readyAfter;
        if (ok) failure = "";
        return ok;
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onRecovered: () => {
        failure = "";
      },
    });

    auto.onProcessExit(7);
    await clock.advance(0);
    await auto.waitIdle();
    expect(failure).toBe("The local AI service stopped (exit 7).");

    await clock.advance(2000);
    await auto.waitIdle();
    expect(failure).toBe("");
    expect(auto.getSequence().map((e) => e.action)).toEqual(["schedule", "schedule", "recovered"]);
  });

  it("ignores a deliberate stop so Diagnostics apply-fix is not a crash loop", async () => {
    const clock = createClock();
    let restarts = 0;
    const auto = createKernelAutoRestart({
      restartKernel: async () => {
        restarts += 1;
      },
      waitUntilReady: async () => true,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    auto.beginExpectedStop();
    expect(auto.onProcessExit(1).action).toBe("ignore");
    auto.endExpectedStop();
    expect(auto.onProcessExit(0).action).toBe("ignore");
    expect(auto.onProcessExit(null).action).toBe("ignore");
    expect(auto.onProcessExit(1, { shutdownStarted: true }).action).toBe("ignore");
    await clock.advance(8000);
    expect(restarts).toBe(0);
  });

  it("lets a manual restart after give-up recover again", async () => {
    const clock = createClock();
    let restarts = 0;
    const auto = createKernelAutoRestart({
      restartKernel: async () => {
        restarts += 1;
      },
      waitUntilReady: async () => restarts >= 4,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    auto.onProcessExit(1);
    await clock.advance(0);
    await auto.waitIdle();
    await clock.advance(2000);
    await auto.waitIdle();
    await clock.advance(8000);
    await auto.waitIdle();
    expect(auto.getState().givenUp).toBe(true);
    expect(restarts).toBe(3);

    auto.noteManualRestart();
    expect(auto.getState().givenUp).toBe(false);
    auto.onProcessExit(1);
    await clock.advance(0);
    await auto.waitIdle();
    expect(restarts).toBe(4);
    expect(auto.getSequence().at(-1)?.action).toBe("recovered");
  });
});

describe("kernel auto-restart with a real child process", () => {
  const { spawn } = requireCjs("node:child_process") as typeof import("node:child_process");

  function startChild(script: string) {
    return new Promise<import("node:child_process").ChildProcess>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => resolve(child));
    });
  }

  async function waitUntilIdle(
    auto: ReturnType<typeof createKernelAutoRestart>,
    predicate: () => boolean,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      await auto.waitIdle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("respawns a dying child on the first attempt and reports recovered", async () => {
    let child = await startChild("setTimeout(() => process.exit(7), 40)");
    const auto = createKernelAutoRestart({
      delaysMs: [0, 40, 40],
      stableMs: 30_000,
      restartKernel: async () => {
        child = await startChild("setInterval(() => {}, 1000)");
      },
      waitUntilReady: async () => Boolean(child && child.exitCode === null && !child.killed),
    });

    await new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        auto.onProcessExit(code);
        resolve();
      });
    });
    await waitUntilIdle(auto, () => auto.getSequence().some((e) => e.action === "recovered"));
    expect(auto.getSequence().map((e) => e.action)).toEqual(["schedule", "recovered"]);
    expect(child.exitCode).toBeNull();
    child.kill();
  });

  it("gives up after three failed respawns of a crashing child", async () => {
    let child = await startChild("setTimeout(() => process.exit(9), 20)");
    const auto = createKernelAutoRestart({
      delaysMs: [0, 20, 20],
      stableMs: 30_000,
      restartKernel: async () => {
        child = await startChild("setTimeout(() => process.exit(9), 20)");
      },
      waitUntilReady: async () => {
        // Wait until the crash actually happens. A short fixed window races on
        // a loaded windows-latest runner (spawn can outlast the timeout and
        // look "ready", so givenUp never becomes true). If the child is still
        // alive after this wait, treat it as not-ready so the give-up path
        // can finish instead of reporting a false recovery.
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (!child || child.exitCode !== null || child.killed) return false;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      },
    });

    await new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        auto.onProcessExit(code);
        resolve();
      });
    });
    await waitUntilIdle(auto, () => auto.getState().givenUp);
    expect(auto.getState().givenUp).toBe(true);
    expect(auto.getSequence().filter((e) => e.action === "schedule")).toHaveLength(3);
    expect(auto.getSequence().at(-1)?.action).toBe("give-up");
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  });
});

describe("kernel auto-restart wiring", () => {
  const main = read("electron/main.cjs");
  const diagnostics = read("electron/diagnostics.cjs");
  const preload = read("electron/preload.cjs");

  it("hooks unexpected kernel.exit to the auto-restart controller", () => {
    expect(main).toContain('require("./kernel-auto-restart.cjs")');
    expect(main).toContain("kernelAuto?.onProcessExit(code, { shutdownStarted })");
    expect(main).toContain('restartKernel({ reason: "auto" })');
    expect(main).toContain('send("kernel:recover"');
    expect(main).toContain('phase: "recovered"');
    expect(main).toContain('phase: "failed"');
    expect(main).toContain("serviceHealth.invalidate()");
  });

  it("still uses restartKernel() as the Diagnostics apply-fix path", () => {
    expect(main).toContain(
      "diagnostics.applyFix(diagnosticsContext(), String(id), { restartKernel })",
    );
    expect(diagnostics).toContain('if (id === "kernel")');
    expect(diagnostics).toContain("helpers.restartKernel()");
    expect(diagnostics).toContain('say("kernel restart requested")');
  });

  it("exposes the recover notice on the existing preload toast path", () => {
    expect(preload).toContain('onKernelRecover: on("kernel:recover")');
    const desktop = read("src/lib/friday/desktop.ts");
    expect(desktop).toContain("onKernelRecover");
    expect(desktop).toContain('id: "kernel-recover"');
    expect(desktop).toContain("formatGuidance");
    expect(desktop).toContain("Open Setup & Doctor to repair it.");
  });

  it("attaches doctor owner steps when auto-restart gives up", () => {
    expect(main).toContain("kernelOwnerSteps()");
    expect(diagnostics).toContain("function kernelOwnerSteps");
    expect(diagnostics).toContain(
      "three times (immediately, then after 2 seconds, then after 8 seconds)",
    );
    expect(read("electron/kernel-auto-restart.cjs")).toContain("[0, 2000, 8000]");
    expect(read("electron/kernel-auto-restart.cjs")).toContain("MAX_ATTEMPTS = DELAYS_MS.length");
  });
});
