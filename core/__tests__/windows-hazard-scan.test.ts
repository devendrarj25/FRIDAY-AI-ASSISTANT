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
  scanPosixRoots(file, raw, findings);
  raw.split("\n").forEach((line, index) => {
    const code = line.replace(/(^|[^:])\/\/.*$/, "$1");
    const trimmed = code.trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) return;
    if (/process\.platform\s*[!=]==\s*["']win32["']/.test(code)) return;
    if (
      !/\b(?:path\s*\.\s*)?(?:join|resolve)\s*\(|mkdir(?:Sync)?\s*\(|mkdtemp(?:Sync)?\s*\(/.test(
        code,
      )
    ) {
      return;
    }
    for (const quoted of code.match(/["']([^"']+)["']/g) || []) {
      const value = quoted.slice(1, -1);
      if (value.startsWith("node:")) continue;
      if (/^[A-Za-z]:(?:[\\/]|$)/.test(value)) continue;
      if (/^[A-Za-z0-9._~-]+:[A-Za-z0-9._~-]+$/.test(value)) {
        push(findings, file, "colon-segment", index + 1, line);
      }
    }
  });
}

const POSIX_ROOT = /^\/(?:tmp|var|home|usr|etc|opt|mnt)(?:\/|$)/;
const FS_NAME =
  /^(?:mkdir|mkdtemp|writeFile|readFile|copyFile|rename|createWriteStream|createReadStream|rm|cp|exists|stat|lstat|open)/;

/** Comments and string contents become spaces so a fixture string is not a call. */
function maskNonCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (text.startsWith("/*", i)) {
      out += "  ";
      i += 2;
      while (i < text.length && !text.startsWith("*/", i)) {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < text.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    const quote = text[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      out += " ";
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          out += " ";
          i += 1;
          break;
        }
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function stringLiterals(expr: string): string[] {
  const found: string[] = [];
  const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(expr))) found.push(match[2] || "");
  return found;
}

function hasPosixRoot(expr: string): boolean {
  return stringLiterals(expr).some((value) => POSIX_ROOT.test(value));
}

function assignments(text: string): Array<{ name: string; init: string }> {
  const out: Array<{ name: string; init: string }> = [];
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index + match[0].length;
    let i = start;
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      else if ((ch === ";" || ch === "\n") && depth === 0) break;
      i += 1;
    }
    out.push({ name: match[1] || "", init: text.slice(start, i) });
  }
  return out;
}

function taintedNames(text: string): Set<string> {
  const mask = maskNonCode(text);
  const tainted = new Set<string>();
  const found = [...mask.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)];
  const rows = assignments(mask).map((row, index) => {
    const start = (found[index]?.index || 0) + (found[index]?.[0].length || 0);
    return { name: row.name, init: text.slice(start, start + row.init.length) };
  });
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!row.name || tainted.has(row.name) || row.init.includes("?")) continue;
      const usesTainted = [...tainted].some((name) => new RegExp(`\\b${name}\\b`).test(row.init));
      if (hasPosixRoot(row.init) || usesTainted) {
        tainted.add(row.name);
        grew = true;
      }
    }
  }
  return tainted;
}

function balancedArgs(text: string, openAt: number): string {
  let depth = 0;
  for (let i = openAt; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openAt + 1, i);
    }
  }
  return text.slice(openAt + 1);
}

function statementGuarded(text: string, index: number): boolean {
  let start = index;
  let depth = 0;
  while (start > 0) {
    const ch = text[start - 1];
    if (ch === ")" || ch === "]" || ch === "}") depth += 1;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) break;
      depth -= 1;
    } else if ((ch === ";" || ch === "\n") && depth === 0) break;
    start -= 1;
  }
  return /process\.platform[^;\n]{0,80}win32/.test(text.slice(start, index));
}

