/**
 * The pull-request file guard: build output, caches, logs, installers and very
 * large files never enter the repository. Built on a throwaway repository in a
 * temp folder, so it depends on nothing of this checkout's history.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const guard = require("../../scripts/check-added-files.cjs") as {
  MAX_BYTES: number;
  problemsFor: (file: string, size: number, limit?: number) => string[];
  checkRange: (
    base: string,
    cwd: string,
    limit?: number,
  ) => { ok: boolean; missing: boolean; problems: string[] };
};

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
}

function repoWith(files: Record<string, string | Buffer>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-added-"));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "keep.txt"), "base");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "work");
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "-q", "-m", "work");
  return dir;
}

describe("added-file guard", () => {
  it("refuses the files an AI tool or editor agent leaves behind", () => {
    for (const file of [
      ".claude/settings.json",
      ".cursor/rules/x.mdc",
      ".cursorrules",
      ".windsurf/rules.md",
      ".github/copilot-instructions.md",
      "GEMINI.md",
      "sub/.aider.chat.history.md",
    ]) {
      expect(guard.problemsFor(file, 10).length, file).toBeGreaterThan(0);
    }
    for (const file of ["AGENTS.md", "CLAUDE.md", "src/cursor.ts", "docs/FRIDAY_MCP.md"]) {
      expect(guard.problemsFor(file, 10), file).toEqual([]);
    }
  });

  it("judges a path by name and size", () => {
    expect(guard.problemsFor("src/app.ts", 1200)).toEqual([]);
    expect(guard.problemsFor("node_modules/x/index.js", 10)[0]).toContain("build output");
    expect(guard.problemsFor("release/FRIDAY-Setup-1.exe", 10).length).toBeGreaterThan(0);
    expect(guard.problemsFor("logs/run.log", 10)[0]).toContain("scratch");
    expect(guard.problemsFor("kernel/__pycache__/a.pyc", 10).length).toBeGreaterThan(0);
    expect(guard.problemsFor("models/big.bin", guard.MAX_BYTES + 1)[0]).toContain("MiB");
    expect(guard.problemsFor("a\\b\\Thumbs.db", 1).length).toBeGreaterThan(0);
  });

  it("passes an ordinary change and reports every unwanted file of a bad one", () => {
    const good = repoWith({ "src/ok.ts": "export const a = 1;\n", "docs/ok.md": "# ok\n" });
    expect(guard.checkRange("main", good)).toMatchObject({ ok: true, problems: [] });
    fs.rmSync(good, { recursive: true, force: true });

    const bad = repoWith({
      "dist-desktop/assets/x.js": "x",
      "scratch.log": "log",
      "data/blob.bin": Buffer.alloc(2048),
    });
    const out = guard.checkRange("main", bad, 1024);
    expect(out.ok).toBe(false);
    const text = out.problems.join("\n");
    expect(text).toContain("dist-desktop/assets/x.js");
    expect(text).toContain("scratch.log");
    expect(text).toContain("data/blob.bin");
    fs.rmSync(bad, { recursive: true, force: true });
  });

  it("does not judge a file the range only deletes, and reports a missing base", () => {
    const dir = repoWith({ "src/ok.ts": "x" });
    git(dir, "rm", "-q", "keep.txt");
    git(dir, "commit", "-q", "-m", "drop");
    expect(guard.checkRange("main", dir).ok).toBe(true);
    expect(guard.checkRange("no-such-ref", dir)).toMatchObject({ ok: false, missing: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
