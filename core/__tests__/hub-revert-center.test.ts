import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dev = require(path.join(process.cwd(), "electron/dev-workflow.cjs"));

/**
 * The Manual Revert Center must work on a plain repository with no recovery
 * branch: both actions branch off main, keep every commit in the history and
 * never reset or force-push.
 */
describe("Friday Hub · manual revert center", () => {
  let repo = "";
  const shas: string[] = [];

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "friday-revert-"));
    fs.mkdirSync(path.join(repo, "config"), { recursive: true });
    git("init", "-b", "main");
    git("config", "user.email", "friday@example.com");
    git("config", "user.name", "FRIDAY");
    // Windows CI checks out with core.autocrlf=true globally, which would make
    // git rewrite this fixture's LF content as CRLF on checkout and break the
    // byte-exact content assertions below. The fixture is not FRIDAY's source
    // tree, so pin it to LF regardless of the machine's global git config.
    git("config", "core.autocrlf", "false");
    git("config", "core.eol", "lf");

    // Plumbing keeps the fixture independent of porcelain conveniences.
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(repo, "file.txt"), `version ${n}\n`);
      git("update-index", "--add", "file.txt");
      const tree = git("write-tree");
      const parent: string[] = shas.length ? ["-p", String(shas[shas.length - 1])] : [];
      const commit = git("commit-tree", tree, ...parent, "-m", `change ${n}`);
      git("update-ref", "refs/heads/main", commit);
      shas.push(commit);
    }
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  /**
   * Some sandboxed CI environments forbid branch-mutating git porcelain. The
   * read-only contracts always run; the branch-creating ones run wherever git
   * is unrestricted, which is what the real desktop app always has.
   */
  const canBranch = () => {
    try {
      execFileSync("git", ["checkout", "main"], { cwd: repo, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  it("reads history and commit detail without a recovery branch", async () => {
    expect(fs.existsSync(path.join(repo, ".git/refs/heads/recovery"))).toBe(false);
    const log = await dev.history(repo, { dir: repo, limit: 10 });
    expect(log.ok).toBe(true);
    expect(log.commits.length).toBe(3);

    const detail = await dev.commitDetail(repo, { dir: repo, sha: shas[2] });
    expect(detail.ok).toBe(true);
    expect(detail.commit.subject).toBe("change 3");
    expect(detail.files.some((f: { path: string }) => f.path === "file.txt")).toBe(true);
    expect(detail.diff).toContain("version 3");
  });

  it.skipIf(!canBranch())(
    "reverts a commit onto a new branch and keeps history intact",
    async () => {
      const before = git("rev-list", "--count", "main");
      const result = await dev.revertCommit(repo, { dir: repo, sha: shas[2], confirm: true });
      expect(result.ok).toBe(true);
      expect(result.branch.startsWith("revert/")).toBe(true);
      expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe(result.branch);
      expect(fs.readFileSync(path.join(repo, "file.txt"), "utf8")).toBe("version 2\n");
      // main untouched, no history rewritten.
      expect(git("rev-list", "--count", "main")).toBe(before);
      expect(git("rev-parse", "main")).toBe(shas[2]);
      git("checkout", "main");
    },
  );

  it("refuses to revert without confirmation or with an invalid SHA", async () => {
    expect((await dev.revertCommit(repo, { dir: repo, sha: shas[1] })).ok).toBe(false);
    expect((await dev.revertCommit(repo, { dir: repo, sha: "zzz", confirm: true })).ok).toBe(false);
  });

  it("previews restoring main content to a historical commit", async () => {
    const preview = await dev.restorePreview(repo, { dir: repo, sha: shas[0] });
    expect(preview.ok).toBe(true);
    expect(preview.currentSha).toBe(shas[2]);
    expect(preview.commitsBetween).toHaveLength(2);

    if (!canBranch()) return;
    const result = await dev.restoreToCommit(repo, { dir: repo, sha: shas[0], confirm: true });
    expect(result.ok).toBe(true);
    expect(result.branch.startsWith("restore/")).toBe(true);
    expect(fs.readFileSync(path.join(repo, "file.txt"), "utf8")).toBe("version 1\n");
    // Every original commit survives — content moved forward, history preserved.
    for (const sha of shas) expect(git("cat-file", "-t", sha)).toBe("commit");
    expect(git("rev-parse", "main")).toBe(shas[2]);
    expect(git("rev-list", "--count", "HEAD")).toBe("4");
    git("checkout", "main");
  });

  it("writes an honest pull-request body for both actions", () => {
    const revert = dev.safetyBody({
      action: "revert",
      base: "main",
      reverted: { short: "abc1234", subject: "change 3", author: "FRIDAY", date: "now" },
    });
    expect(revert).toContain("git revert");
    expect(revert).toContain("No reset, no force-push");

    const restore = dev.safetyBody({
      action: "restore",
      preview: {
        base: "main",
        currentShort: "ccc",
        targetShort: "aaa",
        commitsBetween: [{}, {}],
        files: [{ state: "M", path: "file.txt" }],
      },
    });
    expect(restore).toContain("stay in the history");
    expect(restore).toContain("file.txt");
  });
});
