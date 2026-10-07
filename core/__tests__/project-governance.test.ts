/**
 * FRIDAY - project governance contract.
 *
 * The GitHub/project-management layer is part of the product: versioning,
 * release runbook, architecture map, security policy, dependency policy and
 * issue structure must exist, stay ASCII/parsable, stay in sync with the real
 * shipping version, and must never grant themselves build/release powers.
 *
 * These tests protect only those contracts. They do not duplicate the CI
 * contract in ci-workflows.test.ts or the docs contract in
 * documentation-contract.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { load as parseYaml } from "js-yaml";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
const engine = require("../../scripts/release-engine.cjs") as {
  readCanonicalIdentity: (opts?: { root?: string }) => { releaseVersion: string };
};
const version = engine.readCanonicalIdentity({ root: ROOT }).releaseVersion;

const GOVERNANCE_DOCS = ["VERSIONING.md", "RELEASE.md", "ARCHITECTURE.md", "SECURITY.md"];

describe("governance documents", () => {
  it("ships the required project documents with real content", () => {
    for (const file of [...GOVERNANCE_DOCS, "CHANGELOG.md"]) {
      expect(exists(file), `${file} is missing`).toBe(true);
      expect(read(file).trim().length, file).toBeGreaterThan(500);
    }
  });

  it("names the current shipping version, never a stale one", () => {
    for (const file of GOVERNANCE_DOCS) {
      const body = read(file);
      expect(body, `${file} does not name v${version}`).toContain(version);
      const stale = [
        ...body.matchAll(/FRIDAY-(?:Test-)?(?:Setup|Portable)-(\d+\.\d+\.\d+(?:\.\d+)?)/g),
      ]
        .map((m) => m[1])
        .filter((v) => v !== version);
      expect(stale, `${file} references stale artifact versions`).toEqual([]);
    }
  });

  it("states the version policy: rebuild keeps the version, update increments it", () => {
    const policy = read("VERSIONING.md");
    expect(policy).toMatch(/rebuild/i);
    expect(policy).toMatch(/same version/i);
    expect(policy).toMatch(/update/i);
    expect(policy).toMatch(/auto/i);
    // Channels stay separated in writing as well as in the workflows.
    expect(policy).toContain("dev.friday.desk.test");
    expect(policy).toMatch(/prerelease/i);
    // Version handoff must be documented as "never stale".
    expect(policy).toMatch(/handoff/i);
  });

  it("documents all three build paths in the release runbook", () => {
    const runbook = read("RELEASE.md");
    for (const token of [
      "npm run build:win",
      "test-build.yml",
      "prepare",
      "publish",
      "release-engine.cjs handoff",
      "friday-update.json",
      "SHA256",
    ]) {
      expect(runbook, token).toContain(token);
    }
  });

  it("keeps the security policy honest about secrets and permissions", () => {
    const security = read("SECURITY.md");
    for (const token of [
      "GitHub Secrets",
      "WINDOWS_SIGNING_CERTIFICATE_BASE64",
      "least privilege",
      "Auto-merge is disabled",
      "SHA256",
    ]) {
      expect(security.toLowerCase(), token).toContain(token.toLowerCase());
    }
    // A policy document must never contain a credential.
    expect(security).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
  });

  it("links the new documents from the README", () => {
    const readme = read("README.md");
    for (const file of GOVERNANCE_DOCS) expect(readme, file).toContain(`(${file})`);
  });
});

describe("dependency policy", () => {
  const file = ".github/dependabot.yml";
  const doc = parseYaml(read(file)) as any;

  it("is a valid Dependabot v2 configuration covering npm and actions", () => {
    expect(doc.version).toBe(2);
    const ecosystems = doc.updates.map((u: any) => u["package-ecosystem"]);
    expect(ecosystems).toContain("npm");
    expect(ecosystems).toContain("github-actions");
  });

  it("never auto-merges and puts each ecosystem's version updates in one pull request", () => {
    const src = read(file);
    expect(src).not.toMatch(/auto-?merge/i);
    for (const update of doc.updates) {
      expect(update["open-pull-requests-limit"]).toBe(1);
      const groups = Object.values<any>(update.groups ?? {});
      expect(groups).toHaveLength(1);
      expect(groups[0].patterns).toEqual(["*"]);
      expect(groups[0]["applies-to"]).toBe("version-updates");
      expect(groups[0]["update-types"]).toBeUndefined();
    }
    const npm = doc.updates.find((u: any) => u["package-ecosystem"] === "npm");
    const ignored = (npm.ignore ?? []).map((i: any) => i["dependency-name"]);
    for (const critical of ["*", "electron", "electron-builder", "vite"]) {
      expect(ignored, critical).toContain(critical);
    }
    for (const update of doc.updates) {
      const star = (update.ignore ?? []).find((item: any) => item["dependency-name"] === "*");
      expect(star["update-types"]).toContain("version-update:semver-major");
    }
  });

  it("keeps TypeScript 5 and the calendar and chart libraries on their working majors", () => {
    const raw = read("package.json");
    expect(raw.match(/"typescript":/g)).toHaveLength(1);
    expect(raw.match(/"prettier":/g)).toHaveLength(1);
    expect(raw.match(/"rcedit":/g)).toHaveLength(1);
    const pkg = JSON.parse(raw) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies["typescript"]?.startsWith("5.")).toBe(true);
    expect(pkg.dependencies["react-day-picker"]).toMatch(/^\^9\./);
    expect(pkg.dependencies["recharts"]).toMatch(/^\^2\./);
  });

  it("caps how many dependency pull requests can be open at once", () => {
    for (const update of doc.updates) {
      expect(update["open-pull-requests-limit"]).toBeGreaterThan(0);
      expect(update["open-pull-requests-limit"]).toBeLessThanOrEqual(5);
    }
  });
});

describe("issue and label structure", () => {
  const DIR = path.join(ROOT, ".github/ISSUE_TEMPLATE");

  it("offers a form for every triage area the project actually uses", () => {
    const forms = fs.readdirSync(DIR).filter((f) => f !== "config.yml");
    expect(forms.sort()).toEqual([
      "bug_report.yml",
      "build_release.yml",
      "feature_request.yml",
      "security_report.yml",
    ]);
    for (const form of forms) {
      const doc = parseYaml(fs.readFileSync(path.join(DIR, form), "utf8")) as any;
      expect(doc.name, form).toBeTruthy();
      expect(Array.isArray(doc.body), form).toBe(true);
      expect(doc.labels, form).toBeTruthy();
    }
  });

  it("routes real vulnerabilities away from public issues", () => {
    const config = parseYaml(fs.readFileSync(path.join(DIR, "config.yml"), "utf8")) as any;
    expect(config.blank_issues_enabled).toBe(false);
    expect(JSON.stringify(config.contact_links)).toMatch(/security/i);
    expect(read(".github/ISSUE_TEMPLATE/security_report.yml")).toMatch(
      /Do not report an exploitable vulnerability here/i,
    );
  });

  it("declares every label the templates apply", () => {
    const labels = (parseYaml(read(".github/labels.yml")) as any[]).map((l) => l.name);
    for (const required of [
      "bug",
      "feature",
      "build",
      "installer",
      "update",
      "security",
      "performance",
      "documentation",
      "dependencies",
      "needs-triage",
    ]) {
      expect(labels, required).toContain(required);
    }
    for (const form of fs.readdirSync(DIR).filter((f) => f !== "config.yml")) {
      const doc = parseYaml(fs.readFileSync(path.join(DIR, form), "utf8")) as any;
      for (const label of doc.labels ?? []) expect(labels, `${form}: ${label}`).toContain(label);
    }
  });
});

describe("CI economics and safety", () => {
  it("installs Node from package.json in the one toolchain action", () => {
    // actions/setup-node and actions/cache are outside this repository, so
    // they cannot be the npm cache. The toolchain still has one implementation.
    const action = read(".github/actions/friday-node/action.yml");
    expect(action).toContain("engines.node");
    expect(action).toContain("nodejs.org/dist/");
    expect(action).not.toMatch(/uses:\s+actions\/setup-node/);
    expect(action).not.toMatch(/uses:\s+actions\/cache/);
  });

  it("does not retain build artifacts indefinitely", () => {
    const src = read(".github/workflows/test-build.yml");
    // The Actions artifact action is not allowed here, so a test build is not
    // stored as an Actions artifact. A published test build keeps only the
    // last 3 TEST prereleases. Any retention-days value still expires within
    // 30 days.
    expect(src).not.toContain("actions/upload-artifact");
    expect(src).toContain("Keep only the last 3 TEST prereleases");
    const days = [...src.matchAll(/retention-days:\s*(\d+)/g)].map((m) => Number(m[1]));
    for (const value of days) expect(value).toBeLessThanOrEqual(30);
  });

  it("keeps governance files free of executable release power", () => {
    for (const file of [".github/dependabot.yml", ".github/labels.yml"]) {
      const src = read(file);
      for (const forbidden of ["gh release", "git push", "git tag", "release-engine.cjs"]) {
        expect(src, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  // Markdown is rendered by GitHub and may use typography; the YAML files are
  // parsed by tooling on Windows runners and stay strictly ASCII.
  it("keeps every governance config file ASCII so Windows runners parse them byte-identically", () => {
    const files = [
      ".github/dependabot.yml",
      ".github/labels.yml",
      ...fs
        .readdirSync(path.join(ROOT, ".github/ISSUE_TEMPLATE"))
        .map((f) => `.github/ISSUE_TEMPLATE/${f}`),
    ];
    for (const file of files) {
      const offending = [...read(file)].filter((ch) => ch.charCodeAt(0) > 127);
      expect(offending, `${file} contains non-ASCII characters`).toEqual([]);
    }
  });
});