/**
 * A POSIX absolute root fed to a filesystem call fails on Windows when that
 * directory does not exist. path.join("/tmp", ...) and a const built from it
 * count. Assertion strings such as expect(x).toBe("/tmp/x") are not calls.
 */
function scanPosixRoots(file: string, raw: string, findings: string[]) {
  const text = stripComments(raw);
  const mask = maskNonCode(text);
  const tainted = taintedNames(text);
  const call =
    /(?:^|[^.\w])(?:fs\s*\.\s*)?(mkdir(?:Sync)?|mkdtemp(?:Sync)?|writeFile(?:Sync)?|readFile(?:Sync)?|copyFile(?:Sync)?|rename(?:Sync)?|createWriteStream|createReadStream|rm(?:Sync)?|cp(?:Sync)?|exists(?:Sync)?|stat(?:Sync)?|lstat(?:Sync)?|open(?:Sync)?)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(mask))) {
    const name = match[1] || "";
    const hasFs = /fs\s*\./.test(match[0]);
    if (!hasFs && /^(?:open|stat|lstat|exists|rm|cp)/.test(name) && !file.endsWith(".py")) {
      continue;
    }
    if (!FS_NAME.test(name)) continue;
    const openAt = match.index + match[0].length - 1;
    const nameAt = match.index + match[0].lastIndexOf(name);
    if (statementGuarded(text, nameAt)) continue;
    const args = balancedArgs(text, openAt);
    const ident = [...tainted].some((id) => new RegExp(`\\b${id}\\b`).test(args));
    if (!hasPosixRoot(args) && !ident) continue;
    const line = text.slice(0, nameAt).split("\n").length;
    push(findings, file, "posix-root", line, text.split("\n")[line - 1] || match[0]);
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

  it("rejects shell options, batch spawns, shebang stubs, /tmp writes, colon PATH joins, and colon path segments", () => {
    const files = [
      ...walk(path.join(ROOT, "scripts")).filter((file) => file.endsWith(".cjs")),
      ...walk(path.join(ROOT, "electron")).filter((file) => file.endsWith(".cjs")),
      ...walk(path.join(ROOT, "core/__tests__")).filter((file) => file.endsWith(".ts")),
      ...walk(path.join(ROOT, "kernel")).filter((file) => file.endsWith(".py")),
      ...walk(path.join(ROOT, "tools")).filter((file) => file.endsWith(".cjs")),
      ...walk(path.join(ROOT, "agents")).filter((file) => /\.(cjs|js|mjs|ts|py)$/.test(file)),
      ...walk(path.join(ROOT, "src")).filter((file) => /\.(ts|tsx|js|cjs|mjs)$/.test(file)),
      ...walk(path.join(ROOT, "installer")).filter((file) => /\.(cjs|js|ps1)$/.test(file)),
    ].map(rel);
    const findings: string[] = [];
    for (const file of files) scanSource(file, findings);
    expect(findings).toEqual([]);
  });

  it("flags path.join of a POSIX root passed to mkdtemp, including the readiness temp dir", () => {
    const mkdtemp = "fs.mkdtemp" + "Sync";
    const sample = [
      `${mkdtemp}(path.join("/tmp", "friday-readiness-"));`,
      'const dir = path.join("/var", "friday");',
      "fs.writeFileSync(dir, 'x');",
      'expect(value).toBe("/tmp/x");',
      'const hosts = process.platform === "win32" ? "C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts" : "/etc/hosts";',
      "fs.existsSync(hosts);",
    ].join("\n");
    const findings: string[] = [];
    scanPosixRoots("fixture.ts", sample, findings);
    expect(findings.some((line) => line.includes("posix-root") && line.includes("mkdtemp"))).toBe(
      true,
    );
    expect(findings.some((line) => line.includes("writeFileSync"))).toBe(true);
    expect(findings.some((line) => line.includes("toBe"))).toBe(false);
    expect(findings.some((line) => line.includes("existsSync"))).toBe(false);
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
