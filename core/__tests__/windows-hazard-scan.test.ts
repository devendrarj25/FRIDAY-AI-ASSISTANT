/**
 * Fails when a new test, script, or workflow step reintroduces a Windows-only
 * break that the Linux suite cannot see. Each allow entry names the reason.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

type Allow = { file: string; rule: string; reason: string };

const ALLOW: Allow[] = [
  {
    file: "core/__tests__/foundation-readiness.test.ts",
    rule: "shell-option",
    reason: "Asserts check-engines does not turn the shell on from the platform.",
  },
  {
    file: "core/__tests__/helpers/platform-command.ts",
    rule: "shebang-stub",
    reason: "The POSIX half of the shared stub. Windows writes a .cmd launcher.",
  },
  {
    file: "core/__tests__/finish-ladder.test.ts",
    rule: "shebang-stub",
    reason:
      "The shebang is written only when the planted platform is not win32. Windows copies node.exe.",
  },
  {
    file: "core/__tests__/managed-python.test.ts",
    rule: "shebang-stub",
    reason: "The shebang is written only in the non-Windows branch. Windows uses python.exe.",
  },
  {
    file: "core/__tests__/release-resume.test.ts",
    rule: "shebang-stub",
    reason: "Asserts the Windows gh.cmd stub does not contain a shebang.",
  },
  {
    file: "core/__tests__/win-spawn-contract.test.ts",
    rule: "shebang-stub",
    reason: "Asserts the shared stub writes a shebang only in the POSIX file.",
  },
  {
    file: "core/__tests__/windows-hazard-scan.test.ts",
    rule: "shebang-stub",
    reason: "The scanner names the shebang pattern it rejects in other tests.",
  },
  {
    file: "kernel/tools.py",
    rule: "python-shell",
    reason: "The owner shell tool runs one command string. It is not a .cmd argv spawn.",
  },
];

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".venv") continue;
      walk(full, out);
    } else out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function allowed(file: string, rule: string): boolean {
  return ALLOW.some((item) => item.file === file && item.rule === rule && item.reason.length > 20);
}

function push(findings: string[], file: string, rule: string, line: number, text: string) {
  if (allowed(file, rule)) return;
  findings.push(`${file}:${line} ${rule}: ${text.trim().slice(0, 160)}`);
}

function scanSource(file: string, findings: string[]) {
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const text = stripComments(raw);
  text.split("\n").forEach((line, index) => {
    const number = index + 1;
    if (/\bshell\s*:\s*(true|process\.platform|win\b|WIN\b)/.test(line)) {
      push(findings, file, "shell-option", number, line);
    }
    if (
      /(?:^|[^.\w])(?:spawn|spawnSync|execFile|execFileSync|exec)\s*\(/.test(line) &&
      /\.(?:cmd|bat)["']/.test(line)
    ) {
      push(findings, file, "batch-spawn", number, line);
    }
    if (
      /(writeFile(?:Sync)?|mkdir(?:Sync)?|mkdtemp(?:Sync)?|createWriteStream|openSync)\s*\(\s*["'`]\/tmp/.test(
        line,
      )
    ) {
      push(findings, file, "tmp-write", number, line);
    }
    if (
      /(PATH|pathEnv)/.test(line) &&
      /["']:["']/.test(line) &&
      !/delimiter/.test(line) &&
      !/toBe\(false\)/.test(line)
    ) {
      push(findings, file, "path-colon", number, line);
    }
    if (file.endsWith(".py") && /shell\s*=\s*True/.test(line)) {
      push(findings, file, "python-shell", number, line);
    }
  });
  if (file.startsWith("core/__tests__/") && /#!\/bin\/(?:sh|bash)/.test(raw)) {
    push(findings, file, "shebang-stub", 1, "#!/bin/sh");
  }
}

function workflowSteps(file: string): { shell: boolean; run: boolean; at: number }[] {
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
  const steps: { shell: boolean; run: boolean; at: number }[] = [];
  let current: { shell: boolean; run: boolean; at: number } | null = null;
  const flush = () => {
    if (current?.run) steps.push(current);
    current = null;
  };
  lines.forEach((line, index) => {
    if (/^ {6}- /.test(line)) {
      flush();
      current = { shell: false, run: false, at: index + 1 };
      return;
    }
    if (!current) return;
    if (/^ {4}[^ ]/.test(line) || /^ {2}[A-Za-z]/.test(line)) {
      flush();
      return;
    }
    if (/^ {8}shell:/.test(line)) current.shell = true;
    if (/^ {8}run:/.test(line)) current.run = true;
  });
  flush();
  return steps;
}

describe("Windows hazard scan", () => {
  it("keeps an allow entry only when it still names a reason", () => {
    for (const item of ALLOW) {
      expect(item.reason.length, item.file).toBeGreaterThan(20);
      expect(fs.existsSync(path.join(ROOT, item.file)), item.file).toBe(true);
    }
  });

  it("rejects shell options, batch spawns, shebang stubs, /tmp writes, and colon PATH joins", () => {
    const files = [
      ...walk(path.join(ROOT, "scripts")).filter((file) => file.endsWith(".cjs")),
      ...walk(path.join(ROOT, "electron")).filter((file) => file.endsWith(".cjs")),
      ...walk(path.join(ROOT, "core/__tests__")).filter((file) => file.endsWith(".ts")),
      ...walk(path.join(ROOT, "kernel")).filter((file) => file.endsWith(".py")),
      ...walk(path.join(ROOT, "tools")).filter((file) => file.endsWith(".cjs")),
    ].map(rel);
    const findings: string[] = [];
    for (const file of files) scanSource(file, findings);
    expect(findings).toEqual([]);
  });

  it("requires an explicit shell on every workflow run step and LF line endings", () => {
    const findings: string[] = [];
    for (const name of fs.readdirSync(path.join(ROOT, ".github/workflows"))) {
      if (!name.endsWith(".yml")) continue;
      const file = `.github/workflows/${name}`;
      const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
      if (raw.includes("\r")) findings.push(`${file} has CRLF`);
      for (const step of workflowSteps(file)) {
        if (!step.shell) findings.push(`${file}:${step.at} run step has no shell`);
      }
    }
    expect(findings).toEqual([]);
  });
});
