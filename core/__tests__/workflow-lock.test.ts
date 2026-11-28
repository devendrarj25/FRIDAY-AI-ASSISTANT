/**
 * The optional content lock on the workflows and composite actions (scripts/workflow-lock.cjs). It is dormant by
 * owner policy: config/workflow-lock.json says `"enforced": false`, so editing a workflow fails nothing. These
 * tests pin the mechanism on a temporary copy, switched on and switched off, so it works the day the owner turns
 * it on. No network, no git history, no date; the real config/ files are only read.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const lock = require("../../scripts/workflow-lock.cjs") as {
  lockedFiles: (base?: string) => string[];
  current: (base?: string) => Record<string, string>;
  compare: (recorded: Record<string, string>, actual: Record<string, string>) => string[];
  readLock: (base?: string) => Record<string, string>;
  writeLock: (base?: string) => void;
  digest: (file: string, base?: string) => string;
  isEnforced: (kind: "workflows" | "cmd-chain", base?: string) => boolean;
  verify: (
    kind: "workflows" | "cmd-chain",
    base?: string,
  ) => { enforced: boolean; problems: string[] };
};
const root = path.resolve(__dirname, "..", "..");
const script = path.join(root, "scripts", "workflow-lock.cjs");
const lockRel = path.join("config", "workflow-lock.json");

describe("workflow lock, the live repository", () => {
  it("covers all workflows (11) and composite actions (3)", () => {
    const files = lock.lockedFiles();
    expect(files.filter((f) => f.startsWith(".github/workflows/"))).toHaveLength(11);
    expect(files.filter((f) => f.startsWith(".github/actions/"))).toEqual([
      ".github/actions/checkout/action.yml",
      ".github/actions/friday-node/action.yml",
      ".github/actions/python/action.yml",
    ]);
  });

  it("holds while it is off and while it is on", () => {
    expect(lock.verify("workflows").problems).toEqual([]);
    expect(typeof lock.verify("workflows").enforced).toBe("boolean");
  });

  it("is dormant by owner policy: the lock file carries enforced false", () => {
    const body = JSON.parse(readFileSync(path.join(root, lockRel), "utf8")) as {
      enforced?: unknown;
    };
    expect(body.enforced).toBe(false);
    expect(lock.isEnforced("workflows")).toBe(false);
  });
});

describe("workflow lock, a temporary copy", () => {
  let tmp = "";
  const wf = (name: string) => path.join(tmp, ".github", "workflows", name);
  const setEnforced = (value: unknown) => {
    const file = path.join(tmp, lockRel);
    const body = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    body["enforced"] = value;
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  };
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [script, "--root", tmp, ...args], { encoding: "utf8" });

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "friday-lock-"));
    cpSync(path.join(root, ".github"), path.join(tmp, ".github"), { recursive: true });
    mkdirSync(path.join(tmp, "config"), { recursive: true });
    lock.writeLock(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writeLock on a copy records the copy and never touches the real lock", () => {
    const real = readFileSync(path.join(root, lockRel), "utf8");
    expect(lock.readLock(tmp)).toEqual(lock.current(tmp));
    expect(readFileSync(path.join(root, lockRel), "utf8")).toBe(real);
  });

  it("digest ignores CRLF", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    writeFileSync(path.join(tmp, "x.txt"), "a\r\nb");
    expect(lock.digest("x.txt", tmp)).toBe(sha("a\nb"));
  });

  it("a fresh lock is off, and only the literal true switches it on", () => {
    expect(lock.isEnforced("workflows", tmp)).toBe(false);
    for (const value of ["true", 1, null, "yes", {}]) {
      setEnforced(value);
      expect(lock.isEnforced("workflows", tmp)).toBe(false);
    }
    setEnforced(true);
    expect(lock.isEnforced("workflows", tmp)).toBe(true);
    rmSync(path.join(tmp, lockRel));
    expect(lock.isEnforced("workflows", tmp)).toBe(false);
    writeFileSync(path.join(tmp, lockRel), "{ not json");
    expect(lock.isEnforced("workflows", tmp)).toBe(false);
    expect(lock.verify("workflows", tmp)).toEqual({ enforced: false, problems: [] });
  });

  describe("enforced: true", () => {
    beforeEach(() => setEnforced(true));

    it("holds when nothing changed", () => {
      expect(lock.verify("workflows", tmp)).toEqual({ enforced: true, problems: [] });
      const run = cli();
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("holds");
    });

    it("fails on an appended line, and the CLI exits 1 naming the file", () => {
      writeFileSync(
        wf("branch-cleanup.yml"),
        `${readFileSync(wf("branch-cleanup.yml"), "utf8")}# one more line\n`,
      );
      expect(lock.verify("workflows", tmp).problems).toEqual([
        ".github/workflows/branch-cleanup.yml: changed since it was locked",
      ]);
      const run = cli();
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        ".github/workflows/branch-cleanup.yml: changed since it was locked",
      );
    });

    it("reports an added file and a removed file", () => {
      writeFileSync(wf("twelfth.yml"), "name: x\n");
      rmSync(wf("security.yml"));
      const { problems } = lock.verify("workflows", tmp);
      expect(problems).toContain(".github/workflows/twelfth.yml: added, not in the lock");
      expect(problems).toContain(".github/workflows/security.yml: removed, still in the lock");
    });

    it("is blind to a CRLF rewrite", () => {
      const text = readFileSync(wf("branch-cleanup.yml"), "utf8");
      writeFileSync(wf("branch-cleanup.yml"), text.replace(/\n/g, "\r\n"));
      expect(lock.verify("workflows", tmp).problems).toEqual([]);
    });

    it("--write records the new files and keeps enforced true", () => {
      writeFileSync(wf("twelfth.yml"), "name: x\n");
      const run = cli("--write");
      expect(run.status).toBe(0);
      expect(lock.readLock(tmp)).toHaveProperty([".github/workflows/twelfth.yml"]);
      expect(lock.isEnforced("workflows", tmp)).toBe(true);
      expect(cli().status).toBe(0);
    });
  });

  describe("enforced: false", () => {
    it("a changed, an added and a removed file all pass", () => {
      writeFileSync(
        wf("branch-cleanup.yml"),
        `${readFileSync(wf("branch-cleanup.yml"), "utf8")}# more\n`,
      );
      writeFileSync(wf("twelfth.yml"), "name: x\n");
      rmSync(wf("security.yml"));
      expect(lock.verify("workflows", tmp)).toEqual({ enforced: false, problems: [] });
      const run = cli();
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("lock is off");
    });

    it("--write records the hashes but keeps enforced false", () => {
      writeFileSync(wf("twelfth.yml"), "name: x\n");
      const run = cli("--write");
      expect(run.status).toBe(0);
      expect(lock.readLock(tmp)).toHaveProperty([".github/workflows/twelfth.yml"]);
      const body = JSON.parse(readFileSync(path.join(tmp, lockRel), "utf8")) as {
        enforced: unknown;
      };
      expect(body.enforced).toBe(false);
    });
  });

  it("compare names a changed, an added and a removed file", () => {
    expect(lock.compare({ a: "1", gone: "3" }, { a: "2", fresh: "4" })).toEqual([
      "a: changed since it was locked",
      "fresh: added, not in the lock",
      "gone: removed, still in the lock",
    ]);
  });
});
