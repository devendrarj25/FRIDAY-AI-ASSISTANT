import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
// A zip export has no .git; a real clone always does. These two checks read the
// committed identity, so they only run where a committed identity exists.
const HAS_COMMITTED_IDENTITY = (() => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "-q", "HEAD:config/friday-version.json"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
})();
const engine = require(path.resolve(process.cwd(), "scripts/release-engine.cjs")) as {
  bumpVersion: (previous: string, kind: string) => string;
  compareVersions: (a: string, b: string) => number;
  stableBaseline: (values: string[]) => string;
  detectBump: (subjects: string[]) => string;
  groupChanges: (subjects: string[]) => { name: string; items: string[] }[];
  updateChangelog: (body: string, entry: string, version?: string) => string;
  posixRel: (rel: string) => string;
  CANONICAL_REL: string;
  identityFromParsed: (
    parsed: unknown,
    opts?: { forceFourPart?: boolean },
  ) => { releaseVersion: string };
  parseFridayVersion: (raw: string) => { fourPart: boolean };
  readCanonicalIdentity: (opts?: { root?: string }) => { releaseVersion: string } | null;
  readCanonicalIdentityAtRef: (
    ref: string,
    opts?: { root?: string },
  ) => { releaseVersion: string } | null;
  writeCanonicalFile: (identity: { releaseVersion: string }, opts?: { root?: string }) => boolean;
  plan: (input: { previous: string; type?: string; subjects: string[] }) => {
    version: string;
    tag: string;
    bump: string;
    notes: string;
    sections: unknown[];
  };
};

describe("release engine · versioning", () => {
  it("increments patch for fixes, minor for features and major for breaking changes", () => {
    expect(engine.detectBump(["fix: chat input freeze"])).toBe("patch");
    expect(engine.detectBump(["fix: x", "feat: voice picker"])).toBe("minor");
    expect(engine.detectBump(["feat!: new kernel API"])).toBe("major");
    expect(engine.detectBump(["refactor: BREAKING CHANGE in root layout"])).toBe("major");
  });

  it("applies the increment to the previous released version", () => {
    expect(engine.bumpVersion("v1.0.1", "patch")).toBe("1.0.2");
    expect(engine.bumpVersion("1.0.2", "minor")).toBe("1.1.0");
    expect(engine.bumpVersion("1.1.0", "major")).toBe("2.0.0");
    expect(engine.bumpVersion("1.0.0.0", "revision")).toBe("1.0.0.0");
    expect(engine.bumpVersion("1.0.0.0", "patch")).toBe("1.0.0.1");
    expect(engine.bumpVersion("1.0.0.0", "minor")).toBe("1.0.1.0");
    expect(engine.bumpVersion("1.0.0.0", "major")).toBe("1.1.0.0");
    expect(engine.bumpVersion("1.0.0.0", "extreme")).toBe("2.0.0.0");
  });

  it("never treats an equal or older release as an upgrade", () => {
    expect(engine.compareVersions("v1.2.1", "1.2.0")).toBeGreaterThan(0);
    expect(engine.compareVersions("v1.2.0", "1.2.0")).toBe(0);
    expect(engine.compareVersions("v1.1.9", "1.2.0")).toBeLessThan(0);
  });

  it("uses the highest official version and ignores test prereleases", () => {
    expect(engine.stableBaseline(["v1.3.1", "v1.3.2-test.9", "1.3.2"])).toBe("1.3.2");
    expect(engine.stableBaseline(["", "invalid", "v2.0.0-rc.1"])).toBe("0.0.0");
    expect(engine.stableBaseline(["1.0.0", "1.0.0.0"])).toBe("1.0.0.0");
    expect(engine.stableBaseline(["1.0.0.0", "1.0.0"])).toBe("1.0.0.0");
  });

  it("honours an explicit release type over the detected one", () => {
    const planned = engine.plan({ previous: "v1.2.0", type: "major", subjects: ["fix: typo"] });
    expect(planned.version).toBe("2.0.0");
    expect(planned.tag).toBe("v2.0.0");
  });
});

