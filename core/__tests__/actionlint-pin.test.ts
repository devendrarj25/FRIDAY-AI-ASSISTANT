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
  actionlintArguments: (shellcheck: string, platform?: string) => string[];
  sanitizeExpressions: (src: string) => string;
  shellScriptsFromWorkflow: (doc: unknown) => { shell: string; source: string }[];
  shellcheckFindings: (
    shellcheck: string,
    scripts: { shell: string; source: string; file?: string }[],
    spawnImpl?: (
      cmd: string,
      args: string[],
      opts: { input: string },
    ) => { status: number | null; stdout?: string; stderr?: string; error?: Error },
  ) => string[];
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

  it("does not let actionlint write shellcheck stdin on Windows", () => {
    const linux = lint.actionlintArguments("/opt/shellcheck", "linux");
    expect(linux).toContain("-shellcheck");
    expect(linux).toContain("/opt/shellcheck");
    const windows = lint.actionlintArguments("/opt/shellcheck", "win32");
    expect(windows[0]).toBe("-shellcheck=");
    expect(windows).not.toContain("/opt/shellcheck");
  });

  it("keeps bash and sh scripts and skips a Windows shell", () => {
    const scripts = lint.shellScriptsFromWorkflow({
      defaults: { run: { shell: "bash" } },
      jobs: {
        one: {
          "runs-on": "windows-latest",
          steps: [
            { run: "echo ${{ github.ref }}\n" },
            { shell: "pwsh", run: "Write-Host hi" },
            { shell: "cmd", run: "echo hi" },
          ],
        },
      },
    });
    expect(scripts).toEqual([{ shell: "bash", source: "echo ${{ github.ref }}\n" }]);
    const script = scripts[0];
    if (!script) throw new Error("expected one shell script");
    expect(lint.sanitizeExpressions(script.source)).toBe("echo _________________\n");
  });

  it("reports a shellcheck finding from output written after the process starts", () => {
    const findings = lint.shellcheckFindings(
      "shellcheck",
      [{ shell: "bash", source: "echo $UNQUOTED", file: "demo.yml" }],
      (_cmd, args, opts) => {
        expect(args).toContain("-");
        expect(opts.input.startsWith("set -eo pipefail\n")).toBe(true);
        return {
          status: 1,
          stdout: JSON.stringify([
            {
              code: 2086,
              level: "info",
              line: 2,
              column: 6,
              message: "Double quote to prevent globbing.",
            },
          ]),
        };
      },
    );
    expect(findings).toEqual([
      "demo.yml: shellcheck reported issue in this script: SC2086:info:1:6: Double quote to prevent globbing",
    ]);
  });

  it("refuses an archive whose SHA-256 does not match the pin", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-lint-hash-"));
    const file = path.join(dir, "archive.bin");
    writeFileSync(file, "not-the-archive");
    expect(() => lint.assertSha256(file, "ab".repeat(32))).toThrow(/SHA-256/);
  });
});
