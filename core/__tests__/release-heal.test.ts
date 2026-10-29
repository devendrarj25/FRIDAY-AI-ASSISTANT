/**
 * Self-healing release pipeline.
 *
 * `release-engine.cjs heal` is the ONE repair every build and publish path
 * runs (PR Validation, Release prepare + publish, Test EXE build, the local
 * build-windows.cmd). It must repair every kind of version/documentation drift
 * from package.json alone, leave a healthy tree untouched, be idempotent, and
 * refuse (loudly) only what cannot be derived.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("../../scripts/release-engine.cjs");
const ROOT = path.resolve(__dirname, "..", "..");

const HEADER =
  "# FRIDAY — Changelog\n\nWhat changed in each released version. Each entry is the owner-facing What's New for that version, kept in sync with releases/notes.\n";

function notes(version: string, summary = "one real change.") {
  return [
    `## FRIDAY v${version}`,
    "",
    "**Released:** 2026-09-03  ",
    "**Channel:** Stable (official release)  ",
    `**Summary:** ${summary}`,
    "",
    "### What's New",
    "",
    "#### Fixed",
    "",
    `- ${summary}`,
    "",
  ].join("\n");
}

/** A miniature FRIDAY checkout that is fully in sync at `version`. */
function fixture(version: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-heal-"));
  fs.mkdirSync(path.join(dir, "src/lib/friday"), { recursive: true });
  fs.mkdirSync(path.join(dir, "releases/notes"), { recursive: true });
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(dir, rel), text);
  write("package.json", `${JSON.stringify({ name: "friday", version }, null, 2)}\n`);
  write(
    "package-lock.json",
    `${JSON.stringify({ name: "friday", version, packages: { "": { version } } }, null, 2)}\n`,
  );
  write(
    "src/lib/friday/version.ts",
    `const compiled = "";\nexport const APP_VERSION = compiled || "${version}";\n`,
  );
  write("LICENSE", `MIT License\n\nCopyright (c) 2025-${new Date().getUTCFullYear()} FRIDAY\n`);
  write(`releases/notes/v${version}.md`, notes(version));
  write("CHANGELOG.md", engine.updateChangelog(HEADER, notes(version), version));
  write(
    "INSTALL.md",
    `# Install\n\nShipping version: **${version}**\n\nArtifact: FRIDAY-Setup-${version}.exe\n`,
  );
  write("VERSIONING.md", `# Versioning\n\n**Current shipping version: ${version}**\n`);
  write(
    "README.md",
    [
      "# FRIDAY",
      "",
      `**Version:** ${version}`,
      "",
      "## 8. Something",
      "",
      "text",
      "",
      engine.whatsNewSection(version, { root: dir }).trimEnd(),
      "",
      "---",
      "",
      "## 10. Licence",
      "",
      "MIT",
      "",
    ].join("\n"),
  );
  const parsed = engine.parseFridayVersion(version);
  engine.writeCanonicalFile(engine.identityFromParsed(parsed), { root: dir });
  return dir;
}

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
/** Every file under `dir`, keyed by its POSIX relative path (the engine reports
 *  `releases/notes/vX.md` with forward slashes on every platform, so the keys
 *  must not depend on `path.sep` - the prepare stage runs on windows-latest). */
