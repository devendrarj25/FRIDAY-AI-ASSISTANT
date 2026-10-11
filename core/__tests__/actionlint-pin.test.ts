/**
 * The workflow linter downloads pinned archives and refuses a bad hash.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const lint = require_(path.resolve(__dirname, "../../scripts/run-actionlint.cjs")) as {
  PINS: {
    actionlint: { version: string; linux: { sha256: string }; win32: { sha256: string } };
    shellcheck: { version: string; linux: { sha256: string }; win32: { sha256: string } };
  };
  assertSha256: (file: string, expected: string) => string;
  cachedBinary: (home: string, name: string) => string | null;
};

describe("actionlint pin", () => {
  it("records the hashed actionlint 1.7.12 and shellcheck 0.11.0 archives", () => {
    expect(lint.PINS.actionlint.version).toBe("1.7.12");
    expect(lint.PINS.actionlint.linux.sha256).toBe(
      "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    );
    expect(lint.PINS.actionlint.win32.sha256).toBe(
      "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
    );
    expect(lint.PINS.shellcheck.version).toBe("0.11.0");
    expect(lint.PINS.shellcheck.linux.sha256).toBe(
      "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198",
    );
    expect(lint.PINS.shellcheck.win32.sha256).toBe(
      "8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e",
    );
  });

  it("treats a missing cache directory as a download, not a crash", () => {
    const missing = path.join(tmpdir(), "friday-lint-missing", "no-such-cache");
    expect(lint.cachedBinary(missing, "actionlint")).toBeNull();
  });

  it("refuses an archive whose SHA-256 does not match the pin", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-lint-hash-"));
    const file = path.join(dir, "archive.bin");
    writeFileSync(file, "not-the-archive");
    expect(() => lint.assertSha256(file, "ab".repeat(32))).toThrow(/SHA-256/);
  });
});