describe("release engine · changelog", () => {
  it("categorises real commits and drops release/merge noise", () => {
    const sections = engine.groupChanges([
      "feat(models): add Gemini provider",
      "fix: overlay stays on top",
      "perf: faster boot",
      "security: gate tool permissions",
      "chore: bump deps",
      "Merge branch 'main'",
      "release: v1.2.0",
    ]);
    const names = sections.map((s) => s.name);
    expect(names).toEqual(["Added", "Fixed", "Security", "Performance"]);
    expect(sections[0]?.items).toEqual(["FRIDAY now includes Gemini provider."]);
    expect(JSON.stringify(sections)).not.toContain("Merge branch");
    expect(JSON.stringify(sections)).not.toContain("release: v1.2.0");
  });

  it("invents nothing when there are no changes", () => {
    const planned = engine.plan({ previous: "v1.2.0", subjects: [] });
    expect(planned.sections).toHaveLength(0);
    expect(planned.notes).toContain(
      "This update refreshes how FRIDAY is packaged and checked, so the app you install stays consistent.",
    );
    expect(planned.version).toBe("1.2.1");
  });

  it("prepends a release entry without losing earlier history", () => {
    const first = engine.updateChangelog("", "## v1.0.0\n\n- first\n");
    const second = engine.updateChangelog(first, "## v1.0.1\n\n- second\n");
    expect(second.indexOf("v1.0.1")).toBeLessThan(second.indexOf("v1.0.0"));
    expect(second).toContain("- first");
  });

  it("keeps one changelog body per version and prefers a real write-up over a stub", () => {
    const dup = [
      "# FRIDAY — Changelog",
      "",
      "What changed in each released version. Each entry is the owner-facing What's New for that version, kept in sync with releases/notes.",
      "",
      "## v1.6.5",
      "",
      "#### Technical",
      "- Changes",
      "- Work in progress",
      "",
      "## v1.6.4",
      "",
      "- stub",
      "",
      "## v1.6.5",
      "",
      "#### Fixed",
      "- Silent-install folder is honoured again.",
      "",
    ].join("\n");
    const next = engine.updateChangelog(dup, "## v1.6.6\n\n- next\n", "1.6.6");
    const heads = [...next.matchAll(/^## v(\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]);
    expect(heads).toEqual(["1.6.6", "1.6.5", "1.6.4"]);
    expect(next).toContain("Silent-install folder is honoured again.");
    expect(next).not.toContain("- Work in progress");
  });
});

describe("release engine · staged files", () => {
  it("stages every governed document through the engine, not a hand-kept list", () => {
    const yml = readFileSync(resolve(process.cwd(), ".github/workflows/release.yml"), "utf8");
    expect(yml).toContain("release-engine.cjs files");
    expect(yml).toContain("git add --pathspec-from-file=.release-files.txt");
    expect(yml).not.toContain("xargs -a .release-files.txt git add --");
    // The old hand-maintained list silently dropped AUDIT.md and docs/FRIDAY_*.
    expect(yml).not.toMatch(/git add package\.json package-lock\.json CHANGELOG\.md/);
  });

  it("lists AUDIT.md and the governed docs among the files a bump rewrites", () => {
    const out = execFileSync(
      process.execPath,
      [resolve(process.cwd(), "scripts/release-engine.cjs"), "files"],
      { encoding: "utf8" },
    ).split("\n");
    for (const f of ["package.json", "AUDIT.md", "docs/FRIDAY_BUILD_AND_RELEASE.md"]) {
      expect(out).toContain(f);
    }
  });

  it.skipIf(!HAS_COMMITTED_IDENTITY)(
    "reads the canonical identity from a git ref, not the working tree",
    () => {
      const cli = resolve(process.cwd(), "scripts/release-engine.cjs");
      const fromRef = execFileSync(
        process.execPath,
        [cli, "identity", "--ref", "HEAD", "--field", "releaseVersion"],
        { encoding: "utf8" },
      ).trim();
      const fromHead = engine.readCanonicalIdentityAtRef("HEAD");
      expect(fromHead?.releaseVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(fromRef).toBe(fromHead?.releaseVersion);
      // Official prepare stamps the working tree, then runs npm test before
      // committing. --ref HEAD must stay the last commit even when the file on
      // disk already shows the next version. Do not assert equality with the
      // working tree.
      expect(() =>
        execFileSync(process.execPath, [cli, "identity", "--ref", "not-a-real-ref"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ).toThrow();
    },
  );

  it("does not treat an uncommitted stamp as HEAD", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-identity-ref-"));
    try {
      mkdirSync(path.join(dir, "config"), { recursive: true });
      const committed = engine.identityFromParsed(engine.parseFridayVersion("1.0.0.1"), {
        forceFourPart: true,
      });
      const stamped = engine.identityFromParsed(engine.parseFridayVersion("1.0.0.2"), {
        forceFourPart: true,
      });
      engine.writeCanonicalFile(committed, { root: dir });
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "friday-test@local"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "FRIDAY test"], { cwd: dir });
      execFileSync("git", ["add", engine.posixRel(engine.CANONICAL_REL)], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "committed identity"], { cwd: dir });
      engine.writeCanonicalFile(stamped, { root: dir });
      expect(engine.readCanonicalIdentity({ root: dir })?.releaseVersion).toBe("1.0.0.2");
      expect(engine.readCanonicalIdentityAtRef("HEAD", { root: dir })?.releaseVersion).toBe(
        "1.0.0.1",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!HAS_COMMITTED_IDENTITY)(
    "uses POSIX paths for git rev:path so Windows FileVersion lookups resolve",
    () => {
      expect(engine.posixRel(engine.CANONICAL_REL)).toBe("config/friday-version.json");
      expect(engine.posixRel(engine.CANONICAL_REL)).not.toContain("\\");
      const fromFn = engine.readCanonicalIdentityAtRef("HEAD");
      expect(fromFn?.releaseVersion).toMatch(/^\d+\.\d+\.\d+/);
    },
  );
});
