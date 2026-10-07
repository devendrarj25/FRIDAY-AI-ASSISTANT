/**
 * FRIDAY version-system reset (friday-2 epoch).
 *
 * Public product version is four-part (1.0.0.0). npm/electron-builder keep a
 * three-part SemVer encoding (1.0.0). config/friday-version.json is the only
 * place a developer changes. These tests lock the mapping, comparator, bump
 * rules, fail-closed guards, What's New-after-baseline, and the rule that a
 * release-line reset is not a workspace data reset.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("../../scripts/release-engine.cjs");
const workspace = require("../../electron/workspace.cjs");
const ROOT = path.resolve(__dirname, "..", "..");
const current = () => engine.readCanonicalIdentity({ root: ROOT });

function fixture(version: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-epoch-"));
  fs.mkdirSync(path.join(dir, "src/lib/friday"), { recursive: true });
  fs.mkdirSync(path.join(dir, "releases/notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "installer/build"), { recursive: true });
  const identity = engine.identityFromParsed(engine.parseFridayVersion(version), {
    forceFourPart: engine.parseFridayVersion(version).fourPart,
  });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "friday", version: identity.npmVersion }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    `${JSON.stringify({ name: "friday", version: identity.npmVersion, packages: { "": { version: identity.npmVersion } } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "src/lib/friday/version.ts"),
    `const compiled = "";\nexport const APP_VERSION = compiled || "${identity.releaseVersion}";\n`,
  );
  engine.writeCanonicalFile(identity, { root: dir });
  engine.writeNsisVersionHeader(identity, { root: dir });
  return { dir, identity };
}

describe("version system reset · canonical identity", () => {
  it("ships a four-part friday-2 identity; 1.0.0.0 remains the published baseline", () => {
    const identity = current();
    expect(identity.fourPart).toBe(true);
    expect(identity.epoch).toBe(engine.EPOCH_FRIDAY2);
    expect(identity.releaseVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(identity.displayVersion).toBe(identity.releaseVersion);
    expect(identity.npmVersion).toBe(`${identity.major}.${identity.minor}.${identity.patch}`);
    expect(identity.tag).toBe(`v${identity.releaseVersion}`);
    expect(identity.windowsFileVersion).toBe(
      `${identity.major}.${identity.minor}.${identity.patch}.${identity.revision}`,
    );
    expect(identity.buildNumber).toBe(String(identity.revision));
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version).toBe(
      identity.npmVersion,
    );
    expect(fs.readFileSync(path.join(ROOT, "src/lib/friday/version.ts"), "utf8")).toContain(
      `compiled || "${identity.releaseVersion}"`,
    );
    expect(fs.existsSync(path.join(ROOT, "releases/notes/v1.0.0.0.md"))).toBe(true);
    expect(engine.compareBuilds(identity.releaseVersion, "1.0.0.0")).toBeGreaterThanOrEqual(0);
  });

  it("keeps the next revision at 1.0.0.1, not 1.0.1", () => {
    const next = engine.nextVersion("1.0.0.0", "auto", ["fix: overlay clip"]);
    expect(next.bump).toBe("patch");
    expect(next.version).toBe("1.0.0.1");
    expect(next.tag).toBe("v1.0.0.1");
    expect(engine.bumpVersion("1.0.0.0", "patch")).toBe("1.0.0.1");
    expect(engine.bumpVersion("1.0.0.0", "minor")).toBe("1.0.1.0");
    expect(engine.bumpVersion("1.0.0.0", "major")).toBe("1.1.0.0");
    expect(engine.bumpVersion("1.0.0.0", "extreme")).toBe("2.0.0.0");
    expect(engine.bumpVersion("1.0.0.0", "revision")).toBe("1.0.0.0");
  });

  it("compares four-part, legacy and npm encoding numerically", () => {
    expect(engine.compareBuilds("1.0.0.1", "1.0.0.0")).toBeGreaterThan(0);
    expect(engine.compareBuilds("1.0.0.0", "1.8.0")).toBeGreaterThan(0);
    expect(engine.compareBuilds("1.0.0.0", "1.0.0")).toBe(0);
    expect(engine.compareBuilds("1.0.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(engine.compareBuilds("1.0.0.0", "1.0.0.0")).toBe(0);
    expect(engine.compareBuilds("1.0.0.0-test.2", "1.0.0.0-test.1")).toBeGreaterThan(0);
    expect(engine.compareBuilds("1.0.0.0", "1.0.0.0-test.1")).toBeGreaterThan(0);
    expect(engine.compareBuilds("1.8.0", "1.7.1")).toBeGreaterThan(0);
  });

  it("never silently substitutes 1.0.1 for public 1.0.0.1 in package metadata", () => {
    const { dir } = fixture("1.0.0.0");
    const applied = engine.applyVersion("1.0.0.1", { root: dir, docs: false });
    expect(applied.version).toBe("1.0.0.1");
    expect(applied.npmVersion).toBe("1.0.0");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version).toBe(
      "1.0.0",
    );
    const canonical = JSON.parse(
      fs.readFileSync(path.join(dir, "config/friday-version.json"), "utf8"),
    );
    expect(canonical.revision).toBe(1);
    expect(engine.readCanonicalIdentity({ root: dir }).releaseVersion).toBe("1.0.0.1");
  });

  it("does not collapse public 1.0.0.0 when apply is given the npm encoding", () => {
    const { dir } = fixture("1.0.0.0");
    const applied = engine.applyVersion("1.0.0", { root: dir, docs: false });
    expect(applied.version).toBe("1.0.0.0");
    expect(engine.readCanonicalIdentity({ root: dir }).fourPart).toBe(true);
  });
});

describe("version system reset · notes, changelog, github, installer", () => {
  it("keeps baseline notes on 1.0.0.0 and filename/version in agreement", () => {
    const notes = fs.readFileSync(path.join(ROOT, "releases/notes/v1.0.0.0.md"), "utf8");
    expect(engine.extractNotesVersion(notes)).toBe("1.0.0.0");
    expect(notes).toContain("## FRIDAY v1.0.0.0");
    expect(notes).toContain("### Baseline");
    expect(notes).toContain("### Included");
    expect(notes).toContain("#### Core");
    expect(notes).toContain("#### AI & Brain");
    expect(notes).toContain("#### Memory");
    expect(notes).toContain("#### Voice");
    expect(notes).toContain("#### Capabilities");
    expect(notes).toContain("#### Tools & Automation");
    expect(notes).toContain("#### Security");
    expect(notes).toContain("#### Installation & Updates");
    expect(notes).toContain("#### Developer/Platform Support");
    expect(notes).toContain("This is FRIDAY 1.0.0.0, the first public version");
    expect(notes).toContain("FRIDAY 1.0.0.0 is the first public version.");
    expect(notes).toContain("**Baseline:** first public version");
    expect(notes).not.toContain("first tracked build");
    expect(notes).not.toMatch(/\b(?:pull request|github|repository)\b/i);
    expect(notes).not.toMatch(/v0\.0\.0/);
    expect(notes).not.toContain("FRIDAY v1.8.0");
    expect(notes).not.toContain("FRIDAY v1.7.1");
    expect(notes).not.toMatch(/1\.8\.0|LEGACY RELEASE LINE/);
    engine.assertPublishableNotes(notes, { version: "1.0.0.0", requireChanges: false });
  });

  it("puts the current public identity first in CHANGELOG; 1.0.0.0 stays as baseline", () => {
    const identity = current();
    const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
    const headings = engine.uniqueChangelogHeadings(changelog);
    expect(headings.unique).toBe(true);
    expect(headings.keys[0]).toBe(identity.releaseVersion);
    expect(headings.keys).toContain("1.0.0.0");
    expect(headings.keys).not.toContain("1.8.0");
    expect(engine.extractChangelogVersion(changelog)).toBe(identity.releaseVersion);
    const own = engine.changelogSectionFor(changelog, identity.releaseVersion);
    expect(own).toBeTruthy();
    for (const rx of engine.CHANGELOG_HEADER_LEAKS) {
      expect(own, String(rx)).not.toMatch(rx);
    }
    const expected = engine
      .changelogEntry(
        fs.readFileSync(
          path.join(ROOT, "releases/notes", `v${identity.releaseVersion}.md`),
          "utf8",
        ),
        identity.releaseVersion,
      )
      .trim();
    expect(own.trim()).toBe(expected);
  });

  it("drops leftover changelog intro prose instead of attaching it to a version section", () => {
    const dirty = [
      "# FRIDAY — Changelog",
      "",
      "What changed in each released version. Each entry is the owner-facing What's New for that version, kept in sync with releases/notes.",
      "",
      "The newest section is the current public line (friday-2, four-part).",
      "",
      "## v1.0.0.0",
      "",
      "**Summary:** baseline.",
      "",
      "The newest section is the current public line (friday-2, four-part).",
      "",
      "## v1.8.0",
      "",
      "**Summary:** legacy.",
      "",
    ].join("\n");
    const notes = engine.baselineWhatsNew({
      version: "1.0.0.0",
      date: new Date("2026-09-04T00:00:00Z"),
    });
    const cleaned = engine.updateChangelog(dirty, notes, "1.0.0.0");
    expect(cleaned.startsWith("# FRIDAY — Changelog")).toBe(true);
    expect(cleaned).not.toContain("The newest section is the current public line");
    expect(engine.uniqueChangelogHeadings(cleaned).keys[0]).toBe("1.0.0.0");
    expect(engine.uniqueChangelogHeadings(cleaned).keys).toContain("1.8.0");
    expect(engine.updateChangelog(cleaned, notes, "1.0.0.0")).toBe(cleaned);
  });

  it("current project documents do not catalog older public lines", () => {
    const files = [
      "README.md",
      "AUDIT.md",
      "FRIDAY_STATE.md",
      "AGENTS.md",
      "VERSIONING.md",
      "CHANGELOG.md",
      "releases/notes/v1.0.0.0.md",
      "CONTRIBUTING.md",
      "RELEASE.md",
    ];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(text, rel).not.toMatch(/1\.8\.0/);
      expect(text, rel).not.toMatch(/1\.7\.1/);
      expect(text, rel).not.toMatch(/LEGACY RELEASE LINE/);
    }
    const notesDir = path.join(ROOT, "releases/notes");
    const noteFiles = fs
      .readdirSync(notesDir)
      .filter((name) => name.endsWith(".md"))
      .sort();
    const identity = current();
    expect(noteFiles).toContain("v1.0.0.0.md");
    expect(noteFiles).toContain(`v${identity.releaseVersion}.md`);
    expect(noteFiles).not.toContain("v1.8.0.md");
    expect(noteFiles).not.toContain("v1.7.1.md");
    expect(noteFiles).not.toContain("v0.0.0.md");
  });

  it("keeps README What is new on the public version", () => {
    const identity = current();
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    expect(readme).toContain(`## 9. What is new in ${identity.releaseVersion}`);
    expect(readme).toContain(`releases/notes/v${identity.releaseVersion}.md`);
  });

  it("uses the public identity for GitHub release artifact names", () => {
    const identity = current();
    expect(identity.tag).toBe(`v${identity.releaseVersion}`);
    const flags = engine.packFlags(identity);
    expect(flags.setupArtifact).toBe(`FRIDAY-Setup-${identity.releaseVersion}.exe`);
    expect(flags.portableArtifact).toBe(`FRIDAY-Portable-${identity.releaseVersion}.exe`);
    expect(flags.setupArtifact).not.toBe(`FRIDAY-Setup-${identity.npmVersion}.exe`);
    engine.guardPublishableRelease({
      version: "1.0.0.0",
      body: fs.readFileSync(path.join(ROOT, "releases/notes/v1.0.0.0.md"), "utf8"),
      packageVersion: "1.0.0",
      notesFileBody: fs.readFileSync(path.join(ROOT, "releases/notes/v1.0.0.0.md"), "utf8"),
      tag: "v1.0.0.0",
      setup: "release/FRIDAY-Setup-1.0.0.0.exe",
      requireChanges: false,
    });
  });

  it("writes installer DisplayVersion from the public identity", () => {
    const identity = current();
    const nsh = fs.readFileSync(path.join(ROOT, "installer/build/friday-version.nsh"), "utf8");
    expect(nsh).toContain(`FRIDAY_DISPLAY_VERSION "${identity.releaseVersion}"`);
    expect(nsh).toContain(`FRIDAY_NPM_VERSION "${identity.npmVersion}"`);
    expect(fs.readFileSync(path.join(ROOT, "installer/build/installer.nsh"), "utf8")).toContain(
      "friday-version.nsh",
    );
    expect(fs.readFileSync(path.join(ROOT, "installer/build/installer.nsh"), "utf8")).toContain(
      "FRIDAY_DISPLAY_VERSION",
    );
  });

  it("keeps TEST prereleases on the public four-part line and off the official channel", () => {
    expect(engine.testVersion("1.0.0.0", []).version).toBe("1.0.0.0-test.1");
    expect(engine.testVersion("1.0.0.0", ["v1.0.0.0-test.1"]).version).toBe("1.0.0.0-test.2");
    expect(engine.isTestVersion("1.0.0.0-test.1")).toBe(true);
    expect(engine.isTestVersion("1.0.0.0")).toBe(false);
    expect(engine.isStableVersion("1.0.0.0")).toBe(true);
    const testId = engine.identityFromParsed(engine.parseFridayVersion("1.0.0.0-test.1"), {
      forceFourPart: true,
    });
    expect(testId.windowsFileVersion).toBe("1.0.0.0");
    expect(testId.npmVersion).toBe("1.0.0-test.1");
    const flags = engine.packFlags(testId);
    expect(flags.setupArtifact).toBe("FRIDAY-Test-Setup-1.0.0.0-test.1.exe");
    expect(flags.extraArgs).toContain("-c.buildVersion=1.0.0.0");
    expect(flags.extraArgs).toContain("-c.extraMetadata.shortVersion=1.0.0.0");
    expect(flags.extraArgs).toContain("-c.extraMetadata.shortVersionWindows=1.0.0.0");
    expect(testId.channel).toBe("test");
  });
});

describe("version system reset · What's New after baseline", () => {
  it("does not copy the baseline Included list into 1.0.0.1", () => {
    const notes = engine.whatsNew({
      version: "1.0.0.1",
      previous: "v1.0.0.0",
      subjects: [
        "fix: overlay clip on the status chip",
        "feat: owner-visible retry on doctor",
        "perf: faster kernel boot probe",
      ],
      date: new Date("2026-09-04T00:00:00Z"),
    });
    expect(notes).toContain("## FRIDAY v1.0.0.1");
    expect(notes).toContain("**Changes since:** v1.0.0.0");
    expect(notes).toContain("#### Fixed");
    expect(notes).toContain("#### Added");
    expect(notes).toContain("#### Performance");
    expect(notes).not.toContain("### Baseline");
    expect(notes).not.toContain("### Included");
    expect(notes).not.toContain("Core FRIDAY desktop application");
    expect(notes).not.toMatch(/src\/foo\.ts changed|5 files changed/i);
    engine.assertPublishableNotes(notes, { version: "1.0.0.1", requireChanges: true });
  });
});

describe("version system reset · fail-closed and heal", () => {
  it("refuses 0.0.0 and mismatched notes/package/tag", () => {
    expect(() => engine.requireReleaseVersion("0.0.0")).toThrow(/Unable to resolve/);
    expect(() => engine.requireReleaseVersion("0.0.0.0")).toThrow(/Unable to resolve/);
    expect(() => engine.applyVersion("0.0.0", { root: ROOT, docs: false })).toThrow(
      /Unable to resolve/,
    );
    const body = engine.baselineWhatsNew({ version: "1.0.0.0", date: new Date("2026-09-04") });
    expect(() =>
      engine.guardPublishableRelease({
        version: "1.0.0.1",
        body,
        packageVersion: "1.8.0",
        tag: "v1.0.0",
        setup: "release/FRIDAY-Setup-1.8.0.exe",
      }),
    ).toThrow(/Publishing stopped/);
  });

  it("heals derived metadata idempotently at the baseline", () => {
    const health = engine.releaseHealth({ root: ROOT });
    expect(health.ok, health.issues.join("\n")).toBe(true);
    // Tests must not rewrite live CHANGELOG / notes. A healthy tree is the
    // idempotent proof; fixture heal coverage lives in release-heal.test.ts.
    expect(health.issues).toEqual([]);
  });

  it("fails closed when notes declare a different version from the canonical identity", () => {
    const { dir } = fixture("1.0.0.0");
    fs.mkdirSync(path.join(dir, "releases/notes"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "releases/notes/v1.0.0.0.md"),
      "## FRIDAY v1.8.0\n\n**Summary:** stale.\n\n### What's New\n\n#### Fixed\n- stale\n",
    );
    fs.writeFileSync(
      path.join(dir, "CHANGELOG.md"),
      "# FRIDAY — Changelog\n\n## v1.0.0.0\n\n**Summary:** baseline.\n",
    );
    const health = engine.releaseHealth({ root: dir });
    expect(health.ok).toBe(false);
    expect(health.issues.join("\n")).toMatch(/1\.8\.0|does not match/);
  });
});

describe("version system reset · no data reset", () => {
  it("keeps schemaVersion independent of the public release line", () => {
    expect(workspace.SCHEMA_VERSION).toBe(1);
    const yml = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
    expect(yml).toMatch(/deleteAppDataOnUninstall:\s*false/);
  });

  it("does not overwrite existing workspace version.json when the app version changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ws-"));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "version.json"),
      `${JSON.stringify({ version: "1.8.0", schemaVersion: 1, installedAt: "2026-01-01T00:00:00.000Z" }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, "config/first-run.json"),
      `${JSON.stringify({ completed: true, completedAt: 1, version: "1.8.0" }, null, 2)}\n`,
    );
    const result = workspace.ensureRootFiles(dir, { version: "1.0.0.0" });
    expect(result.created).not.toContain("version.json");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "version.json"), "utf8"));
    expect(saved.version).toBe("1.8.0");
    expect(saved.schemaVersion).toBe(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "config/first-run.json"), "utf8")).completed,
    ).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("version system reset · no 0.0.0 fallback in product paths", () => {
  it("does not keep a 0.0.0 renderer fallback or canonical identity", () => {
    const versionTs = fs.readFileSync(path.join(ROOT, "src/lib/friday/version.ts"), "utf8");
    expect(versionTs).not.toMatch(/compiled \|\| "0\.0\.0"/);
    const canonical = fs.readFileSync(path.join(ROOT, "config/friday-version.json"), "utf8");
    expect(canonical).not.toMatch(/"releaseVersion": "0\.0\.0"/);
    expect(engine.readCanonicalIdentity({ root: ROOT }).releaseVersion).not.toMatch(/^0\.0\.0/);
  });
});

describe("version system reset · updater reads public identity", () => {
  it("reports the public identity, not the npm encoding, and orders 1.0.0.0 above 1.8.0", async () => {
    const identity = current();
    const { currentVersion } = await import("../../updater/version-manager/index.ts");
    const { compareVersions } = await import("../../updater/update-checker/index.ts");
    expect(currentVersion(ROOT)).toBe(identity.releaseVersion);
    expect(currentVersion(ROOT)).not.toBe(identity.npmVersion);
    expect(compareVersions("1.0.0.0", "1.8.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0.1", "1.0.0.0")).toBeGreaterThan(0);
  });
});
