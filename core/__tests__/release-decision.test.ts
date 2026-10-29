/**
 * FRIDAY · release decision (rebuild vs update)
 *
 * The Official Release workflow must be able to:
 *   * publish a NEW version (update),
 *   * republish the SAME version's assets (rebuild) without inventing a bump,
 *   * decide by itself (auto) without ever reusing a published version.
 * Documentation always names the version that actually ships.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

const require_ = createRequire(import.meta.url);
const engine = require_(path.resolve(process.cwd(), "scripts/release-engine.cjs")) as {
  decideRelease: (input: Record<string, unknown>) => {
    action: string;
    version?: string;
    tag?: string;
    bump?: string;
    existing?: boolean;
    reason: string;
  };
  releasePreview: (input: Record<string, unknown>) => {
    ok: boolean;
    version?: string;
    tag?: string;
    bump?: string;
  };
  stableConsumed: (...lists: string[][]) => string[];
  syncDocs: (previous: string, clean: string, opts: { root: string }) => string[];
};

const RELEASE = fs.readFileSync(
  path.resolve(process.cwd(), ".github/workflows/release.yml"),
  "utf8",
);

describe("release decision", () => {
  it("keeps the declared version for an explicit rebuild", () => {
    const d = engine.decideRelease({
      mode: "rebuild",
      current: "1.3.2",
      baseline: "1.3.2",
      released: ["1.3.2"],
      subjects: ["feat: something big"],
    });
    expect(d.action).toBe("rebuild");
    expect(d.version).toBe("1.3.2");
    expect(d.existing).toBe(true);
  });

  it("increments for an explicit update", () => {
    const d = engine.decideRelease({
      mode: "update",
      current: "1.3.2",
      baseline: "1.3.2",
      released: ["1.3.2"],
      subjects: ["fix: chat input"],
    });
    expect(d.action).toBe("update");
    expect(d.version).toBe("1.3.3");
  });

  it("keeps an unpublished version when the same release type is requested again", () => {
    const d = engine.decideRelease({
      mode: "update",
      type: "major",
      current: "1.7.0",
      baseline: "1.6.6",
      released: ["1.6.6"],
      subjects: ["feat: workflow introspection"],
    });
    expect(d.action).toBe("update");
    expect(d.version).toBe("1.7.0");
    expect(d.bump).toBe("none");
    expect(d.reason).toContain("has not been published");
  });

  it("skips an unpublished version when the release type changes", () => {
    const same = engine.decideRelease({
      mode: "update",
      type: "patch",
      current: "1.0.1.2",
      baseline: "1.0.1.1",
      released: ["1.0.1.1"],
      subjects: ["fix: pack"],
    });
    expect(same.version).toBe("1.0.1.2");
    expect(same.bump).toBe("none");
    const changed = engine.decideRelease({
      mode: "update",
      type: "major",
      current: "1.0.1.2",
      baseline: "1.0.1.1",
      released: ["1.0.1.1"],
      subjects: ["feat: a larger update"],
    });
    expect(changed.version).toBe("1.1.1.1");
    expect(changed.bump).toBe("major");
    expect(changed.reason).toContain("skipped");
  });

  it("still increments an explicit update once the declared version is published", () => {
    const d = engine.decideRelease({
      mode: "update",
      current: "1.7.0",
      baseline: "1.7.0",
      released: ["1.7.0"],
      subjects: ["fix: settings save"],
    });
    expect(d.version).toBe("1.7.1");
  });

  it("auto rebuilds when nothing releasable landed", () => {
    const d = engine.decideRelease({
      mode: "auto",
      current: "1.3.2",
      baseline: "1.3.2",
      released: ["1.3.2"],
      subjects: ["Merge branch 'main'", "release: v1.3.2"],
    });
    expect(d.action).toBe("rebuild");
    expect(d.version).toBe("1.3.2");
  });

  it("opens a confirm PR when main already declares an unpublished version", () => {
    const d = engine.decideRelease({
      mode: "auto",
      current: "1.3.3",
      baseline: "1.3.2",
      released: ["1.3.2"],
      subjects: ["feat: voice picker"],
    });
    expect(d.action).toBe("update");
    expect(d.version).toBe("1.3.3");
    expect(d.bump).toBe("none");
    expect(d.existing).toBe(false);
  });

  it("still opens a confirm PR when the unpublished version has no new commits", () => {
    const d = engine.decideRelease({
      mode: "auto",
      current: "1.6.6",
      baseline: "1.6.5",
      released: ["1.6.5"],
      subjects: ["Merge branch 'main'", "release: v1.6.5"],
    });
    expect(d.action).toBe("update");
    expect(d.version).toBe("1.6.6");
    expect(d.bump).toBe("none");
  });

  it("previews the same number the workflow will publish", () => {
    const kept = engine.releasePreview({
      mode: "auto",
      current: "1.0.1.2",
      baseline: "1.0.1.2",
      type: "auto",
      released: ["v1.0.1.2"],
      subjects: ["feat: a larger update"],
    });
    expect(kept.ok).toBe(true);
    expect(kept.version).toBe("1.0.1.2");
    expect(kept.bump).toBe("none");
    const major = engine.releasePreview({
      mode: "auto",
      current: "1.0.1.2",
      baseline: "1.0.1.2",
      type: "major",
      released: ["1.0.1.2", "v1.0.1.2-test.3"],
      subjects: ["feat: a larger update"],
    });
    expect(major.version).toBe("1.1.1.2");
    expect(major.bump).toBe("major");
    expect(major.tag).toBe("v1.1.1.2");
    expect(engine.stableConsumed(["v1.0.1.2-test.3"], ["v1.0.1.2"])).toEqual(["1.0.1.2"]);
  });

  it("moves an explicit counter from a never-published line", () => {
    const major = engine.decideRelease({
      mode: "update",
      type: "major",
      current: "1.0.1.2",
      baseline: "1.0.1.2",
      released: [],
      subjects: ["feat: a larger update"],
    });
    expect(major.version).toBe("1.1.1.2");
    expect(major.bump).toBe("major");
    const autoLevel = engine.decideRelease({
      mode: "auto",
      type: "patch",
      current: "1.0.1.2",
      baseline: "1.0.1.2",
      released: [],
      subjects: [],
    });
    expect(autoLevel.version).toBe("1.0.1.3");
    expect(autoLevel.bump).toBe("patch");
  });

  it("opens a confirm PR for the first unpublished public line when nothing is tagged", () => {
    const d = engine.decideRelease({
      mode: "auto",
      current: "1.0.0.0",
      baseline: "1.0.0.0",
      released: [],
      subjects: [],
    });
    expect(d.action).toBe("update");
    expect(d.version).toBe("1.0.0.0");
    expect(d.bump).toBe("none");
    expect(d.existing).toBe(false);
    expect(d.reason).toContain("unreleased v1.0.0.0");
  });

  it("prints the public version, not the npm encoding", () => {
    const out = execFileSync(
      process.execPath,
      [path.resolve(process.cwd(), "scripts/print-public-version.cjs")],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const raw = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "config/friday-version.json"), "utf8"),
    ) as { major: number; minor: number; patch: number; revision: number };
    expect(out.trim()).toBe(`FRIDAY ${raw.major}.${raw.minor}.${raw.patch}.${raw.revision}`);
  });

  it("does not treat a changelog heading as a successful publish", () => {
    const out = execFileSync(
      process.execPath,
      [
        path.resolve(process.cwd(), "scripts/release-engine.cjs"),
        "decide",
        "--mode",
        "update",
        "--current",
        "1.0.0.2",
        "--baseline",
        "1.0.0.2",
        "--type",
        "minor",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const decided = JSON.parse(out) as { version: string; bump: string };
    expect(decided.version).toBe("1.0.1.2");
    expect(decided.bump).toBe("minor");
  });

  it("does not let auto skip a declared version just because the changelog names it", () => {
    const out = execFileSync(
      process.execPath,
      [
        path.resolve(process.cwd(), "scripts/release-engine.cjs"),
        "decide",
        "--mode",
        "auto",
        "--current",
        "1.0.0.2",
        "--baseline",
        "1.0.0.2",
        "--type",
        "auto",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const decided = JSON.parse(out) as { version: string; bump: string };
    expect(decided.version).toBe("1.0.0.2");
    expect(decided.bump).toBe("none");
  });

  it("ignores changelog headings newer than the declared line", () => {
    const shipped = (
      engine as unknown as {
        changelogShippedVersions: (body: string, opts: { atOrBelow: string }) => string[];
      }
    ).changelogShippedVersions("## v1.0.1.0\n\n## v1.0.0.2\n", { atOrBelow: "1.0.0.2" });
    expect(shipped).toEqual(["1.0.0.2"]);
  });

  it("builds publishable notes from commits since a changelog-shipped untagged line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-release-decision-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Devendra Singh Meena"], {
      cwd: dir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.email", "devendrarj25@users.noreply.github.com"], {
      cwd: dir,
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "## v1.0.0.2\n\nShipped line.\n");
    execFileSync("git", ["add", "CHANGELOG.md"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: keep the desk on this PC"], {
      cwd: dir,
      stdio: "ignore",
    });
    fs.appendFileSync(path.join(dir, "CHANGELOG.md"), "\nStill the shipped line.\n");
    execFileSync("git", ["add", "CHANGELOG.md"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "fix: repair the local pack"], {
      cwd: dir,
      stdio: "ignore",
    });
    const subjects = execFileSync(
      process.execPath,
      [
        path.resolve(process.cwd(), "scripts/release-engine.cjs"),
        "commits-since",
        "--previous",
        "v1.0.0.2",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    expect(subjects.trim().length).toBeGreaterThan(0);
    const log = path.join(os.tmpdir(), "friday-commits-since.txt");
    fs.writeFileSync(log, subjects);
    const notes = execFileSync(
      process.execPath,
      [
        path.resolve(process.cwd(), "scripts/release-engine.cjs"),
        "notes",
        "--version",
        "1.0.1.0",
        "--previous",
        "v1.0.0.2",
        "--channel",
        "stable",
        "--type",
        "minor",
        "--log",
        log,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const notesFile = path.join(os.tmpdir(), "friday-notes-1010.md");
    fs.writeFileSync(notesFile, notes);
    const guard = execFileSync(
      process.execPath,
      [
        path.resolve(process.cwd(), "scripts/release-engine.cjs"),
        "guard-notes",
        "--version",
        "1.0.1.0",
        "--file",
        notesFile,
        "--channel",
        "stable",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(guard).toMatch(/publishable/);
    expect(() =>
      execFileSync(
        process.execPath,
        [
          path.resolve(process.cwd(), "scripts/release-engine.cjs"),
          "commits-since",
          "--previous",
          "9.9.9",
        ],
        { cwd: dir, encoding: "utf8" },
      ),
    ).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the first unpublished line when revision is selected", () => {
    const d = engine.decideRelease({
      mode: "update",
      type: "revision",
      current: "1.0.0.0",
      baseline: "1.0.0.0",
      released: [],
      subjects: ["fix: packaging"],
    });
    expect(d.action).toBe("rebuild");
    expect(d.version).toBe("1.0.0.0");
    expect(d.bump).toBe("none");
  });

  it("does not invent the next number when auto runs on a published version", () => {
    const d = engine.decideRelease({
      mode: "auto",
      type: "auto",
      current: "1.3.2",
      baseline: "1.3.2",
      released: ["1.3.2", "1.3.3"],
      subjects: ["fix: something"],
    });
    expect(d.action).toBe("rebuild");
    expect(d.version).toBe("1.3.2");
    expect(d.bump).toBe("none");
  });
});

describe("documentation sync", () => {
  let root = "";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-docs-"));
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "README.md"), "FRIDAY v1.3.2 ships today.\n");
    fs.writeFileSync(path.join(root, "INSTALL.md"), "Install FRIDAY-Setup-1.3.2.exe\n");
    fs.writeFileSync(path.join(root, "docs/FRIDAY_STORAGE_CONTRACT.md"), "contract v1.3.2\n");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("renames the shipping version across every versioned document", () => {
    const touched = engine.syncDocs("1.3.2", "1.3.3", { root });
    expect(touched).toHaveLength(3);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toContain("v1.3.3");
    expect(fs.readFileSync(path.join(root, "INSTALL.md"), "utf8")).toContain(
      "FRIDAY-Setup-1.3.3.exe",
    );
    expect(fs.readFileSync(path.join(root, "docs/FRIDAY_STORAGE_CONTRACT.md"), "utf8")).toContain(
      "v1.3.3",
    );
  });

  it("does nothing when the version is unchanged", () => {
    expect(engine.syncDocs("1.3.2", "1.3.2", { root })).toEqual([]);
  });
});

describe("release workflow wiring", () => {
  it("offers the rebuild / update / auto modes", () => {
    expect(RELEASE).toContain("mode:");
    expect(RELEASE).toContain("rebuild");
    expect(RELEASE).toContain("update");
  });

  it("opens a release PR even when the version on main does not change", () => {
    expect(RELEASE).toContain("steps.plan.outputs.action == 'update'");
    expect(RELEASE).toContain("git commit --allow-empty");
    expect(RELEASE).toContain("confirm merged release PR");
  });

  it("commits the synchronised documents with the release PR", () => {
    // Staged from the engine's own list, so no governed document can be
    // rewritten on disk and then left out of the release commit.
    expect(RELEASE).toContain("release-engine.cjs files");
    expect(RELEASE).toContain("git add --pathspec-from-file=.release-files.txt");
    expect(RELEASE).not.toContain("xargs -a .release-files.txt git add --");
  });

  it("replaces the assets of an existing release instead of failing", () => {
    expect(RELEASE).toContain("gh release upload '${{ steps.plan.outputs.tag }}' --clobber");
  });

  it("still refuses to overwrite a published version in update mode", () => {
    // The refusal now lives in the shared handoff guard, which also names the
    // prepared-but-unmerged version instead of falling back to stale source.
    expect(RELEASE).toContain("release-engine.cjs handoff");
    const engineSrc = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/release-engine.cjs"),
      "utf8",
    );
    expect(engineSrc).toContain("release v${declared} already exists");
    expect(engineSrc).toContain("mode = rebuild to replace its assets");
  });
});

describe("governed documents stay in sync", () => {
  let root = "";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-gov-"));
    fs.writeFileSync(
      path.join(root, "VERSIONING.md"),
      "**Current shipping version: 1.3.2**\n\n| `1.3.2` | Official, stable release | Stable |\n\n1.3.1  <  1.3.2-test.1  <  1.3.2\n",
    );
    fs.writeFileSync(
      path.join(root, "RELEASE.md"),
      "**Current shipping version: 1.3.2**\n\nrelease FRIDAY-Setup-1.3.2.exe\n",
    );
    fs.writeFileSync(path.join(root, "ARCHITECTURE.md"), "**Current shipping version: 1.3.2**\n");
    fs.writeFileSync(
      path.join(root, "SECURITY.md"),
      "**Current shipping version: 1.3.2**\n\n| 1.3.2 (current) | Yes |\n",
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("renames the shipping version in every governance document", () => {
    const touched = engine.syncDocs("1.3.2", "1.3.3", { root });
    expect(touched.sort()).toEqual(
      ["ARCHITECTURE.md", "RELEASE.md", "SECURITY.md", "VERSIONING.md"].sort(),
    );
    for (const f of ["VERSIONING.md", "RELEASE.md", "ARCHITECTURE.md", "SECURITY.md"]) {
      expect(fs.readFileSync(path.join(root, f), "utf8")).toContain(
        "Current shipping version: 1.3.3",
      );
    }
    expect(fs.readFileSync(path.join(root, "RELEASE.md"), "utf8")).toContain(
      "FRIDAY-Setup-1.3.3.exe",
    );
    expect(fs.readFileSync(path.join(root, "SECURITY.md"), "utf8")).toContain(
      "| 1.3.3 (current) |",
    );
    // Illustrative ordering examples are policy text, not the shipping version.
    expect(fs.readFileSync(path.join(root, "VERSIONING.md"), "utf8")).toContain(
      "1.3.1  <  1.3.2-test.1  <  1.3.2",
    );
    expect(fs.readFileSync(path.join(root, "VERSIONING.md"), "utf8")).toContain(
      "| `1.3.3` | Official, stable release |",
    );
  });
});

describe("release workflow commits the governance documents", () => {
  it("stages the version-governed policy files with the release PR", () => {
    expect(RELEASE).toContain("release-engine.cjs files");
    const listed = execFileSync(process.execPath, ["scripts/release-engine.cjs", "files"], {
      encoding: "utf8",
    }).split("\n");
    for (const f of ["VERSIONING.md", "RELEASE.md", "ARCHITECTURE.md", "SECURITY.md", "AUDIT.md"]) {
      expect(listed).toContain(f);
    }
  });
});
