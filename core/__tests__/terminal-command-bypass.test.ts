/**
 * Lines that look like a read but run code are "exec" (the owner approves them). Each case below once classified as
 * "write" and ran with no gate: an option that launches a program (`--pre`, `-exec`, `-O`, `--script-shell`), an option
 * that writes (`-w`, `go env -w`), a PowerShell sub-expression or script block (`(...)`, `@(...)`, `{...}`), a bare
 * carriage return (a newline to PowerShell), a bash process substitution, and `where` (an alias of Where-Object).
 * The renderer table and the main-process table must give the same answer.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { classifyCommand } from "../../src/lib/friday/terminal-command";

const terminal = createRequire(import.meta.url)("../../electron/terminal.cjs") as {
  classifyCommand: (command: string) => "write" | "exec";
};

const RUNS_CODE = [
  "git grep -Ocalc.exe foo",
  "git grep -O calc.exe foo",
  "git grep --open-files-in-pager=calc.exe foo",
  "rg --pre=calc.exe x .",
  "rg --pre calc.exe x .",
  "rg --hostname-bin=calc.exe x .",
  "go test -exec calc ./...",
  "go test -toolexec=calc ./...",
  "go vet -vettool=calc ./...",
  "go test -o out.exe ./...",
  "npm test --script-shell=calc.exe",
  "npm run test --script-shell calc.exe",
  "go env -w GOFLAGS=-x",
  "go env -u GOFLAGS",
  "prettier --check -w .",
  "npx prettier --check -w .",
  "echo (Remove-Item -Recurse C:\\x)",
  "write-output @(Stop-Process -Name explorer)",
  "where -InputObject 1 {Remove-Item C:\\x}",
  "where /r C: *.txt",
  "echo hi\rRemove-Item x",
  "echo hi\r\nRemove-Item x",
  "cat <(rm -rf ~/x)",
  "echo {Remove-Item x}",
  "dir (Remove-Item x)",
];

const STILL_READS = [
  "git grep foo",
  "git grep -n foo src",
  "git status",
  "git diff",
  "git log --oneline -5",
  "rg foo src",
  "rg -n --hidden foo .",
  "go test ./...",
  "go vet ./...",
  "go version",
  "go env",
  "go env GOFLAGS",
  "npm test",
  "npm run test",
  "npm run lint",
  "npx prettier --check .",
  "prettier --check .",
  "npx eslint src",
  "echo hello",
  "dir",
  "which node",
  "npm test && npm run typecheck",
  "git status\r\ngit diff",
];

describe("agent-origin shell classifier: lines that run code are exec", () => {
  for (const [name, classify] of [
    ["renderer", classifyCommand],
    ["main process", terminal.classifyCommand],
  ] as const) {
    describe(name, () => {
      it.each(RUNS_CODE)("%j is exec", (line) => {
        expect(classify(line)).toBe("exec");
      });
      it.each(STILL_READS)("%j stays write", (line) => {
        expect(classify(line)).toBe("write");
      });
    });
  }
});
