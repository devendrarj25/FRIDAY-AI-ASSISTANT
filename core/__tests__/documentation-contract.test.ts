/**
 * FRIDAY · documentation contract
 *
 * Build, release, version, channel and update behaviour is only "done" when the
 * documents describing it exist and describe the CURRENT reality. This test
 * fails on documentation drift exactly like any other regression.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// Same CJS bridge version-sync.test.ts uses: the release engine is a .cjs script.
const engine = require("../../scripts/release-engine.cjs") as {
  whatsNewSection: (v: string) => string;
  readCanonicalIdentity: (opts?: { root?: string }) => { releaseVersion: string };
};

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const version = engine.readCanonicalIdentity({ root: ROOT }).releaseVersion;

const REQUIRED = [
  "README.md",
  "INSTALL.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "docs/FRIDAY_BUILD_AND_RELEASE.md",
  "docs/FRIDAY_MERGE_FLOW.md",
  "docs/FRIDAY_STORAGE_CONTRACT.md",
  "docs/README.md",
  "docs/FRIDAY_GITHUB_ACTIONS.md",
  "docs/FRIDAY_FEATURES.md",
  "docs/FRIDAY_USER_GUIDE.md",
  "docs/FRIDAY_IMPORT_FORMAT.md",
];

describe("documentation", () => {
  it("ships every required document", () => {
    for (const file of REQUIRED) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} is missing`).toBe(true);
      expect(read(file).trim().length).toBeGreaterThan(200);
    }
  });

  it("documents the current shipping version where the version is named", () => {
    for (const file of ["README.md", "INSTALL.md", "docs/FRIDAY_STORAGE_CONTRACT.md"]) {
      const body = read(file);
      expect(body, `${file} does not name v${version}`).toContain(version);
      // Installer/portable filenames must never advertise a version that is
      // not the one this checkout actually builds.
      const artifacts = [
        ...body.matchAll(/FRIDAY-(?:Test-)?(?:Setup|Portable)-(\d+\.\d+\.\d+(?:\.\d+)?)/g),
      ]
        .map((m) => m[1])
        .filter((v) => v !== version);
      expect(artifacts, `${file} references stale artifact versions`).toEqual([]);
    }
  });

  it("states the release modes and the rebuild-keeps-the-version rule", () => {
    const guide = read("docs/FRIDAY_BUILD_AND_RELEASE.md");
    for (const token of ["rebuild", "update", "auto", "friday-update.json", "SHA256"]) {
      expect(guide.toLowerCase()).toContain(token.toLowerCase());
    }
    expect(guide).toMatch(/same version/i);
  });

  it("keeps the documentation-sync rule written down", () => {
    expect(read("docs/FRIDAY_BUILD_AND_RELEASE.md")).toMatch(/documentation contract/i);
    expect(read("CONTRIBUTING.md")).toMatch(/must update the affected documents/i);
  });

  it("links the build and contribution guides from the README", () => {
    const readme = read("README.md");
    expect(readme).toContain("docs/FRIDAY_BUILD_AND_RELEASE.md");
    expect(readme).toContain("CONTRIBUTING.md");
  });
});

/**
 * Ownership: the project is private software, so the licence terms are part of
 * the documentation contract, not an optional extra.
 */
describe("licence", () => {
  it("ships a real LICENSE naming the owner and its actual terms", () => {
    const licence = read("LICENSE");
    expect(licence.trim().length).toBeGreaterThan(1000);
    expect(licence).toContain("Devendra Singh Meena");
    expect(licence).toMatch(/Copyright \(c\) \d{4}/);
    for (const clause of ["NO REDISTRIBUTION", "ATTRIBUTION", "NO HARMFUL USE", "NO WARRANTY"]) {
      expect(licence, clause).toContain(clause);
    }
    // A personal-use licence must never be mistaken for an open one.
    expect(licence).not.toMatch(/MIT License|Apache License/);
  });

  it("is linked from the README's ownership section", () => {
    expect(read("README.md")).toContain("[LICENSE](LICENSE)");
  });
});

/**
 * One topic, one document: the full write-up lives in CHANGELOG.md and in
 * releases/notes/vX.Y.Z.md. README's "What is new" is a summary plus links and
 * must never grow back into a third copy.
 */
describe("README what-is-new section", () => {
  const readme = read("README.md").split("\n");
  const start = readme.findIndex((line) => /^##\s*9\.\s*What is new in/.test(line));
  const end = readme.findIndex((line, i) => i > start && /^##\s/.test(line));
  // The rule before the next heading belongs to that heading, not to this section.
  const section = readme
    .slice(start, end)
    .join("\n")
    .replace(/\n+---\s*$/, "")
    .trimEnd();

  it("exists and stays short", () => {
    expect(start).toBeGreaterThan(-1);
    expect(section.split("\n").filter((line) => line.trim()).length).toBeLessThanOrEqual(8);
  });

  it("points at the two documents that own the detail", () => {
    const body = section;
    expect(body).toContain("[CHANGELOG.md](CHANGELOG.md)");
    expect(body).toContain(`releases/notes/v${version}.md`);
  });

  it("is regenerated by the release engine, idempotently", () => {
    const generated = engine.whatsNewSection(version).trimEnd().split("\n");
    expect(section).toBe(generated.join("\n"));
  });
});

describe("capability import documentation", () => {
  it("documents the real import format and is indexed", () => {
    const doc = read("docs/FRIDAY_IMPORT_FORMAT.md");
    for (const token of ["skill.json", "manifest.json", "resolveTree", "selfTest", "segment"]) {
      expect(doc, token).toContain(token);
    }
    expect(read("docs/README.md")).toContain("FRIDAY_IMPORT_FORMAT.md");
  });
});
