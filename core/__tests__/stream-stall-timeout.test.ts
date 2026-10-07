/**
 * A provider (or the kernel itself) can accept a request and then go silent.
 * Before this guard the shared httpx client had unlimited read/write timeouts
 * and the IPC bridge had only a fixed total deadline, so a stalled stream could
 * hang forever and FRIDAY would simply never speak again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

type Stall = { kind: string; ms: number; message: string };
type Watchdog = { beat: () => void; stop: () => void };
const requireCjs = createRequire(`${__dirname}/`);
const { createStallWatchdog } = requireCjs("../../electron/stream-watchdog.cjs") as {
  createStallWatchdog: (
    onStall: (stall: Stall) => void,
    options?: { firstByteMs?: number; idleMs?: number },
  ) => Watchdog;
};

const root = join(__dirname, "..", "..");
const router = readFileSync(join(root, "kernel", "router.py"), "utf8");

describe("kernel HTTP client deadlines", () => {
  it("keeps the 20s connect timeout and adds a finite idle read timeout", () => {
    expect(router).toMatch(/CONNECT_TIMEOUT_SECONDS = 20\.0/);
    expect(router).toMatch(/READ_TIMEOUT_SECONDS = 120\.0/);
    expect(router).toMatch(/read=READ_TIMEOUT_SECONDS/);
    expect(router).toMatch(/write=WRITE_TIMEOUT_SECONDS/);
    expect(router).toMatch(/pool=POOL_TIMEOUT_SECONDS/);
    // No route may fall back to the old unlimited-everything client.
    expect(router).not.toMatch(/httpx\.Timeout\(None, connect=20\.0\)/);
  });

  it("reports timeouts through the same named-failure path as other errors", () => {
    expect(router).toMatch(/def describe_failure/);
    expect(router.match(/describe_failure\(model, exc\)/g)?.length).toBe(3);
  });
});

describe("chat.stream IPC stall watchdog", () => {
  it("reports a real error when nothing ever arrives", async () => {
    const failures: string[] = [];
    createStallWatchdog((s: Stall) => failures.push(s.message), {
      firstByteMs: 20,
      idleMs: 40,
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/timeout/i);
    expect(failures[0]).toMatch(/never answered/);
  });

  it("reports a stall after the stream starts and then goes silent", async () => {
    const failures: string[] = [];
    const wd = createStallWatchdog((s: Stall) => failures.push(s.message), {
      firstByteMs: 200,
      idleMs: 30,
    });
    wd.beat();
    await new Promise((r) => setTimeout(r, 60));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/stalled/);
  });

  it("never cuts off a slow but alive generation", async () => {
    const failures: string[] = [];
    const wd = createStallWatchdog((s: Stall) => failures.push(s.message), {
      firstByteMs: 200,
      idleMs: 40,
    });
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      wd.beat();
    }
    expect(failures).toEqual([]);
    wd.stop();
  });

  it("fires only once and stops cleanly", async () => {
    const failures: string[] = [];
    const wd = createStallWatchdog((s: Stall) => failures.push(s.message), {
      firstByteMs: 10,
      idleMs: 10,
    });
    await new Promise((r) => setTimeout(r, 40));
    wd.beat();
    await new Promise((r) => setTimeout(r, 40));
    expect(failures).toHaveLength(1);
  });
});
