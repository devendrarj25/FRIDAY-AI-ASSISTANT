// Environment probes for tests that need something the machine may not have.
//
// These tests are real checks (a real page fetch, the real `netstat` binary),
// so they are not mocked. Instead they RUN where the thing exists and SKIP,
// visibly, where it does not (offline sandbox, minimal Linux image, zip export
// without .git). The weekly health workflow runs on a full runner, so they are
// exercised there.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** True when https://example.com answers within 4 seconds. */
export async function isOnline(url = "https://example.com/"): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** True when `command` can be started on this machine. */
export function hasCommand(command: string): boolean {
  const probe = spawnSync(command, ["-h"], { stdio: "ignore", timeout: 4000 });
  return !(probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT");
}

/**
 * True when `filePath` exists and is a regular file.
 * Callers run the check when this is true and record a visible skip when it is false.
 */
export function hasFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}
