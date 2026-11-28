/**
 * The lock on AGENTS.md (scripts/workflow-lock.cjs --agents, config/agents-lock.json). Unlike the workflow and CMD
 * chain locks it is always on. Only the owner asks for a change to AGENTS.md; this fails on any other difference.
 * The release engine rewrites two version numbers in it, and a release must never trip the lock.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const script = path.join(root, "scripts", "workflow-lock.cjs");
const lock = require_(script);

const made: string[] = [];
function fixture(record = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-agents-lock-"));
  made.push(dir);
  mkdirSync(path.join(dir, "config"), { recursive: true });
  copyFileSync(path.join(root, "AGENTS.md"), path.join(dir, "AGENTS.md"));
  if (record) lock.writeAgentsLock(dir);
  return dir;
}
const edit = (dir: string, fn: (text: string) => string) => {
  const file = path.join(dir, "AGENTS.md");
  writeFileSync(file, fn(readFileSync(file, "utf8")));
};
const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, "--agents", "--root", dir, ...args], { encoding: "utf8" });

afterEach(() => {
  while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

describe("the lock on AGENTS.md", () => {
  it("holds for the real AGENTS.md, is always on, and has no switch", () => {
    const result = lock.verify("agents");
    expect(result.enforced).toBe(true);
    expect(result.problems).toEqual([]);
    const body = JSON.parse(readFileSync(path.join(root, "config", "agents-lock.json"), "utf8"));
    expect(Object.keys(body.files)).toEqual(["AGENTS.md"]);
    expect(body.files["AGENTS.md"]).toMatch(/^[0-9a-f]{64}$/);
    expect(body).not.toHaveProperty("enforced");
    expect(lock.isEnforced("agents")).toBe(true);
  });

  it("states the lock in AGENTS.md itself, in the rules and in its own section", () => {
    const text = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(text).toContain("## Locked: this file");
    expect(text).toContain("node scripts/workflow-lock.cjs --agents --write");
    expect(text).toContain("An agent never runs that command to make a failing test pass");
    expect(text).toContain("`core/__tests__/agents-lock.test.ts`");
  });

  it("fails on any other change, and names the file and the way out", () => {
    const dir = fixture();
    expect(lock.verify("agents", dir).problems).toEqual([]);
    edit(dir, (t) => `${t}\nA new rule.\n`);
    expect(lock.verify("agents", dir).problems).toEqual(["AGENTS.md: changed since it was locked"]);
    const run = cli(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("AGENTS.md: changed since it was locked");
    expect(run.stderr).toContain("AGENTS.md is locked");
    expect(run.stderr).toContain("--agents --write");
  });

  it("fails on a single changed character, a typo included", () => {
    const dir = fixture();
    edit(dir, (t) => t.replace("It wins.", "It wins!"));
    expect(lock.verify("agents", dir).problems).toHaveLength(1);
  });

  it("ignores line endings and exactly the two version numbers the release engine rewrites", () => {
    const dir = fixture();
    edit(dir, (t) => t.replace(/\n/g, "\r\n"));
    expect(lock.verify("agents", dir).problems).toEqual([]);
    edit(dir, (t) =>
      t
        .replace(/(current public line\s*\*\*FRIDAY\s+)[\d.]+(\*\*)/, "$19.8.7.6$2")
        .replace(/(Next public revision is\s*\*\*)[\d.]+(\*\*)/, "$19.8.7.7$2"),
    );
    expect(lock.verify("agents", dir).problems).toEqual([]);
  });

  it("does not ignore any other number, such as the four-part example", () => {
    const dir = fixture();
    edit(dir, (t) => t.replace("(`1.0.0.0`)", "(`2.0.0.0`)"));
    expect(lock.verify("agents", dir).problems).toHaveLength(1);
  });

  it("treats a missing or unreadable lock record as a failure, never as off", () => {
    const dir = fixture(false);
    const missing = lock.verify("agents", dir);
    expect(missing.enforced).toBe(true);
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toContain("config/agents-lock.json");
    writeFileSync(path.join(dir, "config", "agents-lock.json"), "not json");
    expect(lock.verify("agents", dir).problems).toHaveLength(1);
  });

  it("cannot be switched off from the record", () => {
    const dir = fixture();
    const file = path.join(dir, "config", "agents-lock.json");
    const body = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...body, enforced: false }));
    expect(lock.isEnforced("agents", dir)).toBe(true);
    edit(dir, (t) => `${t}x`);
    expect(lock.verify("agents", dir).problems).toHaveLength(1);
    expect(cli(dir).status).toBe(1);
  });

  it("--write records the file, and the check then passes", () => {
    const dir = fixture();
    edit(dir, (t) => `${t}\nOwner's change.\n`);
    expect(cli(dir).status).toBe(1);
    const write = cli(dir, "--write");
    expect(write.status).toBe(0);
    const check = cli(dir);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("AGENTS.md lock holds for 1 files");
  });
});