const snapshot = (dir: string) => {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        out.set(path.relative(dir, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return out;
};

describe("release self-heal", () => {
  it("reports a healthy tree as release-ready and leaves it byte-for-byte untouched", () => {
    const dir = fixture("1.7.0");
    const before = snapshot(dir);
    const health = engine.releaseHealth({ root: dir });
    expect(health.ok, health.issues.join("\n")).toBe(true);
    const result = engine.healRelease({ root: dir });
    expect(result.ok).toBe(true);
    expect(result.repaired).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("repairs every kind of drift from package.json alone, then is a no-op", () => {
    const dir = fixture("1.7.0");
    const healthy = snapshot(dir);
    const write = (rel: string, text: string) => fs.writeFileSync(path.join(dir, rel), text);

    // stale version sources
    write("package-lock.json", read(dir, "package-lock.json").replace(/1\.7\.0/g, "1.6.6"));
    write(
      "src/lib/friday/version.ts",
      read(dir, "src/lib/friday/version.ts").replace("1.7.0", "1.6.6"),
    );
    // stale governed documents (front-matter line + artifact name + declaration)
    write("INSTALL.md", read(dir, "INSTALL.md").replace(/1\.7\.0/g, "1.6.6"));
    write("VERSIONING.md", read(dir, "VERSIONING.md").replace("1.7.0", "1.6.6"));
    // duplicated changelog heading (a hand-edit / double prepare)
    write(
      "CHANGELOG.md",
      `${read(dir, "CHANGELOG.md")}\n## v1.7.0\n\n- Changes\n\nWork in progress\n`,
    );
    // missing per-release notes
    fs.unlinkSync(path.join(dir, "releases/notes/v1.7.0.md"));
    // README "What is new" hand-grown into a third copy
    write(
      "README.md",
      read(dir, "README.md").replace(
        "## 9. What is new in 1.7.0",
        "## 9. What is new in 1.6.6\n\nlots of prose",
      ),
    );
    // stale copyright year
    write("LICENSE", "MIT License\n\nCopyright (c) 2024 FRIDAY\n");

    const health = engine.releaseHealth({ root: dir });
    expect(health.ok).toBe(false);
    expect(health.issues.join("\n")).toContain("package-lock.json declares 1.6.6");
    expect(health.issues.join("\n")).toContain("version.ts falls back to 1.6.6");
    expect(health.issues.join("\n")).toContain("INSTALL.md:3 declares 1.6.6");
    expect(health.issues.join("\n")).toContain("CHANGELOG.md repeats ## v1.7.0");
    expect(health.issues.join("\n")).toContain("releases/notes/v1.7.0.md is missing");
    expect(health.issues.join("\n")).toContain('README.md "What is new"');
    expect(health.issues.join("\n")).toContain("LICENSE copyright year");

    const result = engine.healRelease({ root: dir });
    expect(result.ok, result.after.issues.join("\n")).toBe(true);
    expect(result.repaired).toEqual(
      expect.arrayContaining([
        "package-lock.json",
        "src/lib/friday/version.ts",
        "LICENSE",
        "CHANGELOG.md",
        "releases/notes/v1.7.0.md",
        "README.md",
        "INSTALL.md",
        "VERSIONING.md",
      ]),
    );

    // The reviewed write-up won: the changelog is back to exactly one section
    // and the notes were rebuilt from it, so every document agrees again.
    const after = snapshot(dir);
    expect(engine.uniqueChangelogHeadings(after.get("CHANGELOG.md")).keys).toEqual(["1.7.0"]);
    expect(after.get("CHANGELOG.md")).toBe(healthy.get("CHANGELOG.md"));
    expect(after.get("releases/notes/v1.7.0.md")).toBe(healthy.get("releases/notes/v1.7.0.md"));
    expect(after.get("README.md")).toBe(healthy.get("README.md"));
    expect(after.get("INSTALL.md")).toBe(healthy.get("INSTALL.md"));
    expect(after.get("package-lock.json")).toBe(healthy.get("package-lock.json"));
    expect(after.get("src/lib/friday/version.ts")).toBe(healthy.get("src/lib/friday/version.ts"));

    // idempotent
    const again = engine.healRelease({ root: dir });
    expect(again.repaired).toEqual([]);
    expect(snapshot(dir)).toEqual(after);
  });

  it("carries a brand-new version into every document and generates its changelog + notes", () => {
    const dir = fixture("1.7.0");
    const result = engine.healRelease({
      root: dir,
      version: "1.7.1",
      date: new Date("2026-09-03T00:00:00Z"),
    });
    expect(result.ok, result.after.issues.join("\n")).toBe(true);
    expect(JSON.parse(read(dir, "package.json")).version).toBe("1.7.1");
    expect(read(dir, "src/lib/friday/version.ts")).toContain('compiled || "1.7.1"');
    expect(read(dir, "INSTALL.md")).toContain("Shipping version: **1.7.1**");
    expect(read(dir, "INSTALL.md")).toContain("FRIDAY-Setup-1.7.1.exe");
    expect(engine.uniqueChangelogHeadings(read(dir, "CHANGELOG.md")).keys).toEqual([
      "1.7.1",
      "1.7.0",
    ]);
    const generated = read(dir, "releases/notes/v1.7.1.md");
    expect(generated).toContain("## FRIDAY v1.7.1");
    expect(generated).toContain("**Changes since:** v1.7.0");
    expect(read(dir, "README.md")).toContain("## 9. What is new in 1.7.1");
    expect(read(dir, "README.md")).toContain("releases/notes/v1.7.1.md");
    expect(engine.versionDrift({ root: dir }).ok).toBe(true);
  });

  it("uses the release notes as the source when the changelog lost its section", () => {
    const dir = fixture("1.7.0");
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), HEADER);
    const result = engine.healRelease({ root: dir });
    expect(result.ok).toBe(true);
    expect(result.repaired).toEqual(["CHANGELOG.md"]);
    expect(read(dir, "CHANGELOG.md")).toBe(engine.updateChangelog(HEADER, notes("1.7.0"), "1.7.0"));
  });

  it("heals a TEST version's sources only and never rewrites the official documents", () => {
    const dir = fixture("1.7.0");
    const before = snapshot(dir);
    const result = engine.healRelease({ root: dir, version: "1.7.0-test.3" });
    expect(result.ok, result.after.issues.join("\n")).toBe(true);
    expect(JSON.parse(read(dir, "package.json")).version).toBe("1.7.0-test.3");
    expect(read(dir, "src/lib/friday/version.ts")).toContain('compiled || "1.7.0-test.3"');
    for (const rel of [
      "CHANGELOG.md",
      "README.md",
      "INSTALL.md",
      "VERSIONING.md",
      "releases/notes/v1.7.0.md",
    ]) {
      expect(read(dir, rel), rel).toBe(before.get(rel));
    }
  });

  it("refuses what cannot be derived instead of guessing", () => {
    const dir = fixture("1.7.0");
    fs.rmSync(path.join(dir, "config/friday-version.json"), { force: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "friday", version: "next" }, null, 2)}\n`,
    );
    const health = engine.releaseHealth({ root: dir });
    expect(health.ok).toBe(false);
    expect(health.fixable).toBe(false);
    expect(health.issues[0]).toContain("not a FRIDAY version");
    const result = engine.healRelease({ root: dir });
    expect(result.ok).toBe(false);
    expect(result.repaired).toEqual([]);
  });

  it("finds the real repository release-ready (the gate every workflow runs)", () => {
    const health = engine.releaseHealth({ root: ROOT });
    expect(health.issues).toEqual([]);
    expect(health.ok).toBe(true);
  });
});
