/**
 * The agent shell classifier reads a line as argv tokens, the way the shell and the program will, and a command is
 * "write" (runs with no gate) only when every token after its name is on that command's own allowlist. A regex over
 * the raw line was beaten by git's shortened long options (`--op` is `--open-files-in-pager`), Go's double-dash form
 * of its single-dash flags (`--exec`, `--vettool`, `--w`), quoted flags (`"--pre=calc"`), cmd and bash escapes
 * (`--out^put`, `\-\-pre`), PowerShell array commas (`a,--pre=calc`), file globs that expand to a flag, UNC and URL
 * arguments, network commands and repository code in an untrusted folder. One case table runs through both copies
 * (renderer and main process) and both must give the same answer.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { SAFE_COMMANDS, classifyCommand } from "../../src/lib/friday/terminal-command";

type Classify = (command: string, options?: { untrusted?: boolean }) => "write" | "exec";
const terminal = createRequire(import.meta.url)("../../electron/terminal.cjs") as {
  SAFE_COMMANDS: unknown;
  classifyCommand: Classify;
};

/** Each line runs a program, writes a file, reaches the network or leaves the folder: the owner approves it. */
const EXEC = [
  // git accepts any unique prefix of a long option.
  "git grep --op=calc.exe x",
  "git grep --open=calc.exe x",
  "git grep --open-files=calc.exe x",
  "git log --out=f",
  "git log --outp=f",
  "git diff --ext-diff",
  "git log --format=%h",
  "git -c core.pager=calc log",
  "git -C .. status",
  "git branch newbranch",
  // Go takes --flag for -flag.
  "go test --exec=calc ./...",
  "go test --exec calc ./...",
  "go test --toolexec=calc ./...",
  "go vet --vettool=calc ./...",
  "go env --w GOFLAGS=-toolexec=calc",
  "go env -w GOFLAGS=-toolexec=calc",
  "go env --u GOFLAGS",
  "go env GOFLAGS=-toolexec=calc",
  "go test -coverprofile=c.out ./...",
  // Quoted, escaped or split flags.
  'rg x "--pre=calc"',
  "rg x '--pre=calc'",
  'git log "--output=f"',
  'npm test "--script-shell=calc"',
  'eslint . "--fix"',
  'npx eslint . "--fix"',
  "git log --out^put=f",
  "rg x -^-pre=calc",
  "rg x \\-\\-pre=calc",
  "rg x foo\\ --pre=calc",
  "rg x a,--pre=calc",
  "rg x a,'--pre=calc'",
  "rg x 'a\" --pre=calc \"b'",
  "rg x 'a --pre=calc b'",
  'rg x "a"" --pre=calc"',
  'rg -e "" x',
  "rg -e '' x",
  'rg x "unbalanced',
  "rg x 'unbalanced",
  'rg x \\"--pre=calc\\"',
  'rg -n^" --pre=calc" x',
  // A glob that the shell could expand into a flag-named file.
  "rg x *",
  "rg x ?pre*",
  "rg x [-]*",
  "ls *",
  // Shell syntax that runs something else.
  "git status; git diff",
  "git status & calc",
  "git status || calc",
  "git status | more",
  "echo $HOME",
  "echo %COMSPEC%",
  "echo !x!",
  "echo hi > out.txt",
  "type < x",
  "echo `calc`",
  "echo (calc)",
  "echo {calc}",
  "echo hi\rcalc",
  "rg x @args",
  // Flags that write, load code or point at another config.
  "eslint -o out.txt src",
  "eslint --output-file out.txt src",
  "eslint --output-file=out.txt src",
  "eslint --fix src",
  "eslint -f ./formatter.js src",
  "eslint --rulesdir x src",
  "eslint -c x.js src",
  "pytest --basetemp=C:\\Windows",
  "pytest --junitxml=out.xml",
  "pytest -o cache_dir=x",
  "pytest -p evil",
  "pytest -c other.ini",
  "python -m pytest --basetemp=x",
  "ruff check --add-noqa kernel",
  "ruff check --output-file out.txt kernel",
  "ruff check -o out.txt kernel",
  "ruff check --fix kernel",
  "ruff check --unsafe-fixes kernel",
  "vitest -u",
  "vitest --update",
  "npx vitest run -u",
  "npx vitest --reporter=./evil.js",
  "vitest --config evil.ts",
  "prettier -w .",
  "prettier --check -w .",
  "prettier --write .",
  "prettier --check --plugin=./x.js .",
  "npx tsc",
  "npx tsc --noEmit --generateTrace x",
  "npx tsc --build",
  "npm test -- -u",
  "npm test --foo",
  "npm run test --script-shell calc",
  "npm run lint:fix",
  "cargo test --config build.rustc=calc",
  "cargo clippy --fix",
  "rg -z x",
  "rg --search-zip x",
  "rg --pre-glob=* x",
  "dir /s \\\\host\\share",
  // Network and remote paths.
  "ping example.com",
  "ping 127.0.0.1",
  "Test-Connection example.com",
  "test-connection 1.1.1.1",
  "nslookup example.com",
  "npm view react",
  "npm doctor",
  "curl https://example.com",
  "winget search git",
  "winget show Git.Git",
  "choco search git",
  "choco outdated",
  "scoop search git",
  "type \\\\host\\share\\x.txt",
  "cat //host/share/x.txt",
  "Get-Content \\\\host\\share\\x.txt",
  "dir /\\host\\share",
  "cat https://example.com/x",
  "rg x file://host/share",
  "systeminfo /s host",
  "tasklist /s host",
  "hostname newname",
  "whoami /x",
  "date 01-01-2020",
  "Get-Help Get-Date -Online",
  // The earlier bypasses (terminal-command-bypass.test.ts).
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
  // Not a read at all.
  "some-tool --version x",
  "node --version extra",
];

