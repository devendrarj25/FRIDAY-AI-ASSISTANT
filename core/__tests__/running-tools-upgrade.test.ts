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
  reportResult: (o: { file: string; log: (line: string) => void }) => string[];
  waitForPending: (o: {
    file: string;
    result?: string;
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
      result: path.join(tmpdir(), "friday-no-such-result"),
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
      result: path.join(tmpdir(), "friday-no-such-result"),
      log: () => expect.fail("nothing to wait for"),
      isAlive: () => true,
      wait: () => {},
      now: Date.now,
    });
    expect(none).toBe(false);
  });
});

describe("the update helper's result", () => {
  it("says once that an update took effect, and removes the result", () => {
    const file = lockWith("Node.js|26.5.1|26.13.1|0|26.13.1\r\nnpm|12.2.3|12.4.0|0|12.4.0\r\n");
    const lines: string[] = [];
    upgrade.reportResult({ file, log: (line) => lines.push(line) });
    expect(lines).toEqual([
      "[friday] ok       Node.js was updated from 26.5.1 to 26.13.1 after the last setup",
      "[friday] ok       npm was updated from 12.2.3 to 12.4.0 after the last setup",
    ]);
    expect(existsSync(file)).toBe(false);
    expect(upgrade.reportResult({ file, log: () => expect.fail("said twice") })).toEqual([]);
  });

  it("names the exit code, the version that still answers and the one command when an update did not take effect", () => {
    // The owner's PC on 2026-11-20: Node.js 26.5.1 stayed after setup promised 26.13.1.
    const file = lockWith("Node.js|26.5.1|26.13.1|-1978335212|26.5.1\n");
    const lines: string[] = [];
    upgrade.reportResult({ file, log: (line) => lines.push(line) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("WARN");
    expect(lines[0]).toContain("Node.js 26.13.1 update after the last setup did not take effect");
    expect(lines[0]).toContain("exit code -1978335212");
    expect(lines[0]).toContain("Node.js answers 26.5.1");
    expect(lines[0]).toContain("winget upgrade --id OpenJS.NodeJS.LTS --exact --include-unknown");
    expect(lines[0]).toContain("friday-running-tools-upgrade.log");
    expect(existsSync(file)).toBe(false);
  });

  it("reports the result after waiting, and also when the helper had already ended", () => {
    const result = lockWith("npm|12.2.3|12.4.0|1|\n");
    const lines: string[] = [];
    const waited = upgrade.waitForPending({
      file: path.join(tmpdir(), "friday-no-such-lock"),
      result,
      log: (line) => lines.push(line),
      isAlive: () => true,
      wait: () => {},
      now: Date.now,
    });
    expect(waited).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("npm answers nothing");
    expect(lines[0]).toContain("npm install --global npm@latest");
  });

  it("compares versions by number, not by text", () => {
    const at = (upgrade as unknown as { atLeast: (a: string, b: string) => boolean }).atLeast;
    expect(at("26.13.1", "26.9.0")).toBe(true);
    expect(at("26.5.1", "26.13.1")).toBe(false);
    expect(at("26.13.1", "26.13.1")).toBe(true);
    expect(at("", "1.0.0")).toBe(false);
  });
});
