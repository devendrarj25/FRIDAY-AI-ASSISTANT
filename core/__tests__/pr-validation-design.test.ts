/**
 * What makes a green "PR Validation" worth merging on. The workflow is only
 * read here, never run. These are the properties that, if a later edit loses
 * one, would let a broken build, install or update reach main unnoticed.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { phasesRunByPr, pipeline } from "./helpers/pr-validation";

const ROOT = path.resolve(import.meta.dirname, "../..");
const text = fs.readFileSync(path.join(ROOT, ".github/workflows/pr-validation.yml"), "utf8");
type Job = {
  "runs-on"?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  "continue-on-error"?: unknown;
  steps?: {
    name?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    "continue-on-error"?: unknown;
  }[];
};
const doc = parseYaml(text) as { permissions?: Record<string, string>; jobs: Record<string, Job> };
const jobs = doc.jobs;
const stepText = (job: string) =>
  (jobs[job]?.steps ?? []).map((step) => `${step.name ?? ""}\n${step.run ?? ""}`).join("\n");
const asList = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value : value ? [value] : [];

describe("every blocking job feeds the one required status", () => {
  const BLOCKING = [
    "static",
    "kernel",
    "tests-windows",
    "package-windows",
    "update-windows",
    "audit",
    "secrets",
  ];

  it("lists them all in validate.needs, so none can fail while the status stays green", () => {
    const needs = asList(jobs["validate"]?.needs);
    for (const job of BLOCKING) expect(needs, job).toContain(job);
    expect(needs).toContain("gate");
  });

  it("passes each result to the aggregate, which treats skipped and missing as failures", () => {
    const validate = stepText("validate");
    for (const flag of [
      "--static",
      "--kernel",
      "--tests",
      "--package",
      "--update",
      "--audit",
      "--secrets",
    ]) {
      expect(validate, flag).toContain(flag);
    }
    expect(text).toContain('[ "$state" = "success" ]');
  });

  it("never lets a job pass by ignoring its own failure", () => {
    for (const [name, job] of Object.entries(jobs)) {
      expect(job["continue-on-error"], name).toBeUndefined();
      for (const step of job.steps ?? []) {
        // Only the failure-explainer and the optional previous-installer fetch may swallow errors.
        if (step["continue-on-error"] !== undefined) {
          expect(step.name, `${name}: ${step.name}`).toMatch(/Explain a failed check/);
        }
      }
    }
  });

  it("bounds every job in time, so a hang costs minutes, not hours", () => {
    const LIMITS: Record<string, number> = {
      gate: 5,
      static: 30,
      kernel: 30,
      "tests-windows": 45,
      "package-windows": 60,
      "update-windows": 45,
      validate: 10,
      "docs-only": 30,
    };
    for (const [name, job] of Object.entries(jobs)) {
      expect(job["timeout-minutes"], name).toBeGreaterThan(0);
    }
    for (const [name, limit] of Object.entries(LIMITS)) {
      expect(jobs[name]?.["timeout-minutes"], name).toBe(limit);
    }
    // The longest real run so far is about 14 minutes; the cap leaves room for a slow runner.
    expect(jobs["package-windows"]?.["timeout-minutes"]).toBeGreaterThanOrEqual(45);
  });
});

describe("the Windows jobs are the release build and the update from the last release", () => {
  it("covers every pipeline phase between the two build jobs", () => {
    expect(phasesRunByPr()).toEqual(pipeline.PHASES);
    const pack = stepText("package-windows");
    expect(pack).toContain("--caller pr-validation --through verify-versions");
    expect(pack).toContain("--caller pr-validation --from stage-toolchain");
    expect(jobs["package-windows"]?.env?.["FRIDAY_SMOKE_SCENARIO"]).toBe("lifecycle");
  });

  it("runs the update from the last release on its own runner, beside the lifecycle", () => {
    const job = jobs["update-windows"];
    expect(job?.["runs-on"]).toBe("windows-latest");
    expect(asList(job?.needs)).toEqual(["gate"]);
    expect(job?.env?.["FRIDAY_SMOKE_SCENARIO"]).toBe("update");
    // Independent of package-windows: the two start together, so the wall time is the longer one.
    expect(asList(jobs["package-windows"]?.needs)).toEqual(["gate"]);
    const text = stepText("update-windows");
    expect(text).toContain("gh release download");
    expect(text).toContain("FRIDAY_PREVIOUS_INSTALLER");
    expect(text).toContain("--from stage-toolchain --through package --targets nsis");
  });

  it("builds only when there is an earlier release to update from, and says so otherwise", () => {
    const steps = jobs["update-windows"]?.steps ?? [];
    const fetch = steps.findIndex((step) =>
      /previously published installer/i.test(step.name ?? ""),
    );
    const build = steps.findIndex((step) => /Build the installer/i.test(step.name ?? ""));
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(fetch);
    for (const step of steps.slice(fetch + 1)) {
      if (/Explain a failed check/.test(step.name ?? "")) continue;
      expect(step.if, step.name).toContain("steps.previous.outputs.found == 'true'");
    }
    expect(stepText("update-windows")).toContain("Update test: SKIPPED");
  });

  it("takes Defender out of the way of the install and the pack, and never fails on it", () => {
    for (const job of ["tests-windows", "package-windows", "update-windows"]) {
      const step = (jobs[job]?.steps ?? []).find((s) => /Defender exclusions/.test(s.name ?? ""));
      expect(step?.run, job).toContain("Add-MpPreference -ExclusionPath");
      expect(step?.run, job).toContain("catch");
    }
  });
});

describe("what runs for every kind of change", () => {
  it("checks generated files are committed before the Windows pack starts", () => {
    const step = stepText("static");
    expect(step).toContain("npm run docs:sync");
    expect(step).toContain("npm run build:desktop");
    expect(step).toContain("generated files are out of date");
  });

  it("scans documentation-only changes for secrets as well", () => {
    expect(stepText("docs-only")).toContain("gitleaks");
    expect(stepText("secrets")).toContain("gitleaks");
  });

  it("keeps drafts free: nothing but the secret scan runs for a draft", () => {
    expect(jobs["gate"]?.if).toContain("draft == false");
    expect(jobs["secrets"]?.needs).toBeUndefined();
    for (const job of [
      "static",
      "kernel",
      "tests-windows",
      "package-windows",
      "update-windows",
      "audit",
    ]) {
      expect(asList(jobs[job]?.needs), job).toContain("gate");
    }
  });
});

describe("jobs that run the pull request's own code hold the least privilege", () => {
  it("is read-only by default, and only static may write (the docs heal push)", () => {
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(jobs["static"]?.permissions).toEqual({ contents: "write", statuses: "write" });
    for (const job of ["kernel", "tests-windows", "package-windows", "update-windows"]) {
      expect(jobs[job]?.permissions, job).toEqual({ contents: "read" });
    }
  });

  it("hands the token only to the step that downloads the earlier release", () => {
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "validate" || name === "docs-only" || name === "gate" || name === "static")
        continue;
      if (name === "update-windows") continue;
      expect(job.env?.["GH_TOKEN"], name).toBeUndefined();
    }
    const job = jobs["update-windows"];
    expect(job?.env?.["GH_TOKEN"]).toBeUndefined();
    const withToken = (job?.steps ?? []).filter((step) => step.env?.["GH_TOKEN"]);
    expect(withToken.map((step) => step.name)).toEqual([
      "Fetch the previously published installer",
    ]);
  });

  it("downloads the earlier installer outside the workspace and says when the update test is skipped", () => {
    const step = stepText("update-windows");
    expect(step).toContain("RUNNER_TEMP");
    expect(step).not.toMatch(/mkdir -p previous\b/);
    expect(step).toContain("Update test: SKIPPED");
  });

  it("never splices a branch name into a shell line", () => {
    expect(text).not.toMatch(/run:[^\n]*\$\{\{\s*github\.(base_ref|head_ref)/);
    expect(text).not.toContain('"origin/${{');
  });
});

describe("the Windows pack can neither skip a phase nor hide where it failed", () => {
  it("runs both pipeline calls with --strict, so a skipped smoke or self-check fails the job", () => {
    const calls = ["package-windows", "update-windows"].flatMap((job) =>
      stepText(job)
        .split("\n")
        .filter((line) => line.includes("build-pipeline.cjs")),
    );
    expect(calls).toHaveLength(4);
    for (const line of calls) expect(line, line).toContain("--strict");
  });

  it("explains a failure from both pipeline reports", () => {
    for (const job of ["package-windows", "update-windows"]) {
      const step = stepText(job);
      expect(step, job).toContain("prepare-report.json");
      // Outside release/, which the pack phase empties before the report could be read.
      expect(step, job).not.toContain("release/prepare-report.json");
      expect(step, job).toContain("--pipeline release/build-report.json");
    }
  });
});

describe("a green status describes the merged result", () => {
  it("refuses a pull request branch that does not contain the current base, in both paths", () => {
    for (const job of ["static", "docs-only"]) {
      const steps = jobs[job]?.steps ?? [];
      const names = steps.map((step) => step.name ?? "");
      const check = steps.find((step) => step.name === "Branch contains the current main");
      expect(check?.run, job).toContain('git merge-base --is-ancestor "origin/$BASE_REF" HEAD');
      expect(check?.run, job).toContain("exit 1");
      // A head that was merged while the run started is on the base already: a notice, not a failure.
      expect(check?.run, job).toContain('git merge-base --is-ancestor HEAD "origin/$BASE_REF"');
      expect(check?.run, job).toContain("::notice title=Already on");
      expect(check?.run, job).not.toMatch(/Already on[^\n]*\n[^\n]*exit 1/);
      // Cheap, so it runs before the install and the heavy checks.
      const install = names.findIndex((name) => /^Install dependencies/.test(name));
      expect(names.indexOf("Branch contains the current main"), job).toBeLessThan(install);
    }
  });
});

describe("the workflows themselves are audited", () => {
  it("runs a pinned, offline workflow security audit that fails on medium and above", () => {
    const step = stepText("static");
    expect(step).toContain('pip install --quiet "zizmor==');
    expect(step).toContain(
      "zizmor --offline --no-progress --min-severity medium .github/workflows",
    );
    expect(step).toContain("node scripts/run-actionlint.cjs");
  });
});

describe("a slow network does not fail a branch, and a bad file does not enter it", () => {
  it("lets npm and pip retry before they give up", () => {
    const env = (doc as unknown as { env?: Record<string, string> }).env ?? {};
    expect(Number(env["NPM_CONFIG_FETCH_RETRIES"])).toBeGreaterThanOrEqual(4);
    expect(Number(env["PIP_RETRIES"])).toBeGreaterThanOrEqual(5);
  });

  it("retries the scanner image pull without weakening the scan", () => {
    for (const job of ["secrets", "docs-only"]) {
      const names = (jobs[job]?.steps ?? []).map((step) => step.name ?? "");
      const pull = names.indexOf("Pull the secret scanner image");
      const scan = names.indexOf("Scan for committed secrets");
      expect(pull, job).toBeGreaterThanOrEqual(0);
      expect(scan, job).toBeGreaterThan(pull);
      const run = (jobs[job]?.steps ?? [])[scan]?.run ?? "";
      expect(run, job).toContain("--exit-code 1");
      expect(run, job).toContain("@sha256:");
    }
  });

  it("pins the advisory tool the way it pins the workflow auditor", () => {
    expect(stepText("audit")).toContain('"pip-audit==');
  });

  it("checks the pull request's title, body and added files, through env", () => {
    for (const job of ["static", "docs-only"]) {
      const steps = jobs[job]?.steps ?? [];
      const provenance = steps.find((step) => step.name === "Commit provenance");
      expect(provenance?.env?.["PR_TITLE"], job).toContain("github.event.pull_request.title");
      expect(provenance?.env?.["PR_BODY"], job).toContain("github.event.pull_request.body");
      expect(provenance?.run, job).not.toContain("${{");
      const added = steps.find((step) =>
        /No build output, caches or oversized files/.test(step.name ?? ""),
      );
      expect(added?.run, job).toContain("scripts/check-added-files.cjs");
      expect(added?.run, job).not.toContain("${{");
    }
  });
});
