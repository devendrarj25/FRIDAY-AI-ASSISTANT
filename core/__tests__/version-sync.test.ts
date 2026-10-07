/**
 * Documentation/version drift gate.
 *
 * Every governed document must declare exactly the public shipping version
 * from config/friday-version.json, and `applyVersion` must be able to carry a
 * bump into all of them on its own. This is what keeps future releases from
 * shipping stale .md files.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("../../scripts/release-engine.cjs");
const ROOT = path.resolve(__dirname, "..", "..");

const shipping = () => engine.readCanonicalIdentity({ root: ROOT }).releaseVersion as string;
const npmVersion = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string;

describe("version synchronization", () => {
  it("has no stale version declaration in any governed document", () => {
    const report = engine.versionDrift({ root: ROOT });
    expect(report.stale).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.expected).toBe(shipping());
  });

  it("rewrites a stale npm encoding and the versioning identity row", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-npm-encoding-"));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    const parsed = engine.parseFridayVersion("1.0.1.1");
    engine.writeCanonicalFile(engine.identityFromParsed(parsed, { forceFourPart: true }), {
      root: dir,
    });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "friday", version: "1.0.1" }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, "README.md"),
      "Public identity is four-part **1.0.1.1**. `package.json` `version` is the npm encoding `1.0.0`.\n",
    );
    fs.writeFileSync(
      path.join(dir, "VERSIONING.md"),
      [
        "**Current shipping version: 1.0.1.1**",
        "",
        "| Public FRIDAY (`releaseVersion`) | `1.0.0.2` | tag |",
        "| npm / electron-builder (`package.json` `version`) | `1.0.0` | SemVer |",
        "",
        "Ordering example: 1.4.0 < 1.4.1-test.1 < 1.4.1-test.2 < 1.4.1",
      ].join("\n"),
    );
    expect(engine.versionDrift({ root: dir }).ok).toBe(false);
    engine.applyVersion("1.0.1.1", { root: dir });
    const versioning = fs.readFileSync(path.join(dir, "VERSIONING.md"), "utf8");
    expect(versioning).toContain("| Public FRIDAY (`releaseVersion`) | `1.0.1.1` |");
    expect(versioning).toContain("| npm / electron-builder (`package.json` `version`) | `1.0.1` |");
    expect(versioning).toContain("1.4.0 < 1.4.1-test.1 < 1.4.1-test.2 < 1.4.1");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("npm encoding `1.0.1`");
    expect(engine.versionDrift({ root: dir }).stale).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the renderer fallback version in step with the public release version", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/lib/friday/version.ts"), "utf8");
    expect(source).toContain(`compiled || "${shipping()}"`);
  });

  it("ships release notes and a changelog entry for the shipping version", () => {
    const version = shipping();
    expect(fs.existsSync(path.join(ROOT, "releases/notes", `v${version}.md`))).toBe(true);
    const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## v${version}`);
    const unique = engine.uniqueChangelogHeadings(changelog);
    expect(unique.unique, unique.keys.join(",")).toBe(true);
  });

  it("applyVersion rewrites declarations without touching ordering examples", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-version-"));
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "friday", version: "1.4.1" }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(dir, "README.md"), "**Version:** 1.4.1\n");
    fs.writeFileSync(
      path.join(dir, "VERSIONING.md"),
      [
        "**Current shipping version: 1.4.1**",
        "",
        "Ordering example: 1.4.0 < 1.4.1-test.1 < 1.4.1-test.2 < 1.4.1",
        "",
        "Artifact: FRIDAY-Setup-1.4.1.exe",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "docs/FRIDAY_BUILD_AND_RELEASE.md"),
      "# FRIDAY - Build Guide (v1.4.1)\n",
    );

    const applied = engine.applyVersion("1.5.0", { root: dir });
    expect(applied.version).toBe("1.5.0");

    const versioning = fs.readFileSync(path.join(dir, "VERSIONING.md"), "utf8");
    expect(versioning).toContain("**Current shipping version: 1.5.0**");
    expect(versioning).toContain("FRIDAY-Setup-1.5.0.exe");
    // The deliberate ordering example must survive untouched.
    expect(versioning).toContain("1.4.0 < 1.4.1-test.1 < 1.4.1-test.2 < 1.4.1");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("**Version:** 1.5.0");
    expect(fs.readFileSync(path.join(dir, "docs/FRIDAY_BUILD_AND_RELEASE.md"), "utf8")).toContain(
      "(v1.5.0)",
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("versionDrift reports a document that fell behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-drift-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "friday", version: "1.5.0" }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(dir, "README.md"), "**Version:** 1.4.1\n");
    const report = engine.versionDrift({ root: dir });
    expect(report.ok).toBe(false);
    expect(report.stale[0]).toMatchObject({ file: "README.md", found: "1.4.1", expected: "1.5.0" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Regression (v1.5.0 audit): AUDIT.md kept saying "state of the codebase at
   * version 1.4.1", "version stamped `1.4.1`" and "(accepted for 1.4.1)" long
   * after 1.5.0 shipped, because DECLARATION_PATTERNS only matched a handful of
   * structured phrasings. Prose declarations must now be caught and rewritten
   * too - while deliberate ordering/prerelease examples still survive.
   */
  it("catches and repairs prose version declarations, not just structured ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-prose-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "friday", version: "1.5.0" }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, "AUDIT.md"),
      [
        "# FRIDAY - Project Audit (v1.5.0)",
        "Scope: state of the codebase at version **1.4.1**.",
        "| Renderer bundle | version stamped `1.4.1` |",
        "## Known limitations (accepted for 1.4.1)",
        "Ordering example: 1.4.0 < 1.4.1-test.1 < 1.4.1",
      ].join("\n"),
    );

    const before = engine.versionDrift({ root: dir });
    expect(before.ok).toBe(false);
    expect(before.stale.map((s: { line: number }) => s.line)).toEqual([2, 3, 4]);

    engine.applyVersion("1.5.0", { root: dir });
    const audit = fs.readFileSync(path.join(dir, "AUDIT.md"), "utf8");
    expect(audit).toContain("at version **1.5.0**");
    expect(audit).toContain("version stamped `1.5.0`");
    expect(audit).toContain("(accepted for 1.5.0)");
    // Deliberate ordering example must survive untouched.
    expect(audit).toContain("1.4.0 < 1.4.1-test.1 < 1.4.1");
    expect(engine.versionDrift({ root: dir }).stale).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not rewrite published Windows or GitHub evidence as the next version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-evidence-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "friday", version: "1.0.0.1" }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, "AUDIT.md"),
      [
        "# FRIDAY — Project Audit (v1.0.0.0)",
        "Scope: state of the codebase at version **1.0.0.0**.",
        "Last published Official tag remains v1.0.0.0 (`33890144241`).",
        "Windows NSIS is **VERIFIED** for published **1.0.0.0** on windows-latest.",
        "GitHub tag `v1.0.0.1` is **NOT PUBLISHED**.",
        "Packaged identity on windows-latest for that published line:",
        "`FRIDAY|Devendra Singh Meena|1.0.0|1.0.0.0|1.0.0.0`. CI installer smoke passed for v1.0.0.0.",
      ].join("\n"),
    );

    engine.applyVersion("1.0.0.1", { root: dir });
    const audit = fs.readFileSync(path.join(dir, "AUDIT.md"), "utf8");
    expect(audit).toContain("# FRIDAY — Project Audit (v1.0.0.1)");
    expect(audit).toContain("at version **1.0.0.1**");
    expect(audit).toContain("Last published Official tag remains v1.0.0.0 (`33890144241`).");
    expect(audit).toContain("**VERIFIED** for published **1.0.0.0**");
    expect(audit).toContain("GitHub tag `v1.0.0.1` is **NOT PUBLISHED**");
    expect(audit).toContain("`FRIDAY|Devendra Singh Meena|1.0.0|1.0.0.0|1.0.0.0`");
    expect(audit).toContain("installer smoke passed for v1.0.0.0");
    expect(engine.versionDrift({ root: dir }).stale).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the real repository free of prose version drift", () => {
    expect(engine.versionDrift({ root: ROOT }).stale).toEqual([]);
  });

  /**
   * Regression (v1.5.0 follow-up audit): docs/FRIDAY_ARCHITECTURE_BASELINE.md
   * kept saying "baseline locked** on the 1.4.1 checkout" although `syncDocs`
   * had always intended to rewrite that phrase - `versionDrift` simply never
   * audited it, so nothing failed. Same class for the SECURITY.md supported
   * row and the README "What is new in X" heading. Retrospective headings and
   * ordering examples must still survive.
   */
  it("audits baseline-lock, supported-version and current-release declarations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-baseline-"));
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "friday", version: "1.6.0" }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, "docs/FRIDAY_ARCHITECTURE_BASELINE.md"),
      "# FRIDAY - Architecture Baseline (v1.6.0)\nStatus: **baseline locked** on the 1.5.0 checkout.\n",
    );
    fs.writeFileSync(
      path.join(dir, "SECURITY.md"),
      "| 1.5.0 (current) | Yes |\n| Older releases | No |\n",
    );
    fs.writeFileSync(
      path.join(dir, "README.md"),
      [
        "## 9. What is new in 1.5.0",
        "## 9a. What arrived in 1.3.2",
        "Ordering example: 1.4.0 < 1.4.1-test.1 < 1.4.1",
      ].join("\n"),
    );

    const before = engine.versionDrift({ root: dir });
    expect(before.ok).toBe(false);
    expect(
      before.stale.map((s: { file: string; found: string }) => `${s.file}:${s.found}`).sort(),
    ).toEqual([
      "README.md:1.5.0",
      "SECURITY.md:1.5.0",
      "docs/FRIDAY_ARCHITECTURE_BASELINE.md:1.5.0",
    ]);

    engine.applyVersion("1.6.0", { root: dir });
    expect(
      fs.readFileSync(path.join(dir, "docs/FRIDAY_ARCHITECTURE_BASELINE.md"), "utf8"),
    ).toContain("**baseline locked** on the 1.6.0 checkout");
    expect(fs.readFileSync(path.join(dir, "SECURITY.md"), "utf8")).toContain("| 1.6.0 (current) |");
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    expect(readme).toContain("What is new in 1.6.0");
    // History and ordering examples must survive untouched.
    expect(readme).toContain("What arrived in 1.3.2");
    expect(readme).toContain("1.4.0 < 1.4.1-test.1 < 1.4.1");
    expect(engine.versionDrift({ root: dir }).stale).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Regression (v1.4.2 release): the prepared branch already carried the new
   * version in package.json, so `syncDocs` saw previous === clean and returned
   * without repairing a single document. Documentation synchronization must be
   * idempotent - it targets the declaration statements themselves, not a diff
   * against the previous version - while still leaving history alone.
   */
  it("repairs stale declarations even when package.json is already bumped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-idempotent-"));
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "friday", version: "1.4.2" }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(dir, "AUDIT.md"), "**Version:** 1.4.1\n");
    fs.writeFileSync(
      path.join(dir, "VERSIONING.md"),
      [
        "**Current shipping version: 1.4.1**",
        "| `1.4.1` | Official, stable release | Stable |",
        "Ordering example: 1.4.0 < 1.4.1-test.1 < 1.4.1-test.2 < 1.4.1",
        "Artifact: FRIDAY-Setup-1.4.1.exe",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(dir, "docs/README.md"), "# FRIDAY documentation (v1.4.1)\n");

    // Same version in and out: the previous behaviour did nothing at all here.
    const applied = engine.applyVersion("1.4.2", { root: dir });
    expect(applied.version).toBe("1.4.2");

    const versioning = fs.readFileSync(path.join(dir, "VERSIONING.md"), "utf8");
    expect(versioning).toContain("**Current shipping version: 1.4.2**");
    expect(versioning).toContain("| `1.4.2` | Official, stable release | Stable |");
    expect(versioning).toContain("FRIDAY-Setup-1.4.2.exe");
    expect(versioning).toContain("1.4.0 < 1.4.1-test.1 < 1.4.1-test.2 < 1.4.1");
    expect(fs.readFileSync(path.join(dir, "AUDIT.md"), "utf8")).toContain("**Version:** 1.4.2");
    expect(fs.readFileSync(path.join(dir, "docs/README.md"), "utf8")).toContain("(v1.4.2)");
    expect(engine.versionDrift({ root: dir }).stale).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Regression (v1.7.0 release): preparing a version that main already declares
   * re-ran `apply` over a CHANGELOG that already had that version's section, and
   * `updateChangelog` prepended a second `## vX.Y.Z` heading instead of
   * replacing the existing one. version-sync then failed on the duplicate and
   * every Release / Build and Official Publish run died in the prepare stage.
   * Re-adding a version must replace its section in place, keep the newest
   * content, and preserve (and dedupe) all earlier versions in order.
   */
  it("replaces an existing changelog version in place instead of duplicating it", () => {
    const existing = [
      "# FRIDAY — Changelog",
      "",
      "What changed in each released version. Each entry is the owner-facing What's New for that version, kept in sync with releases/notes.",
      "",
      "## v1.7.0",
      "",
      "**Summary:** first cut.",
      "",
      "#### Added",
      "- an original 1.7.0 note",
      "",
      "## v1.6.6",
      "",
      "**Summary:** prior release.",
      "",
      "#### Fixed",
      "- a 1.6.6 fix",
      "",
    ].join("\n");

    const reprepared = engine.updateChangelog(
      existing,
      "## FRIDAY v1.7.0\n\n**Summary:** reviewed cut.\n\n#### Fixed\n- the reviewed 1.7.0 note\n",
      "1.7.0",
    );

    const headings = engine.uniqueChangelogHeadings(reprepared);
    expect(headings.unique, headings.keys.join(",")).toBe(true);
    expect(headings.keys).toEqual(["1.7.0", "1.6.6"]);
    // The freshly generated entry wins for its own version …
    expect(reprepared).toContain("the reviewed 1.7.0 note");
    expect(reprepared).not.toContain("an original 1.7.0 note");
    // … while earlier history survives untouched.
    expect(reprepared).toContain("a 1.6.6 fix");

    // Adding a brand-new version keeps every earlier version and stays ordered.
    const bumped = engine.updateChangelog(
      reprepared,
      "## FRIDAY v1.7.1\n\n**Summary:** next.\n\n#### Fixed\n- a 1.7.1 fix\n",
      "1.7.1",
    );
    const after = engine.uniqueChangelogHeadings(bumped);
    expect(after.unique, after.keys.join(",")).toBe(true);
    expect(after.keys).toEqual(["1.7.1", "1.7.0", "1.6.6"]);
  });
});