/** Ordinary reads and checks: they still run with no gate. */
const WRITE = [
  "git status",
  "git status --short",
  "git status -sb",
  "git diff",
  "git diff --stat",
  "git diff --cached -- src/x.ts",
  "git log --oneline -5",
  "git log -n 5 --stat",
  "git show HEAD",
  "git log HEAD^",
  "git grep foo",
  "git grep -n foo src",
  "git branch",
  "git branch -a",
  "git branch --show-current",
  "git remote -v",
  "git stash list",
  "git rev-parse --abbrev-ref HEAD",
  "git --version",
  "ls",
  "ls -la",
  "dir",
  "dir /s /b",
  "dir src",
  "rg foo src",
  "rg -n --hidden foo .",
  "rg -g '*.ts' foo src",
  'rg "two words" src',
  "rg x ./*",
  "npm test",
  "npm run test",
  "npm run lint",
  "npm run typecheck",
  "npm test && npm run typecheck",
  "git status\r\ngit diff",
  "git status\ngit diff",
  "npx vitest run core/__tests__/x.test.ts",
  "npx vitest run -t name core/__tests__/x.test.ts",
  "npx tsc --noEmit",
  "npx tsc --noEmit -p tsconfig.json",
  "npx eslint src",
  "npx prettier --check .",
  "prettier --check .",
  "pytest kernel/tests",
  "pytest -q kernel\\tests\\test_x.py",
  "pytest -k memory kernel/tests",
  "python -m pytest -q kernel/tests",
  "ruff check kernel",
  "go test ./...",
  "go test -v -run TestX ./...",
  "go vet ./...",
  "go version",
  "go env",
  "go env GOFLAGS",
  "cargo test",
  "node --version",
  "python --version",
  "pwd",
  "whoami",
  "hostname",
  "ipconfig",
  "ipconfig /all",
  "tasklist",
  "systeminfo",
  "netstat -ano",
  "winget list",
  "echo hello",
  "which node",
  "type README.md",
  "cat src/main.tsx",
  "Get-Date",
  "Get-ChildItem",
  "Get-ChildItem -Recurse src",
  "Get-Process",
  "Get-Content README.md",
  "date /t",
  // The earlier reads (terminal-command-bypass.test.ts).
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
  "",
];

const COPIES: Array<[string, Classify]> = [
  ["renderer", classifyCommand],
  ["main process", terminal.classifyCommand],
];

describe("argv classifier: one case table, both copies", () => {
  for (const [name, classify] of COPIES) {
    describe(name, () => {
      it.each(EXEC)("%j is exec", (line) => {
        expect(classify(line)).toBe("exec");
      });
      it.each(WRITE)("%j stays write", (line) => {
        expect(classify(line)).toBe("write");
      });
    });
  }

  it("the two copies agree on every case and hold the same rule table", () => {
    for (const line of [...EXEC, ...WRITE]) {
      expect(classifyCommand(line), line).toBe(terminal.classifyCommand(line));
    }
    expect(JSON.stringify(terminal.SAFE_COMMANDS)).toBe(JSON.stringify(SAFE_COMMANDS));
  });
});

describe("repository code in an untrusted folder is exec", () => {
  // cmd looks in the current folder before PATH, so only what is built into cmd is safe there.
  const REPO_CODE = [
    "git status",
    "git diff",
    "git log --oneline -5",
    "npm test",
    "npm run lint",
    "npx vitest run",
    "npx eslint src",
    "pytest kernel/tests",
    "python -m pytest",
    "go test ./...",
    "cargo test",
    "dotnet test",
    "rg foo src",
    "node --version",
    "ruff check kernel",
    "ls",
    "pwd",
  ];
  const PLAIN = ["dir", "dir /s /b", "echo hi", "type README.md", "ver", "date /t"];

  for (const [name, classify] of COPIES) {
    it(`${name}: a command that runs the folder's own code or config asks first`, () => {
      for (const line of REPO_CODE) {
        expect(classify(line, { untrusted: true }), line).toBe("exec");
        expect(classify(line), line).toBe("write");
      }
      for (const line of PLAIN) expect(classify(line, { untrusted: true }), line).toBe("write");
    });
  }
});
