/**
 * Commit provenance is checked on a throwaway repo, never this checkout's history.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const IDENTITY = require_(path.resolve(process.cwd(), "scripts/identity.cjs")) as {
  GITHUB: string;
  OWNER: string;
};

const script = path.resolve(process.cwd(), "scripts/check-provenance.cjs");

function git(dir: string, args: string[]) {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-provenance-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", IDENTITY.OWNER]);
  git(dir, ["config", "user.email", `${IDENTITY.GITHUB}@users.noreply.github.com`]);
  fs.writeFileSync(path.join(dir, "README.md"), "FRIDAY\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "feat: keep the desk on this PC"]);
  git(dir, ["tag", "base"]);
  return dir;
}

function commit(
  dir: string,
  message: string,
  author?: string,
  committer?: { name: string; email: string },
) {
  fs.appendFileSync(path.join(dir, "README.md"), `${message}\n`);
  git(dir, ["add", "README.md"]);
  const args = ["commit", "-m", message];
  if (committer) {
    args.unshift("-c", `user.email=${committer.email}`);
    args.unshift("-c", `user.name=${committer.name}`);
  }
  if (author) args.push(`--author=${author}`);
  git(dir, args);
}

const DEPENDABOT_EMAIL = "49699333+dependabot[bot]@users.noreply.github.com";
const DEPENDABOT = `dependabot[bot] <${DEPENDABOT_EMAIL}>`;

function check(dir: string): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, "base"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

describe("commit provenance", () => {
  it("accepts the owner and the repository automation identities", () => {
    const dir = repo();
    commit(dir, "fix: repair the local pack");
    commit(dir, "ci: sync docs", "friday-ci <friday-ci@users.noreply.github.com>");
    commit(
      dir,
      "safety: preserve unexpected main push",
      "FRIDAY Main Safety <actions@users.noreply.github.com>",
    );
    commit(dir, "feat: note a human review\n\nCo-authored-by: devendrarj25");
    const result = check(dir);
    expect(result.status).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an assistant author, co-author, generated mark, or other bot", () => {
    const cases: {
      message: string;
      author?: string;
      committer?: { name: string; email: string };
    }[] = [
      {
        message: "feat: desk",
        author: "Cursor Agent <cursoragent@cursor.com>",
      },
      {
        message: "feat: desk\n\nCo-authored-by: Claude <noreply@anthropic.com>",
      },
      {
        message: "feat: desk\n\nGenerated with Cursor",
      },
      {
        message: "feat: desk",
        author: "dependabot[bot] <dependabot[bot]@users.noreply.github.com>",
      },
      {
        message: "feat: desk",
        author: "dependabot[bot] <support@github.com>",
        committer: { name: "dependabot[bot]", email: "support@github.com" },
      },
      {
        message: "feat: desk\n\nCo-authored-by: dependabot[bot] <other@example.com>",
      },
      {
        message: `feat: desk\n\nCo-authored-by: dependabot[bot] <${DEPENDABOT_EMAIL}.evil>`,
      },
      {
        message: `feat: desk\n\nCo-authored-by: Someone <${DEPENDABOT_EMAIL}>`,
      },
      {
        message: "feat: desk",
        author: "copilot[bot] <49699333+copilot[bot]@users.noreply.github.com>",
      },
      {
        message: "feat: desk",
        author: "cursor[bot] <cursor[bot]@users.noreply.github.com>",
      },
      {
        message: "feat: desk",
        author: "claude[bot] <claude[bot]@users.noreply.github.com>",
      },
    ];
    for (const row of cases) {
      const dir = repo();
      commit(dir, row.message, row.author, row.committer);
      const result = check(dir);
      expect(result.status, row.message).toBe(1);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the dependency-update account only with its exact email", () => {
    const dir = repo();
    commit(
      dir,
      "chore: bump a dev package\n\nSigned-off-by: dependabot[bot] <support@github.com>",
      DEPENDABOT,
      { name: "dependabot[bot]", email: DEPENDABOT_EMAIL },
    );
    commit(
      dir,
      `chore: record the same account\n\nCo-authored-by: ${DEPENDABOT}`,
    );
    const result = check(dir);
    expect(result.status, result.out).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