describe("documentation governance coverage", () => {
  it("exports VERSION_DOCS and GOVERNED_DOCS", () => {
    expect(Array.isArray(engine.VERSION_DOCS)).toBe(true);
    expect(Array.isArray(engine.GOVERNED_DOCS)).toBe(true);
    expect(engine.VERSION_DOCS.length).toBeGreaterThan(0);
    expect(engine.GOVERNED_DOCS.length).toBeGreaterThan(0);
  });

  it("governs every docs/FRIDAY_*.md file", () => {
    const fridayDocs = fs
      .readdirSync(path.join(ROOT, "docs"))
      .filter((name) => name.startsWith("FRIDAY_") && name.endsWith(".md"))
      .map((name) => `docs/${name}`);
    const covered = new Set([...engine.VERSION_DOCS, ...engine.GOVERNED_DOCS]);
    const missing = fridayDocs.filter((file) => !covered.has(file));
    expect(missing, missing.join(", ")).toEqual([]);
  });

  it("keeps the live FRIDAY_STATE briefing on the shipping version", () => {
    const briefing = fs.readFileSync(path.join(ROOT, "FRIDAY_STATE.md"), "utf8");
    expect(briefing).toContain(`currently version ${shipping()}`);
    expect(npmVersion()).toBe(engine.readCanonicalIdentity({ root: ROOT }).npmVersion);
  });

  it("governs FRIDAY_STATE.md as prose, not as a wholesale version rewrite", () => {
    expect(engine.GOVERNED_DOCS).toContain("FRIDAY_STATE.md");
    expect(engine.VERSION_DOCS).not.toContain("FRIDAY_STATE.md");
  });

  it("governs AGENTS.md current public line and next revision, not the four-part example", () => {
    expect(engine.GOVERNED_DOCS).toContain("AGENTS.md");
    expect(engine.VERSION_DOCS).not.toContain("AGENTS.md");
    const version = shipping();
    const next = engine.nextPublicRevision(version);
    expect(next).toBe(engine.bumpVersion(version.replace(/-.*$/, ""), "patch"));
    const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
    expect(agents).toContain(`current public line **FRIDAY ${version}**`);
    expect(agents).toContain(`Next public revision is **${next}**`);
    expect(agents).toContain("(`1.0.0.0`)");
  });

  /**
   * Regression: the briefing line "(currently version 1.7.1)" was asserted by
   * version-sync but never registered in DECLARATION_PATTERNS, so a bump left
   * FRIDAY_STATE.md stale and `npm test` failed in release prepare/publish.
   * Heal must rewrite that one sentence and leave historical / lock-in
   * numbers (including "as of vX" and historical "(vX)") untouched.
   */
  it("heals the FRIDAY_STATE currently-version line and leaves history alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-state-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "friday", version: "1.7.1" }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, "FRIDAY_STATE.md"),
      [
        "# FRIDAY — Project State",
        "",
        "FRIDAY is an Electron desktop app (currently version 1.6.0) with a kernel.",
        "",
        "UI organization, EXE install/update/uninstall, and project independence",
        "are DONE and STABLE as of v1.7.1.",
        "",
        "- 2026-09-04 — work that landed when main already declared (v1.7.0).",
        "",
      ].join("\n"),
    );

    const before = engine.versionDrift({ root: dir });
    expect(before.ok).toBe(false);
    expect(before.stale).toEqual([
      expect.objectContaining({ file: "FRIDAY_STATE.md", found: "1.6.0", expected: "1.7.1" }),
    ]);

    engine.applyVersion("1.7.2", { root: dir });
    const briefing = fs.readFileSync(path.join(dir, "FRIDAY_STATE.md"), "utf8");
    expect(briefing).toContain("(currently version 1.7.2)");
    expect(briefing).toContain("as of v1.7.1");
    expect(briefing).toContain("(v1.7.0)");
    expect(engine.versionDrift({ root: dir }).stale).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * AGENTS.md names the live public line and the next unpublished revision.
   * Heal must rewrite those two sentences from the canonical identity and
   * leave the four-part encoding example (`1.0.0.0`) untouched so a bump
   * cannot turn "next is 1.0.0.3" into the shipping number.
   */
  it("heals AGENTS.md public line and next revision without touching the 1.0.0.0 example", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-agents-"));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    const parsed = engine.parseFridayVersion("1.0.0.5");
    engine.writeCanonicalFile(engine.identityFromParsed(parsed), { root: dir });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "friday", version: "1.0.0" }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(dir, "AGENTS.md"),
      [
        "Public FRIDAY is four-part",
        "  (`1.0.0.0`); `package.json` `version` is the npm encoding.",
        "  Next public revision is **1.0.0.3** and may only describe work done after",
        "  the current public line **FRIDAY 1.0.0.2**.",
      ].join("\n"),
    );

    const before = engine.versionDrift({ root: dir });
    expect(before.ok).toBe(false);
    expect(before.stale).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "AGENTS.md", found: "1.0.0.2", expected: "1.0.0.5" }),
        expect.objectContaining({ file: "AGENTS.md", found: "1.0.0.3", expected: "1.0.0.6" }),
      ]),
    );

    engine.applyVersion("1.0.0.5", { root: dir });
    const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("current public line **FRIDAY 1.0.0.5**");
    expect(agents).toContain("Next public revision is **1.0.0.6**");
    expect(agents).toContain("(`1.0.0.0`)");
    expect(engine.versionDrift({ root: dir }).stale).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("requires every AI session to update FRIDAY_STATE.md as a deliverable", () => {
    const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/required deliverable/i);
    expect(agents).toContain("FRIDAY_STATE.md");
    expect(agents).toMatch(/A session that leaves `FRIDAY_STATE\.md` stale has not finished/);
  });

  it("requires the same landing bar on a PR merge, and never a direct main commit", () => {
    const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/Finish the landing checklist/);
    expect(agents).toMatch(/Never commit, push, or land work on `main`/i);
    expect(agents).toMatch(/only `main`/);
    expect(agents).toContain("scripts\\build-windows.cmd");
    expect(agents).toMatch(/docs:sync/);
    expect(agents).toMatch(/never a later cleanup/);
    expect(agents).toMatch(/not dispatch/i);
    expect(agents).toMatch(/Changing something that already works/);
  });

  it("keeps one upgrade flow and the real branch-cleanup fact", () => {
    const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
    expect(agents).toContain("## Upgrade flow");
    expect(agents).toContain("`delete_branch_on_merge` setting is off");
    expect(agents).not.toContain("-a9ef");
    expect(agents).toContain("One open pull request into `main`");
    expect(agents.match(/Never commit, push, or land work on `main`/g)?.length).toBe(1);
    expect(agents).toContain("Locked areas may be changed");
    expect(agents).toMatch(/hunt for bugs and weak spots and fix them in the\s+same change/);
    expect(agents).toMatch(/Never delete, skip, weaken, or\s+fake-pass a test/);
    expect(agents).toContain("Never dispatch a workflow");
    expect(agents).toContain("unverified until the owner re-checks");
    expect(agents).toContain("Do not add a thirteenth");
    expect(agents).toContain("## Direction");
  });
});
