/**
 * Node.js and npm run `npm run setup`, so a newer release cannot be installed from inside it. Setup starts a hidden
 * helper that waits for the npm command to end and then installs it; Doctor, the build and the next setup wait for
 * that helper, because Node.js or npm half-replaced under a running command breaks it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const upgrade = require_("../../scripts/running-tools-upgrade.cjs") as {
  MAX_WAIT_MS: number;
  pending: (file: string, o?: { now?: number; isAlive?: (pid: number) => boolean }) => number;
  waitForPending: (o: {
    file: string;
    log: (line: string) => void;
    isAlive: (pid: number) => boolean;
    wait: (ms: number) => void;
    now: () => number;
  }) => boolean;
};
const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const lockWith = (text: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-lock-"));
  temp.push(dir);
  const file = path.join(dir, "upgrade.lock");
  writeFileSync(file, text);
  return file;
};

describe("the update helper's lock", () => {
  it("reports a live helper and removes a stale lock, an old one and a damaged one", () => {
    const live = lockWith("4242");
    expect(upgrade.pending(live, { isAlive: () => true })).toBe(4242);
    expect(existsSync(live)).toBe(true);

    const gone = lockWith("4242");
    expect(upgrade.pending(gone, { isAlive: () => false })).toBe(0);
    expect(existsSync(gone)).toBe(false);

    const old = lockWith("4242");
    const longAgo = new Date(Date.now() - upgrade.MAX_WAIT_MS - 60_000);
    utimesSync(old, longAgo, longAgo);
    expect(upgrade.pending(old, { isAlive: () => true })).toBe(0);
    expect(existsSync(old)).toBe(false);

    const damaged = lockWith("not a pid");
    expect(upgrade.pending(damaged, { isAlive: () => true })).toBe(0);
    expect(upgrade.pending(path.join(tmpdir(), "friday-no-such-lock"))).toBe(0);
  });

  it("waits while the helper runs, says so once, and returns when it ends", () => {
    const file = lockWith("4242");
    let alive = true;
    let clock = Date.now();
    const lines: string[] = [];
    const waited = upgrade.waitForPending({
      file,
      log: (line) => lines.push(line),
      isAlive: () => alive,
      wait: (ms) => {
        clock += ms;
        if (clock > Date.now() + 3000) alive = false;
      },
      now: () => clock,
    });
    expect(waited).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("still running");
    const none = upgrade.waitForPending({
      file: path.join(tmpdir(), "friday-no-such-lock"),
      log: () => expect.fail("nothing to wait for"),
      isAlive: () => true,
      wait: () => {},
      now: Date.now,
    });
    expect(none).toBe(false);
  });
});
