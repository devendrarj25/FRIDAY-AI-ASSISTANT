/**
 * Temporary directories with the Windows retry Node already applies to
 * EBUSY, EPERM, EMFILE, ENFILE, and ENOTEMPTY.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEMP_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
} as const;

export function makeTemp(prefix = "friday-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTemp(dir: string): void {
  fs.rmSync(dir, TEMP_RM_OPTIONS);
}
