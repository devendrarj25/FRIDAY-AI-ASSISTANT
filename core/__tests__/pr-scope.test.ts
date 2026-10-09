/**
 * The "documentation only" rule decides how much validation a pull request gets, so it
 * is pinned here from every side: the rule itself, the files the installer
 * packages, and the way PR Validation uses it. PR Validation does not copy the
 * list into GitHub paths-ignore, because a skipped required check stays pending.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { load as parseYaml } from "js-yaml";

const ROOT = path.resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);
const scope = require(path.join(ROOT, "scripts", "pr-scope.cjs")) as {
  PATHS_IGNORE: string[];
  DOC_PREFIXES: string[];
  DOC_FILES: string[];
  isDocPath: (f: string) => boolean;
  isDocsOnly: (files: string[]) => boolean;
};
const wf = (name: string) => fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
// Workflow YAML is untyped data; the assertions below check its shape.
const load = (name: string): any => parseYaml(wf(name));

describe("pr-scope: what counts as documentation only", () => {
  it("accepts documentation and nothing else", () => {
    expect(scope.isDocsOnly(["README.md", "docs/FRIDAY_FEATURES.md", "FRIDAY_STATE.md"])).toBe(
      true,
    );
    expect(scope.isDocsOnly([".github/pull_request_template.md"])).toBe(true);
    expect(scope.isDocsOnly(["docs/FRIDAY_CHANGE_CONTROL.md"])).toBe(true);
  });

  it("any code, config, workflow, packaged or unknown file means the full validation", () => {
    for (const f of [
      "CHANGELOG.md", // packaged into the installer
      "package.json",
      "src/lib/a.ts",
      "skills/x/SKILL.md", // packaged product content
      ".github/workflows/pr-validation.yml",
      "scripts/pr-scope.cjs",
      "docs", // a file named docs, not a docs/ path
      "docs/",
      "../docs/x.md",
      "/docs/x.md",
      "src/README.md",
      "LICENSE",
      "FRIDAY-DEVELOPMENT & VISION/FRIDAY-VISION/a b.md",
      "READMEFIRST.md",
    ]) {
      expect(scope.isDocsOnly(["README.md", f]), f).toBe(false);
    }
  });

  it("an empty or blank list is never documentation only", () => {
    expect(scope.isDocsOnly([])).toBe(false);
    expect(scope.isDocsOnly(["", "  "])).toBe(false);
  });

  it("never classifies anything the installer packages as documentation", () => {
    const builder = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
    const packaged = [...builder.matchAll(/^\s*-\s*from:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(packaged.length).toBeGreaterThan(5);
    for (const from of packaged) {
      const probe = from.includes(".") ? from : `${from}/anything.md`;
      expect(scope.isDocPath(probe), `${probe} is packaged`).toBe(false);
    }
  });

  it("keeps one documentation list and does not skip PR Validation with paths-ignore", () => {
    const expected = [...scope.DOC_PREFIXES.map((prefix) => `${prefix}**`), ...scope.DOC_FILES];
    expect([...scope.PATHS_IGNORE].sort()).toEqual([...expected].sort());
    expect(load("pr-validation.yml").on.pull_request["paths-ignore"]).toBeUndefined();
  });
});

describe("pr-scope: how the workflows use it", () => {
  it("PR Validation gates Windows behind a cheap gate and gives docs-only its own full Linux job", () => {
    const doc = load("pr-validation.yml");
    expect(doc.jobs.gate["runs-on"]).toBe("ubuntu-latest");
    expect(doc.jobs.validate.needs).toBe("gate");
    expect(doc.jobs.validate["runs-on"]).toBe("windows-latest");
    expect(doc.jobs.validate.if).toContain("needs.gate.result == 'success'");
    expect(doc.jobs.validate.if).toContain("docs_only != 'true'");
    const dj = doc.jobs["docs-only"];
    expect(dj.needs).toBe("gate");
    expect(dj.if).toContain("docs_only == 'true'");
    const steps = JSON.stringify(dj.steps);
    // The checks a documentation change can actually break all still run.
    for (const must of [
      "npm test",
      "npm run typecheck",
      "npm run docs:check",
      "npm run verify:version",
      "heal --check",
    ]) {
      expect(steps, must).toContain(must);
    }
    // ...and it reports the same required status the merge flow waits for.
    expect(steps).toContain("PR Validation");
  });

  it("the classifier is read from the trusted base commit, not from the pull request", () => {
    for (const [file, job] of [
      ["pr-validation.yml", "gate"],
      ["security.yml", "scope"],
    ] as const) {
      const steps = load(file).jobs[job].steps as Array<{
        name?: string;
        uses?: string;
        with?: Record<string, string>;
      }>;
      const classifier = steps.filter(
        (step) =>
          typeof step.uses === "string" &&
          step.uses.includes("actions/checkout") &&
          step.with?.["sparse-checkout"] === "scripts/pr-scope.cjs",
      );
      expect(classifier, file).toHaveLength(1);
      const checkout = classifier[0]!;
      expect(checkout.with?.["ref"], file).toContain("github.event.pull_request.base.sha");
      expect(checkout.with?.["ref"], file).toContain("github.sha");
      const index = steps.indexOf(checkout);
      for (const earlier of steps.slice(0, index)) {
        expect(String(earlier.uses ?? ""), `${file} before the trusted classifier`).not.toContain(
          "actions/checkout",
        );
      }
    }
    const gate = load("pr-validation.yml").jobs.gate.steps as Array<{
      name?: string;
      if?: string;
    }>;
    const refuse = gate.find((step) => step.name === "Refuse a call that is not Official Publish");
    expect(refuse).toBeTruthy();
    expect(refuse?.if).toBeUndefined();
  });

  it("manual dispatches, which produce release evidence, always get the full validation", () => {
    const src = wf("pr-validation.yml");
    expect(src).toContain('[ "$EVENT_NAME" = "pull_request" ] && [ -f scripts/pr-scope.cjs ]');
    expect(src).toContain("docs_only=false");
  });

  it("drafts are free, but the secret scan still runs on everything", () => {
    const pr = load("pr-validation.yml");
    expect(pr.jobs.secrets.if).toBeUndefined();
    expect(pr.jobs.gate.if).toContain("draft == false");
    expect(pr.jobs.codeql.needs).toBe("gate");
    expect(pr.jobs.codeql.if).toContain("needs.gate.result == 'success'");
    expect(pr.jobs.codeql.if).toContain("docs_only != 'true'");
    expect(pr.jobs.codeql.if).toContain("private == false");
    expect(pr.jobs.audit.needs).toBe("gate");
    expect(pr.jobs.audit.if).toContain("needs.gate.result == 'success'");
    expect(pr.on.pull_request.types).toContain("ready_for_review");
    const weekly = load("security.yml");
    expect(weekly.on.pull_request).toBeUndefined();
    expect(weekly.on.schedule).toBeTruthy();
    expect(weekly.jobs.secrets.if).toBeUndefined();
  });

  it("Auto Recover re-runs only the jobs that never started", () => {
    const src = wf("auto-recover.yml");
    expect(src).toContain("/rerun-failed-jobs");
    expect(src).toContain(".conclusion != null");
  });
});
