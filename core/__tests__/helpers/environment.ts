// Environment probes for tests that need something the machine may not have.
//
// These tests are real checks (a real page fetch, the real `netstat` binary),
// so they are not mocked. Instead they RUN where the thing exists and SKIP,
// visibly, where it does not (offline sandbox, minimal Linux image, zip export
// without .git). The weekly health workflow runs on a full runner, so they are
// exercised there.
import { spawnSync } from "node:child_process";

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
