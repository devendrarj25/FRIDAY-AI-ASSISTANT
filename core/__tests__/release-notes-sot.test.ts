/**
 * FRIDAY · What's New single source of truth
 *
 * The v1.8.0 GitHub body was poisoned because docs-registry.test.ts overwrote
 * the live `release-notes.md` scratch file with a v0.0.0 fixture and did not
 * restore it. These tests lock the repair: isolated docs checks, fail-closed
 * publishing, and one canonical renderer for every surface.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const engine = require_(path.resolve(process.cwd(), "scripts/release-engine.cjs"));
const docs = require_(path.resolve(process.cwd(), "scripts/docs-engine.cjs"));
const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), "utf8");

const FIXTURE = "## v0.0.0\n\ntransient What's New staged by the release workflow\n";
const DATE = new Date("2026-09-04T00:00:00Z");

describe("A. real version never becomes v0.0.0", () => {
  it("throws instead of rendering a missing or zero version", () => {
    expect(() => engine.whatsNew({ version: "", subjects: ["feat: x"] })).toThrow(
      /Unable to resolve canonical release version/,
    );
    expect(() => engine.whatsNew({ version: "0.0.0", subjects: ["feat: x"] })).toThrow(
      /Unable to resolve canonical release version/,
    );
    expect(() => engine.requireReleaseVersion("0.0.0-test")).toThrow(/Unable to resolve/);
    const notes = engine.whatsNew({
      version: "1.8.0",
      previous: "v1.7.1",
      subjects: ["feat: live task coordination"],
      date: DATE,
    });
    expect(notes).toContain("## FRIDAY v1.8.0");
    expect(notes).not.toContain("v0.0.0");
  });
});

describe("B/C. live release-notes.md is never overwritten by a test fixture", () => {
  it("docs-registry source never writes the leaked fixture into the live scratch file", () => {
    const src = read("core/__tests__/docs-registry.test.ts");
    expect(src).not.toMatch(/writeFileSync\(\s*scratch,\s*[\s\S]{0,160}v0\.0\.0/);
    expect(src).not.toMatch(/writeFileSync\(\s*scratch,\s*FIXTURE/);
    expect(src).not.toContain("fs.writeFileSync(\n        scratch");
  });

  it("inspect() itself never writes markdown, so it cannot poison release-notes.md", () => {
    const src = read("scripts/docs-engine.cjs");
    const start = src.indexOf("function inspect(");
    const end = src.indexOf("function main(", start);
    expect(src.slice(start, end)).not.toContain("writeFileSync");
    expect(docs.inspect().unregistered).not.toContain("release-notes.md");
  });

  it("keeps the leaked fixture in an isolated temp file, never in the repo root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-notes-"));
    const isolated = path.join(dir, "release-notes.md");
    fs.writeFileSync(isolated, FIXTURE);
    const scratch = path.join(ROOT, "release-notes.md");
    const before = fs.existsSync(scratch) ? fs.readFileSync(scratch) : null;
    expect(docs.UNREGISTERED_OK.some((rx: RegExp) => rx.test("release-notes.md"))).toBe(true);
    expect(fs.readFileSync(isolated, "utf8")).toBe(FIXTURE);
    expect(fs.existsSync(scratch) ? fs.readFileSync(scratch) : null).toEqual(before);
    if (fs.existsSync(scratch)) {
      expect(fs.readFileSync(scratch, "utf8")).not.toContain(
        "transient What's New staged by the release workflow",
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("D/E/F. GitHub, CHANGELOG and notes file versions must match", () => {
  it("rejects a GitHub body whose version does not match the release", () => {
    const body = engine.whatsNew({
      version: "1.7.1",
      subjects: ["fix: overlay"],
      date: DATE,
    });
    expect(() =>
      engine.guardPublishableRelease({
        version: "1.8.0",
        body,
        packageVersion: "1.8.0",
        tag: "v1.8.0",
        changelog: "## v1.8.0\n",
      }),
    ).toThrow(/does not match release version 1.8.0/);
  });

  it("accepts matching package, tag, changelog, notes file and EXE name", () => {
    const body = engine.whatsNew({
      version: "1.8.0",
      previous: "v1.7.1",
      subjects: ["feat: live coordination", "fix: kernel restart"],
      date: DATE,
    });
    expect(
      engine.guardPublishableRelease({
        version: "1.8.0",
        body,
        packageVersion: "1.8.0",
        tag: "v1.8.0",
        changelog: engine.updateChangelog("", body, "1.8.0"),
        notesFileBody: body,
        setup: "release/FRIDAY-Setup-1.8.0.exe",
      }).ok,
    ).toBe(true);
    expect(engine.extractNotesVersion(body)).toBe("1.8.0");
    expect(engine.changelogEntry(body, "1.8.0")).toMatch(/^## v1.8.0\n/);
  });
});

describe("G/H/I/J. categories, dedupe, merge and bookkeeping", () => {
  it("classifies deterministically, drops duplicates, merges and release bumps", () => {
    const first = engine.groupChanges([
      "feat(kernel): live task coordination",
      "feat(kernel): live task coordination",
      "fix: kernel auto-restart",
      "Merge branch 'main'",
      "Merge pull request #76 from owner/release",
      "release: v1.8.0",
      "chore: bump version",
      "perf: faster progress updates",
      "security: gate paid-model access",
    ]);
    const second = engine.groupChanges([
      "feat(kernel): live task coordination",
      "feat(kernel): live task coordination",
      "fix: kernel auto-restart",
      "Merge branch 'main'",
      "Merge pull request #76 from owner/release",
      "release: v1.8.0",
      "chore: bump version",
      "perf: faster progress updates",
      "security: gate paid-model access",
    ]);
    expect(first).toEqual(second);
    const names = first.map((s: { name: string }) => s.name);
    expect(names).toEqual(["Added", "Fixed", "Security", "Performance"]);
    expect(first[0].items).toEqual(["FRIDAY now includes live task coordination."]);
    expect(JSON.stringify(first)).not.toContain("Merge");
    expect(JSON.stringify(first)).not.toContain("release: v1.8.0");
    expect(JSON.stringify(first)).not.toContain("bump version");
  });
});

describe("K. previous-release range is used", () => {
  // Uses a throwaway git repo, so the result never depends on this checkout's
  // own history (a fresh clone, a zip export and a long-lived repo all behave
  // the same).
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  it("fails closed instead of walking the whole history", () => {
    const missing = engine.resolveCommitRange({ previous: "v0.0.0" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/whole history/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-range-"));
    try {
      git(dir, "init", "-q");
      git(dir, "config", "user.email", "friday-test@local");
      git(dir, "config", "user.name", "FRIDAY test");
      git(dir, "config", "commit.gpgsign", "false");
      fs.writeFileSync(path.join(dir, "a.txt"), "1");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "chore: first release content");
      git(dir, "tag", "v1.0.0.1");
      fs.writeFileSync(path.join(dir, "a.txt"), "2");
      git(dir, "commit", "-qam", "fix: kernel routing heal");
      fs.writeFileSync(path.join(dir, "a.txt"), "3");
      git(dir, "commit", "-qam", "feat: cross-mode nav");

      const unknown = engine.resolveCommitRange({ previous: "v9.9.9", root: dir });
      expect(unknown.ok).toBe(false);
      expect(unknown.error).toMatch(/whole history/);

      const real = engine.resolveCommitRange({ previous: "v1.0.0.1", root: dir });
      expect(real.ok).toBe(true);
      expect(real.subjects).toEqual(["feat: cross-mode nav", "fix: kernel routing heal"]);
      expect(real.subjects).not.toContain("chore: first release content");
      const grouped = JSON.stringify(engine.groupChanges(real.subjects));
      expect(grouped).not.toContain("Merge ");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("L/M. empty and placeholder notes fail closed", () => {
  it("rejects empty, v0.0.0, the leaked fixture and lorem ipsum", () => {
    expect(() => engine.assertPublishableNotes("", { version: "1.8.0" })).toThrow(
      /empty|Unable to resolve|does not declare/,
    );
    expect(() => engine.assertPublishableNotes(FIXTURE, { version: "1.8.0" })).toThrow(
      /forbidden placeholder/,
    );
    expect(() =>
      engine.assertPublishableNotes("## FRIDAY v1.8.0\n\nLorem ipsum dolor sit amet\n", {
        version: "1.8.0",
      }),
    ).toThrow(/forbidden placeholder/);
    expect(() =>
      engine.assertPublishableNotes(
        "## FRIDAY v1.8.0\n\nNo source changes were recorded since v1.7.1\n",
        { version: "1.8.0" },
      ),
    ).toThrow(/forbidden placeholder/);
    expect(() =>
      engine.assertPublishableNotes("## FRIDAY v0.0.0\n\n### What's New\n\n- Real change.\n", {
        version: "1.8.0",
      }),
    ).toThrow(/v0\.0\.0|does not match/);
  });
});

describe("N. GitHub publishing is blocked on version mismatch", () => {
  it("stops when the EXE name or changelog version disagrees", () => {
    const body = engine.whatsNew({
      version: "1.8.0",
      subjects: ["fix: overlay"],
      date: DATE,
    });
    expect(() =>
      engine.guardPublishableRelease({
        version: "1.8.0",
        body,
        packageVersion: "1.8.0",
        tag: "v1.7.1",
        changelog: "## v1.8.0\n",
      }),
    ).toThrow(/GitHub tag is 1\.7\.1/);
    expect(() =>
      engine.guardPublishableRelease({
        version: "1.8.0",
        body,
        packageVersion: "1.8.0",
        setup: "release/FRIDAY-Setup-1.7.1.exe",
      }),
    ).toThrow(/does not include version 1\.8\.0/);
  });
});

describe("O. explicit owner override works when it is real", () => {
  it("keeps a valid owner body and refuses empty or fixture overrides", () => {
    const owner = [
      "## FRIDAY v1.8.0",
      "",
      "### What's New",
      "",
      "#### Added",
      "- New Tender Extract tool for pulling important information from tender documents.",
      "",
    ].join("\n");
    expect(engine.validateOwnerOverride(owner, { version: "1.8.0" }).ok).toBe(true);
    expect(() => engine.validateOwnerOverride("", { version: "1.8.0" })).toThrow(
      /empty owner override/,
    );
    expect(() => engine.validateOwnerOverride(FIXTURE, { version: "1.8.0" })).toThrow(
      /forbidden placeholder/,
    );
  });
});

describe("P. rebuild does not invent new release notes", () => {
  it("keeps the declared version and the workflow replaces assets only", () => {
    const decision = engine.decideRelease({
      mode: "rebuild",
      current: "1.8.0",
      baseline: "1.8.0",
      released: ["1.8.0"],
      subjects: ["feat: something new that must not become a new What's New"],
    });
    expect(decision.action).toBe("rebuild");
    expect(decision.version).toBe("1.8.0");
    const yml = read(".github/workflows/release.yml");
    expect(yml).toContain("no invented release note is created");
    expect(yml).toContain("gh release upload");
  });
});

describe("Q/R. TEST stays TEST; official never receives the fixture", () => {
  it("marks TEST builds and rejects TEST or fixture content on official notes", () => {
    const testNotes = engine.whatsNew({
      version: "1.8.0-test.1",
      previous: "v1.8.0",
      subjects: ["fix: overlay"],
      channel: "test",
      ref: "feature/voice",
      date: DATE,
    });
    expect(testNotes).toContain("TEST BUILD");
    expect(testNotes).toContain("not an official release");
    expect(
      engine.assertPublishableNotes(testNotes, { version: "1.8.0-test.1", channel: "test" }).ok,
    ).toBe(true);
    expect(() =>
      engine.assertPublishableNotes(testNotes, { version: "1.8.0", channel: "stable" }),
    ).toThrow(/TEST/);
    expect(() =>
      engine.assertPublishableNotes(FIXTURE, { version: "1.8.0", channel: "stable" }),
    ).toThrow(/forbidden placeholder/);
  });
});

describe("canonical renderer is the one surface", () => {
  it("plan, whatsNew, changelog and GitHub body share the same categories", () => {
    const subjects = [
      "feat: live task coordination",
      "fix: voice interruption",
      "ui: faster progress updates",
    ];
    const planned = engine.plan({ previous: "v1.7.1", subjects, date: DATE });
    const rendered = engine.whatsNew({
      version: planned.version,
      previous: "v1.7.1",
      subjects,
      date: DATE,
      releaseType: planned.releaseType || planned.bump,
    });
    expect(planned.notes).toBe(rendered);
    expect(planned.sections.map((s: { name: string }) => s.name)).toEqual([
      "Added",
      "Improved",
      "Fixed",
    ]);
    expect(planned.canonical.version).toBe(planned.version);
    expect(rendered).not.toMatch(/src\/|electron\/|\.ts\b/);
    expect(rendered).not.toMatch(/#\d+/);
    expect(engine.changelogEntry(rendered, planned.version)).toContain("### What's New");
  });

  it("CLI notes refuses a zero version", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/release-engine.cjs", "notes", "--version", "0.0.0"],
        {
          cwd: ROOT,
          input: "feat: x\n",
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    ).toThrow(/Unable to resolve canonical release version|Command failed/);
  });
});
