/**
 * GitHub CI contract.
 *
 * Twelve workflow files under .github/workflows/, each with one responsibility.
 * The complete catalog is docs/FRIDAY_GITHUB_ACTIONS.md; this file asserts the
 * on-disk inventory, permissions, and Node toolchain contract.
 *
 *   official-publish.yml — one-click official release orchestrator (dispatch only)
 *   release.yml          — the ONLY place that versions, tags, publishes and cleans up
 *   test-build.yml       — portable test EXE artifact (optional TEST prerelease)
 *   pr-validation.yml    — the one pull-request validation (tests, scans, Windows installer)
 *   safe-merge.yml       — merge eligible PRs into main (typed MERGE)
 *   repository-control.yml — manual owner control surface (dispatch only)
 *   branch-cleanup.yml   — deletes merged temporary work branches
 *   maintenance.yml      — stale branch/release/run cleanup
 *   main-safety-recovery.yml — preserves an unexpected main push for manual review
 *   health-weekly.yml    — weekly health check that keeps one issue up to date
 *   auto-recover.yml     — re-runs validation runs that never started (limit hit)
 *   security.yml         — secrets, CodeQL and dependency advisories
 *
 * These tests exist so release logic can never be duplicated into a second
 * workflow, and so the read-only workflows can never gain write powers.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

const DIR = path.resolve(__dirname, "../../.github/workflows");
const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8");
const load = (f: string) => parseYaml(read(f)) as any;

const RELEASE_ONLY = [
  "release-engine.cjs decide",
  "release-engine.cjs apply",
  "release-manifest.cjs",
];

describe("workflow inventory", () => {
  it("has exactly the expected workflows and no duplicates", () => {
    expect(fs.readdirSync(DIR).sort()).toEqual([
      "auto-recover.yml",
      "branch-cleanup.yml",
      "health-weekly.yml",
      "main-safety-recovery.yml",
      "maintenance.yml",
      "official-publish.yml",
      "pr-validation.yml",
      "release.yml",
      "repository-control.yml",
      "safe-merge.yml",
      "security.yml",
      "test-build.yml",
    ]);
  });

  it("every workflow parses and shares the one canonical Node toolchain action", () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".yml"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const doc = load(file);
      expect(doc.name, file).toBeTruthy();
      const src = read(file);
      const usesNode =
        /\bnpm ci\b/.test(src) ||
        /\bnpm test\b/.test(src) ||
        /\bnpm run\b/.test(src) ||
        /\bnode scripts\//.test(src);
      if (!usesNode) continue;
      expect(src, file).toContain("uses: ./.github/actions/friday-node");
    }
    expect(fs.existsSync(path.resolve(DIR, "../actions/friday-node/action.yml"))).toBe(true);
  });

  it("sets up the engine-compatible toolchain before any npm ci / build step", () => {
    const firstLive = (src: string, needle: string) => {
      let offset = 0;
      for (const line of src.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("#") && trimmed.includes(needle)) {
          return offset + line.indexOf(needle);
        }
        offset += line.length + 1;
      }
      return -1;
    };
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
      const src = read(file);
      const install = firstLive(src, "npm ci");
      if (install < 0) continue;
      const toolchain = src.indexOf("uses: ./.github/actions/friday-node");
      expect(toolchain, file).toBeGreaterThan(-1);
      expect(toolchain, file).toBeLessThan(install);
      // No workflow may pin its own Node version behind the shared action's back.
      expect(src, file).not.toContain("node-version:");
    }
  });

  it("every scripts/ path a workflow runs exists in this repo", () => {
    const root = path.resolve(DIR, "../..");
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
      const src = read(file);
      const refs = src.match(/scripts\/[A-Za-z0-9._-]+/g) || [];
      for (const rel of new Set(refs)) {
        expect(fs.existsSync(path.join(root, rel)), `${file} -> ${rel}`).toBe(true);
      }
    }
  });

  it("every npm run script a workflow invokes exists in package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(DIR, "../../package.json"), "utf8"));
    const scripts = pkg.scripts as Record<string, string>;
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
      const src = read(file);
      for (const match of src.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
        const name = match[1];
        expect(name, file).toBeTruthy();
        if (!name) continue;
        expect(scripts[name], `${file} -> npm run ${name}`).toBeTruthy();
      }
    }
  });

  it("does not call actions outside this repository", () => {
    // Settings allow only actions owned by devendrarj25. actions/checkout and
    // github/codeql-action fail the run before any job starts.
    const owned = "devendrarj25/FRIDAY-AI-ASSISTANT/.github/actions/checkout@main";
    for (const file of fs.readdirSync(DIR).filter((name) => name.endsWith(".yml"))) {
      const src = read(file);
      expect(src, file).not.toMatch(/uses:\s+(actions|github)\//);
      if (src.includes("actions/checkout")) expect(src, file).toContain(owned);
    }
    const node = fs.readFileSync(path.resolve(DIR, "../actions/friday-node/action.yml"), "utf8");
    expect(node).not.toMatch(/uses:\s+(actions|github)\//);
  });

  it("authenticates git with basic x-access-token, not bearer", () => {
    // Run 37202021354 sent Authorization: bearer. GitHub git returned 401 and
    // the runner then failed with "could not read Username".
    const action = fs.readFileSync(path.resolve(DIR, "../actions/checkout/action.yml"), "utf8");
    expect(action).toContain("x-access-token");
    expect(action).toContain("AUTHORIZATION: basic");
    expect(action).toContain('GIT_CONFIG_KEY_0="http.${SERVER}/.extraheader"');
    expect(action).toContain('GIT_CONFIG_KEY_1="credential.helper"');
    expect(action).toContain('git config --local "http.${SERVER}/.extraheader"');
    expect(action).toContain('git config --local credential.helper ""');
    expect(action).not.toContain("AUTHORIZATION: bearer");
    // Full history of branches is not a pull ref or a tag. A public fork
    // pull request and a Test EXE of a tag both have to check out.
    expect(action).toContain("refs/pull/[0-9]+/(merge|head)");
    expect(action).toContain("refs/tags/${branch}");
    expect(action).toContain('git checkout --force -B "$branch" "origin/$branch"');
    // Run 37296728618 fetched only branches, then checked out GITHUB_SHA.
    // On pull_request that SHA is refs/pull/N/merge. Git exits 128:
    // unable to read tree (<sha>). The tree must be local before checkout.
    expect(action).toContain('git cat-file -e "${ref}^{tree}"');
    expect(action).toContain('"${GITHUB_REF:-}"');
    expect(action).toContain('git fetch --force origin "+${GITHUB_REF}:${GITHUB_REF}" || true');
    expect(action).toContain('git fetch --force origin "$ref"');
  });

  it("derives Node/npm from package.json engines and validates them", () => {
    const action = fs.readFileSync(path.resolve(DIR, "../actions/friday-node/action.yml"), "utf8");
    expect(action).toContain("engines.node");
    expect(action).toContain("engines.npm");
    expect(action).toContain("check-latest: true");
    expect(action).toContain("node --version");
    expect(action).toContain("npm --version");
    expect(action).toContain("Refuse the runner's preinstalled Node");
    // The Node major must come from package.json, never a literal in CI.
    expect(action).toContain("node-version: ${{ steps.engines.outputs.node_major }}.x");
    expect(action).not.toMatch(/node-version:\s*['"]?\d+/);
  });

  it("package.json still declares the engine floor CI relies on", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(DIR, "../../package.json"), "utf8"));
    expect(pkg.engines.node).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect(pkg.engines.npm).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect(Number(pkg.engines.node.replace(/\D/g, "").slice(0, 2))).toBeGreaterThanOrEqual(22);
  });
});

describe("PR validation", () => {
  const src = read("pr-validation.yml");
  const doc = load("pr-validation.yml");

  it("runs on pull requests into main, manual dispatch, and an Official Publish call — never on push", () => {
    expect(Object.keys(doc.on).sort()).toEqual([
      "pull_request",
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(doc.on.pull_request.branches).toEqual(["main"]);
    expect(doc.on.push).toBeUndefined();
    expect(doc.on.workflow_call.inputs.caller.required).toBe(true);
    expect(doc.on.workflow_call.inputs.caller.default).toBeUndefined();
    expect(doc.on.workflow_call.inputs.sha.required).toBe(true);
    expect(src).toContain("PR Validation is called only by Official Publish.");
    expect(src).toContain("Official Publish must name the exact commit to validate.");
    // github.event_name inside a called workflow is the caller's event, so a
    // comparison with workflow_call never matches and must not gate the refusal.
    expect(src).not.toContain("github.event_name == 'workflow_call'");
    expect(src).not.toContain('[ "$event" = "workflow_call" ]');
    expect(src).toContain("github.workflow_ref");
    expect(src).toContain(".github/workflows/official-publish.yml@");
    expect(src).toContain(".github/workflows/pr-validation.yml@");
    const refuse = doc.jobs.gate.steps.find(
      (step: { name?: string }) => step.name === "Refuse a call that is not Official Publish",
    );
    expect(refuse?.if).toBeUndefined();
  });

  it("cannot write code and only publishes its own result", () => {
    // `statuses: write` is the ONE write scope: PR Validation publishes the
    // "PR Validation" commit status for the exact commit it validated, which is
    // the evidence Official Publish requires. It still cannot push, tag,
    // release, merge or change any workflow.
    // `contents: write` exists only for the documentation auto-heal commit
    // (see "auto-heals a manual version bump" below). It still cannot tag,
    // release, merge, or write to main.
    expect(doc.permissions).toEqual({ contents: "write", statuses: "write" });
    expect(src).not.toContain("merge-only");
  });

  it("validates the exact dispatched commit and reports the result for it", () => {
    expect(doc.on.workflow_dispatch.inputs.sha).toBeTruthy();
    expect(src).toContain("ref: ${{ inputs.sha || github.event.pull_request.head.sha");
    expect(src).toContain("statuses/${{ steps.target.outputs.sha }}");
    expect(src).toContain("-f context='PR Validation'");
  });

  it("secret scan checks out the pull request head when GITHUB_SHA is the merge commit", () => {
    // Run 37296728618 left ref empty, so checkout used GITHUB_SHA. On
    // pull_request that is refs/pull/N/merge, which a heads-only fetch does
    // not contain.
    const pinned = "ref: ${{ inputs.sha || github.event.pull_request.head.sha || github.sha }}";
    expect(src).toContain(pinned);
    // Secret scan, CodeQL, and the advisory job. Validate keeps github.ref as
    // its last fallback. A pinned Official Publish commit must not leave
    // CodeQL or the audit on the caller SHA.
    expect(
      src.match(
        /ref: \$\{\{ inputs\.sha \|\| github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/g,
      ),
    ).toHaveLength(3);
  });

  it("validates tests, typecheck, integrity and a real Windows installer", () => {
    for (const cmd of [
      "npm test",
      "npm run typecheck",
      "npm run lint",
      "scripts/verify-deps.cjs",
      "scripts/audit-architecture.cjs --strict",
      "scripts/electron-pack.cjs --win nsis",
      "scripts/verify-build.cjs nsis",
      "windows-installer-smoke.ps1",
    ]) {
      expect(src, cmd).toContain(cmd);
    }
  });

  it("contains no release or tag logic", () => {
    for (const forbidden of [...RELEASE_ONLY, "gh release", "git tag"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // The single permitted write is the documentation auto-heal commit pushed
    // back to the pull request branch - never to main, never a release.
    expect(src.match(/git push/g) || []).toHaveLength(1);
    expect(src).toContain('git push origin "HEAD:refs/heads/$branch"');
    expect(src.match(/git commit/g) || []).toHaveLength(1);
    expect(src).toContain('git commit -m "chore: sync docs to v$version"');
  });

  it("auto-heals a manual version bump with documentation-only changes", () => {
    // ONE repair command for every derived version source and document.
    expect(src).toContain("node scripts/release-engine.cjs heal --check");
    expect(src).toContain('node scripts/release-engine.cjs heal --version "$version"');
    expect(src).toContain("identity --field releaseVersion");
    expect(src).toContain("canonical identity declares an invalid version");
    expect(src).not.toContain("release-engine.cjs sync");
    expect(src).not.toContain("release-engine.cjs stamp");
    expect(src).toContain("auto-heal touched non-documentation files");
  });

  it("heals BEFORE the tests so documentation drift can never fail npm test", () => {
    const heal = src.indexOf("release-engine.cjs heal --version");
    expect(heal).toBeGreaterThan(src.indexOf("run: npm ci"));
    expect(heal).toBeLessThan(src.indexOf("run: npm test"));
    expect(heal).toBeLessThan(src.indexOf("run: npm run typecheck"));
  });
});

describe("self-heal is wired into every build and publish path", () => {
  it("release prepare heals after apply, before verify, inside the release commit", () => {
    const src = read("release.yml");
    const prepare = src.slice(0, src.indexOf("  publish:"));
    const apply = prepare.indexOf("scripts/release-engine.cjs apply");
    const heal = prepare.indexOf("scripts/release-engine.cjs heal --version");
    const verify = prepare.indexOf("scripts/release-engine.cjs verify");
    expect(apply).toBeGreaterThan(-1);
    expect(heal).toBeGreaterThan(apply);
    expect(verify).toBeGreaterThan(heal);
    expect(heal).toBeLessThan(prepare.indexOf("run: npm test"));
    // The engine owns the staged file list, including this version's notes.
    expect(prepare).toContain("release-engine.cjs files --version");
  });

  it("release publish heals in-tree before the tests and never pushes the repair", () => {
    const src = read("release.yml");
    const publish = src.slice(src.indexOf("  publish:"));
    const heal = publish.indexOf("scripts/release-engine.cjs heal --version");
    expect(heal).toBeGreaterThan(publish.indexOf("run: npm ci"));
    expect(heal).toBeLessThan(publish.indexOf("run: npm test"));
    expect(heal).toBeLessThan(publish.indexOf("scripts/release-engine.cjs verify"));
    expect(publish).toContain("in-tree, never pushed");
    expect(publish).not.toContain("git push origin main");
  });

  it("test EXE build heals in-tree before the tests without committing", () => {
    const src = read("test-build.yml");
    const heal = src.indexOf("scripts/release-engine.cjs heal");
    expect(heal).toBeGreaterThan(src.indexOf("run: npm ci"));
    expect(heal).toBeLessThan(src.indexOf("run: npm test"));
    expect(src).not.toContain("git commit");
    expect(src).not.toContain("git push");
  });

  it("packages Windows EXEs only through electron-pack.cjs", () => {
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
      const src = read(file);
      expect(src, file).not.toContain("npx electron-builder");
    }
    const release = read("release.yml");
    const testBuild = read("test-build.yml");
    expect(release).toContain("npm run release:package");
    expect(testBuild).toContain("scripts/electron-pack.cjs --win $targets");
  });

  it("the local CMD build heals instead of hard-failing on drift", () => {
    const cmd = fs.readFileSync(path.resolve(__dirname, "../../scripts/build-windows.cmd"), "utf8");
    const heal = cmd.indexOf('release-engine.cjs" heal');
    const verify = cmd.indexOf('release-engine.cjs" verify');
    expect(heal).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(heal);
    expect(cmd.indexOf("scripts\\electron-pack.cjs")).toBeGreaterThan(heal);
  });

  it("Authenticode-signs CMD artifacts when CSC_LINK is set, and never self-signs by default", () => {
    const cmd = fs.readFileSync(path.resolve(__dirname, "../../scripts/build-windows.cmd"), "utf8");
    const sign = fs.readFileSync(path.resolve(__dirname, "../../scripts/sign-windows.ps1"), "utf8");
    expect(cmd).toContain("CSC_LINK");
    expect(cmd).toContain("sign-windows.ps1");
    expect(cmd).toContain("unsigned build");
    expect(cmd).not.toContain("AllowSelfSigned");
    expect(sign).toContain("A CA-issued PFX is required");
    expect(sign).toContain("AllowSelfSigned");
  });
});

describe("test EXE build", () => {
  const src = read("test-build.yml");
  const doc = load("test-build.yml");

  it("is manual only and accepts any branch or pull request", () => {
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    expect(doc.on.workflow_dispatch.inputs.ref).toBeTruthy();
    expect(src).toContain("refs/pull/");
    expect(src).not.toContain("test-exe-once");
  });

  it("checks out the complete branch state", () => {
    expect(src).toContain("fetch-depth: 0");
    expect(src).toContain("submodules: recursive");
    expect(src).toContain("lfs: true");
  });

  it("gives test builds real prerelease versions and keeps official versions clean", () => {
    expect(src).toContain("release-engine.cjs testplan");
    expect(src).toContain("release-engine.cjs stamp");
    // The official version is never bumped, changed on main or committed here.
    expect(src).not.toContain("release-engine.cjs apply");
    expect(src).not.toContain("CHANGELOG.md");
    expect(src).toContain("stableBaseline");
    expect(src).toContain("select(.isPrerelease|not)");
    expect(src).toContain("identity --ref origin/main --field releaseVersion");
    expect(src).not.toContain("git show origin/main:package.json");
    expect(src).not.toContain("git show origin/main:config/friday-version.json");
  });

  it("can write TEST notes when no stable tag exists yet", () => {
    expect(src).toContain("origin/main..HEAD");
    expect(src).toContain("verification notes only");
    expect(src).not.toContain(
      "Unable to resolve the previous stable release commit for TEST notes",
    );
  });

  it("can publish a TEST prerelease the Test update channel can detect", () => {
    expect(doc.on.workflow_dispatch.inputs.publish.default).toBe(false);
    expect(src).toContain("--prerelease");
    expect(src).toContain('release-manifest.cjs --version "$version" --channel test');
    // A published test build ships BOTH deliverables, under the separate
    // "FRIDAY Test" Windows identity so it installs beside — never over —
    // the production FRIDAY.
    expect(src).toContain("release/FRIDAY-Portable-$version.exe");
    expect(src).toContain("release/FRIDAY-Test-Setup-$version.exe");
    expect(src).not.toContain("release/FRIDAY-Setup-$version.exe");
    expect(src).toContain("appId=dev.friday.desk.test");
    expect(src).toContain('productName="FRIDAY Test"');
  });

  it("only ever deletes TEST prereleases, never an official release", () => {
    expect(src).toContain("select(.isPrerelease)");
    expect(src.split("gh release delete").length - 1).toBe(1);
  });

  it("stamps the test channel and uploads the packaged EXE artifacts", () => {
    expect(src).toContain("resources/build-channel.json");
    expect(src).toContain("channel:'test'");
    expect(src).toContain("friday-test-build-");
    expect(src).not.toContain("actions/upload-artifact");
    expect(src).toContain("FRIDAY-Test-");
    expect(doc.on.workflow_dispatch.inputs.package.default).toContain("portable only");
    // Verification must match what was actually packaged.
    expect(src).toContain("verify-build.cjs portable");
    expect(src).toContain("verify-build.cjs all");
  });

  it("never commits, pushes or touches main", () => {
    // Write exists for one thing only: the TEST prerelease and its tag.
    // The other permissions are read-only, so a fresh PR Validation result
    // can be reused without letting this workflow push or merge.
    expect(doc.permissions).toEqual({
      contents: "write",
      actions: "read",
      checks: "read",
      statuses: "read",
    });
    for (const forbidden of ["git push", "git commit", "release-engine.cjs apply"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // Reading tags is fine; creating one locally is not (the prerelease tag is
    // created by GitHub from `gh release create`).
    expect(src).not.toMatch(/git tag (?!--list)/);
    expect(src).not.toMatch(/pull-requests:\s*write/);
  });

  it("runs the same real CMD build scripts as scripts/build-windows.cmd", () => {
    const cmd = fs.readFileSync(path.resolve(__dirname, "../../scripts/build-windows.cmd"), "utf8");
    const live = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    for (const name of [
      "check-engines.cjs",
      "ensure-electron.cjs",
      "setup-python.cjs",
      "init-runtime.cjs",
      "check-environment.cjs",
      "env-registry.cjs",
      "verify-boot.cjs",
      "readiness-test.cjs",
    ]) {
      expect(cmd, name).toContain(name);
      expect(live, name).toContain(name);
    }
    expect(live).toContain("readiness-test.cjs --pack");
  });
});

describe("official release", () => {
  const src = read("release.yml");
  const doc = load("release.yml");

  it("is manual or an Official Publish call, serialized per stage, and main only", () => {
    expect(Object.keys(doc.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(doc.on.push).toBeUndefined();
    expect(doc.on.pull_request).toBeUndefined();
    expect(doc.on.schedule).toBeUndefined();
    expect(doc.on.workflow_call.inputs.caller.required).toBe(true);
    expect(doc.on.workflow_call.inputs.caller.default).toBeUndefined();
    // A workflow-level group stays held until the caller run ends, so the
    // later publish call would wait on itself. Each stage job holds the same
    // group and releases it when that job ends.
    expect(doc.concurrency).toBeUndefined();
    for (const name of ["prepare", "publish"]) {
      expect(doc.jobs[name].concurrency.group).toBe("friday-release");
      expect(doc.jobs[name].concurrency["cancel-in-progress"]).toBe(false);
    }
    expect(src).toContain("Official releases run from main only");
    expect(src).toContain("Releases are manual only (workflow_dispatch).");
    expect(src).toContain("Only Official Publish may call Release / Build.");
    expect(src.match(/Only Official Publish may call Release \/ Build\./g)).toHaveLength(2);
    expect(src).not.toContain("github.event_name == 'workflow_call'");
    expect(src).not.toContain('[ "$event" = "workflow_call" ]');
    expect(src).toContain("github.workflow_ref");
    expect(src.match(/\.github\/workflows\/official-publish\.yml@/g)).toHaveLength(2);
    expect(src.match(/\.github\/workflows\/release\.yml@/g)).toHaveLength(2);
    expect(src).toContain("ref: main");
  });

  it("is stable-only; TEST prereleases belong exclusively to test-build.yml", () => {
    expect(doc.on.workflow_dispatch.inputs.prerelease).toBeUndefined();
    expect(src).not.toContain("--prerelease");
    expect(src).toContain("isPrerelease");
  });

  it("publish runs the same real CMD build scripts as scripts/build-windows.cmd", () => {
    const cmd = fs.readFileSync(path.resolve(__dirname, "../../scripts/build-windows.cmd"), "utf8");
    const publish = src.slice(src.indexOf("  publish:"));
    const live = publish
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    for (const name of [
      "check-engines.cjs",
      "ensure-electron.cjs",
      "setup-python.cjs",
      "init-runtime.cjs",
      "check-environment.cjs",
      "env-registry.cjs",
      "verify-boot.cjs",
      "readiness-test.cjs",
    ]) {
      expect(cmd, name).toContain(name);
      expect(live, name).toContain(name);
    }
    expect(live).toContain("readiness-test.cjs --pack");
  });

  it("Official Publish stays an ubuntu orchestrator and does not execute those Windows CMD scripts", () => {
    const official = read("official-publish.yml");
    const live = official
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(official).toContain("runs-on: ubuntu-latest");
    for (const name of [
      "setup-python.cjs",
      "init-runtime.cjs",
      "check-environment.cjs",
      "verify-boot.cjs",
      "readiness-test.cjs",
    ]) {
      expect(live, name).not.toContain(name);
    }
  });

  it("uses optional secret-backed Authenticode signing before checksums", () => {
    expect(src).toContain("WINDOWS_SIGNING_CERTIFICATE_BASE64");
    expect(src).toContain("WINDOWS_SIGNING_CERTIFICATE_PASSWORD");
    expect(at("sign-windows.ps1")).toBeLessThan(at("scripts/release-manifest.cjs"));
  });

  it("owns the whole SemVer/build/verify/tag/release pipeline exactly once", () => {
    for (const cmd of [
      "scripts/release-engine.cjs decide",
      "scripts/release-engine.cjs apply",
      "npm run release:package",
      "scripts/release-manifest.cjs",
      "scripts/verify-build.cjs all",
      "gh release create",
    ]) {
      // Count executed steps only — the header comment documents the same
      // pipeline in prose and must not be mistaken for a second implementation.
      const runs = src
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .filter((line) => line.includes(cmd)).length;
      expect(runs, cmd).toBe(1);
    }
  });

  // Executable steps only — the header comment describes the same pipeline in
  // prose and must not be read as ordering.
  const steps = src
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const at = (needle: string) => {
    const index = steps.indexOf(needle);
    expect(index, needle).toBeGreaterThanOrEqual(0);
    return index;
  };

  it("has exactly two manual stages: prepare the release PR, then publish", () => {
    expect(Object.keys(doc.jobs).sort()).toEqual(["prepare", "publish"]);
    expect(doc.on.workflow_dispatch.inputs.stage.options).toEqual(["prepare", "publish"]);
    expect(doc.on.workflow_dispatch.inputs.stage.default).toBe("prepare");
    expect(doc.jobs.prepare.if).toBe("inputs.stage == 'prepare'");
    expect(doc.jobs.publish.if).toBe("inputs.stage == 'publish'");
  });

  it("never pushes the version commit to protected main", () => {
    expect(steps).not.toMatch(/git push origin HEAD:\$\{\{ github\.ref_name \}\}/);
    expect(steps).not.toMatch(/git push[^\n]*\bmain\b/);
    expect(steps).toContain('git push origin "HEAD:$branch"');
    expect(steps).toContain("gh pr create --base main");
    expect(steps).toContain("not permitted to create or approve pull requests");
    expect(steps).toContain("Allow GitHub Actions to create and approve pull requests");
    expect(steps).toContain("compare/main...$branch?expand=1");
    expect(doc.permissions["pull-requests"]).toBe("write");
  });

  it("validates a clean main before anything is versioned or built", () => {
    expect(steps).toContain("Validate clean main");
    expect(steps).toContain("git status --porcelain");
    expect(at("Validate clean main")).toBeLessThan(at("scripts/release-engine.cjs decide"));
    expect(at("Validate clean main")).toBeLessThan(at("npm run release:package"));
  });

  it("prepares version, changelog and notes on a release branch only", () => {
    expect(at("scripts/release-engine.cjs decide")).toBeLessThan(
      at("scripts/release-engine.cjs apply"),
    );
    expect(at("scripts/release-engine.cjs apply")).toBeLessThan(
      at("Open the release Pull Request"),
    );
    expect(at("npm test")).toBeLessThan(at("Open the release Pull Request"));
    expect(at("Open the release Pull Request")).toBeLessThan(at("npm run release:package"));
    expect(steps).toContain("releases/notes/${{ steps.plan.outputs.tag }}.md");
    expect(src).toContain("reusing the curated release notes already on main");
    expect(src).toContain("release-engine.cjs notes");
    expect(src).toContain("release-engine.cjs guard-notes");
  });

  it("confirms the first unpublished public line without walking full git history", () => {
    expect(src).toContain(
      "confirming the declared unpublished version without walking full history",
    );
    expect(src).toContain("release-engine.cjs commits-since");
    expect(doc.on.workflow_dispatch.inputs.release_type.options).toEqual([
      "auto",
      "patch",
      "minor",
      "major",
      "extreme",
      "revision",
    ]);
  });

  it("publish tags and names EXEs from the public four-part identity, not npm encoding", () => {
    const publish = src.slice(src.indexOf("  publish:"));
    const live = publish
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(live).toContain("identity --field releaseVersion");
    expect(live).not.toMatch(/JSON\.parse\([^)]*package\.json[^)]*\)\.version/);
    const plan = publish.slice(
      publish.indexOf("Read the merged release version"),
      publish.indexOf("Prove the release PR was merged"),
    );
    expect(plan).toContain("identity --field releaseVersion");
    expect(plan).toContain("config/friday-version.json");
    expect(plan).not.toContain("put into package.json");
  });

  it("cannot publish a stable release from an unmerged branch", () => {
    expect(steps).toContain("Prove the release PR was merged into main");
    expect(steps).toContain("gh pr list --state merged --base main --head");
    expect(steps).toContain("git merge-base --is-ancestor");
    expect(at("Prove the release PR was merged into main")).toBeLessThan(
      at("npm run release:package"),
    );
  });

  it("builds and verifies before the tag and release", () => {
    expect(at("npm run release:package")).toBeLessThan(at("scripts/verify-build.cjs all"));
    expect(at("scripts/verify-build.cjs all")).toBeLessThan(at("gh release create"));
    expect(at("gh release create")).toBeLessThan(at("Confirm the release and its assets"));
    expect(at("Confirm the release and its assets")).toBeLessThan(
      at("Keep only the last 3 releases"),
    );
    // The tag is created at the merged main commit that was built.
    expect(steps).toContain("--target '${{ steps.plan.outputs.sha }}'");
  });

  it("reuses a valid pending release and safely replaces only a stale orphan", () => {
    expect(steps).toContain("Resolve an existing release branch or release PR");
    expect(steps).toContain("gh pr list --state open --base main --head");
    expect(steps).toContain("git ls-remote --exit-code --heads origin");
    expect(steps).toContain("mode=existing_branch");
    expect(steps).toContain("complete=true");
    expect(steps).toContain('git push origin --delete "$branch"');
    expect(steps).not.toMatch(/gh pr (review|merge)/);
    expect(at("Resolve an existing release branch or release PR")).toBeLessThan(
      at("Open the release Pull Request"),
    );
  });

  it("derives the next official version from a non-prerelease stable baseline", () => {
    // The baseline now resolves version AND commit through release-engine's
    // `baseline` command, so a published version whose tag is missing locally
    // can never turn into "diff the whole history".
    expect(steps).toContain("release-engine.cjs baseline");
    expect(steps).toContain("select(.isPrerelease|not)");
    expect(steps).not.toContain('previous || "0.0.0"');
  });

  it("measures release changes over a real commit range", () => {
    expect(steps).toContain('range="$prev..HEAD"');
    expect(steps).toContain('--grep="^release: ${prev}\\$"');
  });

  it("keeps only the last 3 OFFICIAL releases in one authoritative cleanup step", () => {
    expect(src.split("gh release delete").length - 1).toBe(1);
    expect(src).toContain("select(.isPrerelease|not)");
    expect(src).toContain(".[3:]");
    expect(src).toContain("steps.confirm.outputs.confirmed == 'true'");
  });

  it("never carries a test-build marker into a production EXE", () => {
    expect(src).toContain("rm -f resources/build-channel.json");
  });

  it("re-restores reviewed notes after npm test and guards them before GitHub publish", () => {
    expect(src).toContain("Restore reviewed release notes after tests");
    expect(src).toContain("release-engine.cjs guard-notes");
    expect(src).toContain("Refusing to describe the whole history as this release.");
    expect(src).not.toContain("measuring the full history");
    expect(src).not.toContain("git log --no-merges --pretty=%s > commits.txt");
    expect(at("Restore reviewed release notes after tests")).toBeGreaterThan(at("run: npm test"));
    expect(at("Guard canonical What's New before publishing")).toBeLessThan(
      at("gh release create"),
    );
    const publish = src.slice(src.indexOf("  publish:"));
    expect(publish).toContain("--setup");
    const rebuild = publish.slice(publish.indexOf("steps.plan.outputs.exists"));
    expect(rebuild).toContain("gh release upload");
    expect(rebuild.slice(0, rebuild.indexOf("else"))).not.toContain("--notes-file");
  });
});

/**
 * Safe merge flow.
 *   branch → CI → Test EXE → owner tests → PR → required checks →
 *   owner approval → merge main → automatic branch deletion
 * A public ruleset may block deletion and force-push. It does not make main
 * merge-only. A private free repository has no ruleset. Unexpected pushes
 * are preserved by main-safety-recovery.yml.
 */
describe("safe merge flow", () => {
  const GITHUB = path.resolve(DIR, "..");

  it("has one non-destructive backup workflow for unexpected pushes to main", () => {
    expect(fs.existsSync(path.join(DIR, "main-guard.yml"))).toBe(false);
    const mainPushWorkflows: string[] = [];
    for (const file of fs.readdirSync(DIR)) {
      const doc = load(file);
      const push = doc.on?.push;
      if (!push) continue;
      const branches: string[] = push.branches ?? [];
      if (!branches.includes("main")) continue;
      mainPushWorkflows.push(file);
    }
    expect(mainPushWorkflows).toEqual(["main-safety-recovery.yml"]);

    const src = read("main-safety-recovery.yml");
    const doc = load("main-safety-recovery.yml");
    expect(doc.permissions).toEqual({ contents: "write", "pull-requests": "read" });
    expect(src).toContain('select(.merged_at != null and .base.ref == "main")');
    expect(src).toContain('echo "unexpected=false"');
    expect(src).toContain('branch="recovery/main-${timestamp}-${short}"');
    expect(src).toContain('report="recovery/${timestamp}.md"');
    expect(src).toContain("UNEXPECTED MAIN PUSH — MANUAL REVIEW REQUIRED");
    expect(src).toContain('git switch -c "$branch"');
    expect(src).toContain('git merge-base --is-ancestor "$PUSHED_SHA" HEAD');
    expect(src).not.toMatch(/git\s+push[^\n]*(--force|-f\b)/);
    expect(src).not.toMatch(/git\s+reset/);
    expect(src).not.toMatch(/git\s+revert/);
    expect(src).not.toMatch(/gh\s+pr\s+(create|merge)/);
  });

  it("deletes the merged branch automatically and only after a real merge", () => {
    const doc = load("branch-cleanup.yml");
    const src = read("branch-cleanup.yml");
    expect(doc.on.pull_request.types).toEqual(["closed"]);
    expect(src).toContain("github.event.pull_request.merged == true");
    expect(src).toContain("git/refs/heads/$BRANCH");
    // main and long-lived branches are never deleted; a merged release/vX.Y.Z
    // branch is temporary and is cleaned up like any other work branch.
    expect(src).toContain("main|master|develop|development|release|recovery/*)");
    expect(src).not.toContain("release/*)");
  });

  it("never merges a pull request automatically", () => {
    for (const file of fs.readdirSync(DIR)) {
      const src = read(file);
      // repository-control.yml is the owner's MANUAL control surface: its merge
      // runs only on workflow_dispatch after the owner types MERGE. Every
      // automatic workflow still may never merge anything.
      if (file === "repository-control.yml") {
        expect(Object.keys(load(file).on)).toEqual(["workflow_dispatch"]);
        expect(src).toContain('[ "$CONFIRM" = "MERGE" ]');
        expect(src).not.toMatch(/enable-?auto-?merge|automerge|auto_merge/i);
        continue;
      }
      // safe-merge.yml is the owner's MANUAL safe-merge action: dispatch only,
      // typed MERGE confirmation, and every candidate re-validated by
      // scripts/merge-engine.cjs against the exact head commit before merging.
      if (file === "safe-merge.yml") {
        expect(Object.keys(load(file).on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
        expect(load(file).on.push).toBeUndefined();
        expect(load(file).on.pull_request).toBeUndefined();
        expect(load(file).on.workflow_call.inputs.confirm.required).toBe(true);
        expect(load(file).on.workflow_call.inputs.confirm.default).toBeUndefined();
        expect(load(file).on.workflow_call.inputs.delete_branch.type).toBe("string");
        expect(load(file).on.workflow_call.inputs.delete_branch.default).toBeUndefined();
        expect(src).toContain("inputs.confirm }}' = 'MERGE'");
        expect(src).toContain("merge-engine.cjs evaluate");
        expect(src).toContain("--match-head-commit");
        expect(src).toContain('gh pr merge "$pr" --merge');
        expect(src).toContain("Safe Merge is manual only, or one call from Official Publish.");
        expect(src).toContain("Safe Merge is manual only (workflow_dispatch).");
        expect(src).not.toContain("github.event_name == 'workflow_call'");
        expect(src).not.toContain('[ "$event" = "workflow_call" ]');
        expect(src).toContain("github.workflow_ref");
        expect(src).toContain(".github/workflows/official-publish.yml@");
        expect(src).toContain(".github/workflows/safe-merge.yml@");
        expect(src).not.toMatch(
          /--squash|--rebase|--admin|enable-?auto-?merge|automerge|auto_merge/i,
        );
        continue;
      }
      if (file === "official-publish.yml") {
        expect(Object.keys(load(file).on)).toEqual(["workflow_dispatch"]);
        expect(src).not.toMatch(/gh pr merge/);
        expect(src).not.toMatch(/gh pr create/);
        expect(src).not.toMatch(/git push/);
        expect(src).not.toMatch(/gh workflow run/);
        expect(src).not.toContain("ci-workflow-run");
        expect(src).not.toMatch(/enable-?auto-?merge|automerge|auto_merge/i);
        const publish = load(file);
        for (const [name, job] of Object.entries<any>(publish.jobs)) {
          if (!job["runs-on"]) continue;
          expect(job.permissions?.["pull-requests"], name).toBe("read");
          expect(job.permissions?.contents, name).toBe("read");
        }
        expect(publish.jobs["prepare-release"].permissions["pull-requests"]).toBe("write");
        expect(publish.jobs["publish-release"].permissions["pull-requests"]).toBe("write");
        expect(publish.jobs.merge.permissions["pull-requests"]).toBe("write");
        continue;
      }
      expect(src, file).not.toMatch(/gh pr merge/);
      expect(src, file).not.toMatch(/enable-?auto-?merge|automerge|auto_merge/i);
      // Only the release workflow may OPEN a pull request (the release PR).
      // Official Publish may grant that same write scope to the called release
      // and Safe Merge jobs. It still cannot merge one itself.
      if (file !== "release.yml" && file !== "safe-merge.yml")
        expect(src, file).not.toMatch(/pull-requests:\s*write/);
    }
  });

  it("never releases as a side effect of landing on main", () => {
    const doc = load("release.yml");
    // Manual dispatch, or one call from Official Publish. No push, no
    // pull_request, and no schedule trigger.
    expect(Object.keys(doc.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(doc.on.push).toBeUndefined();
    expect(doc.on.pull_request).toBeUndefined();
    expect(doc.on.schedule).toBeUndefined();
    for (const file of fs.readdirSync(DIR)) {
      if (file === "release.yml") continue;
      const src = read(file);
      for (const forbidden of RELEASE_ONLY) {
        // PR validation repairs documentation declarations for the version the
        // branch already declares; `stamp`/`sync` never create a release.
        if (file === "pr-validation.yml" && forbidden === "release-engine.cjs apply") continue;
        // The test build may publish a TEST prerelease (never an official one)
        // with its own checksum manifest — that is the test update channel.
        if (file === "test-build.yml" && forbidden === "release-manifest.cjs") continue;
        expect(src, file).not.toContain(forbidden);
      }
      if (file === "test-build.yml") {
        expect(src).toContain("--prerelease");
        expect(src).not.toContain('gh release create "$tag" --title');
      }
    }
  });

  it("requires owner review and states the flow in the PR template", () => {
    const owners = fs.readFileSync(path.join(GITHUB, "CODEOWNERS"), "utf8");
    expect(owners).toMatch(/^\*\s+@\S+/m);
    const template = fs.readFileSync(path.join(GITHUB, "pull_request_template.md"), "utf8");
    expect(template).toContain("Test EXE Build");
    expect(template).toContain("PR Validation");
    expect(template).toMatch(/does \*\*not\*\* publish/);
  });

  it("documents safety that holds whether the repository is public or private", () => {
    const doc = fs.readFileSync(path.resolve(__dirname, "../../docs/FRIDAY_MERGE_FLOW.md"), "utf8");
    for (const line of [
      "public or private",
      "Main Protection",
      "does not require a review or a status check",
      "private free personal repository",
      "Required Code Owner review is not enforced",
      "non-main development branch",
      "manual owner merge into main",
      "main-safety-recovery.yml",
      "workflow_dispatch",
    ])
      expect(doc).toContain(line);
    // The docs must not claim server-side enforcement that does not exist.
    expect(doc).not.toMatch(/^- Require review from Code Owners$/m);
  });
});

describe("release orchestration hardening", () => {
  const read2 = (f: string) => read(f);

  it("never lets a missing stable tag abort the TEST publish step", () => {
    const src = read2("test-build.yml");
    // `grep` exits 1 when no stable vX.Y.Z tag exists yet; under `pipefail`
    // that silently killed the whole publish step.
    expect(src).toMatch(/prevtag=\$\(git tag --list 'v\*'.*\|\| true\)/);
  });

  it("stops Official Publish on an unsafe plan instead of publishing anyway", () => {
    const src = read2("official-publish.yml");
    expect(src).toContain("steps.plan.outputs.step == 'error'");
    expect(src).toContain("Stop on an unsafe or ambiguous release state");
    expect(src).toContain("options: [auto, patch, minor, major, extreme, revision]");
  });

  it("makes the Safe Merge confirmation a required dispatch input", () => {
    const src = read2("safe-merge.yml");
    const doc = load("safe-merge.yml");
    expect(src).toMatch(/confirm:[\s\S]{0,160}required: true/);
    expect(src).toContain("= 'MERGE' ]");
    // Safe Merge 37200400230: startup_failure, zero jobs. A required input
    // must not also declare a default, and delete_branch must be the string
    // Official Publish already sends (`true`), not a boolean.
    expect(doc.on.workflow_dispatch.inputs.confirm.required).toBe(true);
    expect(doc.on.workflow_dispatch.inputs.confirm.default).toBeUndefined();
    expect(doc.on.workflow_dispatch.inputs.delete_branch.type).toBe("string");
    expect(doc.on.workflow_dispatch.inputs.delete_branch.default).toBe("true");
    expect(doc.on.workflow_call.inputs.confirm.required).toBe(true);
    expect(doc.on.workflow_call.inputs.confirm.default).toBeUndefined();
    expect(doc.on.workflow_call.inputs.delete_branch.type).toBe("string");
    expect(doc.on.workflow_call.inputs.delete_branch.default).toBeUndefined();
    expect(src).toContain("mergeability still computing");
  });
});

describe("single application update path", () => {
  it("keeps the app update on the verified GitHub release channel only", () => {
    const updater = fs.readFileSync(path.resolve(__dirname, "../../electron/updater.cjs"), "utf8");
    expect(updater).not.toContain("feedUrl");
    expect(updater).toContain("managedByReleaseChannel");
    const main = fs.readFileSync(path.resolve(__dirname, "../../electron/main.cjs"), "utf8");
    expect(main).toContain("releaseChannelAppUpdate");
    expect(main).not.toContain("FRIDAY_UPDATE_FEED");
  });

  it("describes both uninstall modes in the uninstall contract", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../installer/uninstall/index.ts"),
      "utf8",
    );
    expect(src).toContain("KEEP_DATA_PLAN");
    expect(src).toContain("DELETE_EVERYTHING_PLAN");
    const nsh = fs.readFileSync(
      path.resolve(__dirname, "../../installer/build/installer.nsh"),
      "utf8",
    );
    expect(nsh).toContain("Delete all FRIDAY data and resources");
    expect(nsh).toContain('StrCpy $FridayUnMode "delete"');
  });
});

describe("release publish must not be blocked by its own auto-heal", () => {
  const wf = (name: string) =>
    fs.readFileSync(path.resolve(__dirname, "../../.github/workflows", name), "utf8");

  it("never pushes an auto-heal commit when validating a pinned commit", () => {
    const src = wf("pr-validation.yml");
    // The guard must sit BEFORE the push, otherwise the pinned head moves and
    // Official Publish aborts with "pull request moved".
    const guard = src.indexOf("PINNED-COMMIT GUARD");
    const push = src.indexOf('git push origin "HEAD:refs/heads/$branch"');
    expect(guard).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(guard);
    expect(src).toContain("if [ -n '${{ inputs.sha }}' ]; then");
  });

  it("explains a BLOCKED merge state as a branch-protection setting", () => {
    const merge = require_("../../scripts/merge-engine.cjs");
    const decision = merge.evaluatePullRequest({
      number: 3,
      headRefName: "release/v1.4.1",
      baseRefName: "main",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      headRefOid: "c".repeat(40),
      statusCheckRollup: [{ name: "PR Validation", status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons.join(" ")).toContain("branch protection");
  });

  it("documents the exact required status check name owners must configure", () => {
    const doc = fs.readFileSync(
      path.resolve(__dirname, "../../docs/FRIDAY_GITHUB_ACTIONS.md"),
      "utf8",
    );
    expect(doc).toContain("GitHub Settings → Branches: the exact required check names");
    expect(doc).toContain("PR Validation / validate");
    expect(doc).toContain("Diagnosing a stuck release");
  });
});

describe("workflows that read statusCheckRollup need actions: read", () => {
  // GitHub resolves statusCheckRollup through the producing workflow run, so
  // without `actions: read` the whole `gh pr list --json ...` call dies with
  // "GraphQL: Resource not accessible by integration" and no merge is possible.
  for (const file of ["safe-merge.yml", "repository-control.yml"]) {
    it(`${file} grants actions: read`, () => {
      const src = fs.readFileSync(path.resolve(__dirname, "../../.github/workflows", file), "utf8");
      expect(src).toContain("statusCheckRollup");
      const permissions = src.slice(src.indexOf("permissions:"), src.indexOf("jobs:"));
      expect(permissions).toMatch(/actions:\s*read/);
    });
  }
});

describe("automatic-health workflows", () => {
  it("never release, merge, tag or write code", () => {
    for (const file of ["health-weekly.yml", "auto-recover.yml", "security.yml"]) {
      const src = read(file);
      expect(src, file).not.toMatch(/git\s+(push|commit|tag)/);
      expect(src, file).not.toMatch(/gh\s+pr\s+(merge|create)/);
      expect(src, file).not.toMatch(/gh\s+release/);
      expect(src, file).not.toMatch(/contents:\s*write/);
      expect(src, file).not.toMatch(/pull-requests:\s*write/);
    }
  });

  it("every job has a timeout and every workflow a concurrency group", () => {
    for (const file of ["health-weekly.yml", "auto-recover.yml", "security.yml"]) {
      const doc = load(file);
      expect(doc.concurrency, file).toBeTruthy();
      for (const [name, job] of Object.entries<any>(doc.jobs)) {
        expect(job["timeout-minutes"], `${file}/${name}`).toBeGreaterThan(0);
      }
    }
  });

  it("Auto Recover only touches validation workflows and never a run that executed", () => {
    const src = read("auto-recover.yml");
    expect(src).toContain("PR Validation|Health Weekly|Security Scan");
    expect(src).not.toContain("CI Fast");
    for (const forbidden of [
      "Release / Build",
      "Official Publish",
      "Safe Merge",
      "Test EXE Build",
    ]) {
      expect(
        src
          .split("\n")
          .filter((l) => !l.trim().startsWith("#"))
          .join("\n"),
      ).not.toContain(forbidden);
    }
    expect(src).toContain("real failure");
    expect(src).toContain(".conclusion != null");
    expect(src).toContain("actions/runs/$id/rerun");
  });

  it("Auto Recover covers a whole billing cycle, not just the last few days", () => {
    const src = read("auto-recover.yml");
    expect(src).toContain("date -u -d '35 days ago'");
    expect(src).not.toContain("3 days ago");
    // A backlog of open pull requests must not be cut off at gh's default of 30.
    expect(src).toContain("--state open --limit 200");
  });

  it("PR Validation never splices a branch name into a script and validates the healed commit", () => {
    const src = read("pr-validation.yml");
    const inRunBlocks = src
      .split("\n")
      .filter((l) => l.includes("github.event.pull_request.head.ref"))
      .filter((l) => !/^\s*(HEAD_REF:|group:|#)/.test(l));
    expect(inRunBlocks, "head.ref may only reach a script through env").toEqual([]);
    // GITHUB_TOKEN pushes start no workflow run, so the auto-healed head needs
    // its own "PR Validation" status or the pull request is BLOCKED forever.
    expect(src).toContain("id: heal");
    expect(src).toContain("HEALED_SHA: ${{ steps.heal.outputs.sha }}");
    expect(src).toContain("for sha in $TARGET_SHA $HEALED_SHA");
    expect(src.indexOf('echo "sha=$healed" >> "$GITHUB_OUTPUT"')).toBeGreaterThan(
      src.indexOf('git push origin "HEAD:refs/heads/$branch"'),
    );
  });

  it("Main Safety Recovery does not treat publishing main or a normal merge as an unexpected push", () => {
    const src = read("main-safety-recovery.yml");
    // First push into an empty repository: no previous commit, nothing to preserve.
    expect(src).toContain("initial creation of main - no recovery action");
    expect(src).toContain("PREVIOUS_SHA: ${{ github.event.before }}");
    // The PR link can appear a moment after the push event: retry before deciding.
    expect(src).toContain("for attempt in 1 2 3 4; do");
    expect(src).toContain("normal merged Pull Request detected");
    // The recovery branch is still created for a genuinely unexpected push.
    expect(src).toContain("recovery/main-");
    expect(src).toContain("automated agent (name withheld)");
    expect(src).not.toContain("PUSH_ACTOR");
  });

  it("keeps routine background spending small: Dependabot monthly, Auto Recover twice a day", () => {
    const dependabot = fs.readFileSync(path.resolve(DIR, "..", "dependabot.yml"), "utf8");
    expect(dependabot, "no weekly version-update PRs").not.toMatch(/interval:\s*weekly/);
    expect(dependabot.match(/interval:\s*monthly/g)?.length).toBeGreaterThanOrEqual(3);
    expect(read("auto-recover.yml")).toContain('cron: "41 */12 * * *"');
  });

  it("Health Weekly keeps one issue and the same script as npm run resume", () => {
    const src = read("health-weekly.yml");
    expect(src).toContain("scripts/resume.cjs --ci");
    const resume = fs.readFileSync(path.resolve(DIR, "..", "..", "scripts/resume.cjs"), "utf8");
    expect(resume).toContain('.venv", "bin", "python3"');
    expect(resume).toContain("return fallback");
    expect(resume).toContain("scripts/advisory-audit.cjs");
    expect(resume).toContain("--report-only");
    expect(src).toContain("pip-audit");
    expect(src).toContain("FRIDAY health check failing");
    expect(src).toContain("gh issue close");
    expect(src).toContain("gh issue comment");
  });

  it("a leaked secret fails the scan, and a blocking advisory fails the audit job", () => {
    const src = read("security.yml");
    const doc = load("security.yml");
    expect(doc.on.pull_request).toBeUndefined();
    expect(doc.jobs.codeql.if).toContain("needs.scope.result == 'success'");
    expect(doc.jobs.codeql.if).toContain("private == false");
    expect(doc.jobs.audit.if).toContain("needs.scope.result == 'success'");
    expect(src).toContain("--exit-code 1");
    expect(src).toContain("scripts/advisory-audit.cjs");
    const steps = doc.jobs.audit.steps as Array<{ uses?: string; run?: string }>;
    const pythonAt = steps.findIndex((step) => String(step.uses || "").includes("actions/python"));
    const auditAt = steps.findIndex((step) =>
      String(step.run || "").includes("advisory-audit.cjs"),
    );
    expect(pythonAt).toBeGreaterThan(-1);
    expect(auditAt).toBeGreaterThan(pythonAt);
    expect(String(steps[auditAt]?.run)).toContain("pip-audit");
  });

  it("PR Validation is the one pull-request run for tests, kernel, secrets and audits", () => {
    const src = read("pr-validation.yml");
    const doc = load("pr-validation.yml");
    expect(doc.on.pull_request["paths-ignore"]).toBeUndefined();
    expect(doc.jobs.validate.if).toContain("needs.gate.result == 'success'");
    expect(doc.jobs["docs-only"].if).toContain("needs.gate.result == 'success'");
    expect(doc.jobs.secrets.if).toBeUndefined();
    expect(src).toContain("npm run lint");
    expect(src).toContain("npm run test:kernel");
    expect(src).toContain("scripts/tests-required.cjs");
    expect(src).toContain("scripts/check-provenance.cjs");
    expect(src).toContain("gitleaks:v8.24.3");
    expect(src).toContain("--exit-code 1");
    expect(doc.jobs.codeql.needs).toBe("gate");
    expect(doc.jobs.codeql.if).toContain("docs_only != 'true'");
    expect(doc.jobs.codeql.if).toContain("private == false");
    expect(doc.jobs.audit.needs).toBe("gate");
    expect(src).toContain("scripts/advisory-audit.cjs");
    const auditSteps = doc.jobs.audit.steps as Array<{ uses?: string; run?: string }>;
    const pythonAt = auditSteps.findIndex((step) =>
      String(step.uses || "").includes("actions/python"),
    );
    const auditAt = auditSteps.findIndex((step) =>
      String(step.run || "").includes("advisory-audit.cjs"),
    );
    expect(pythonAt).toBeGreaterThan(-1);
    expect(auditAt).toBeGreaterThan(pythonAt);
    const validateSteps = doc.jobs.validate.steps as Array<{ name?: string; run?: string }>;
    const devInstalls = validateSteps.filter((step) =>
      String(step.run || "").includes("kernel/requirements-dev.txt"),
    );
    expect(devInstalls).toHaveLength(1);
    const lintAt = validateSteps.findIndex((step) => step.name === "Lint");
    const kernelAt = validateSteps.findIndex((step) => step.name === "Kernel tests");
    const installAt = validateSteps.findIndex(
      (step) => step.name === "Install kernel dev requirements",
    );
    expect(installAt).toBeGreaterThan(-1);
    expect(lintAt).toBeGreaterThan(installAt);
    expect(kernelAt).toBeGreaterThan(lintAt);
    expect(String(validateSteps[lintAt]?.run)).not.toContain("pip install");
    expect(src).not.toContain("npm audit fix");
  });

  it("Test EXE and Official Publish reuse a fresh green PR Validation on the same commit", () => {
    const publish = read("official-publish.yml");
    const reuseAt = publish.indexOf("scripts/validation-freshness.cjs");
    const checksAt = publish.indexOf("orchestrator-engine.cjs checks");
    expect(reuseAt).toBeGreaterThan(-1);
    expect(checksAt).toBeGreaterThan(reuseAt);
    expect(publish).toContain("not starting another run");
    expect(publish).not.toContain("skipping a new PR Validation run");

    const testBuild = read("test-build.yml");
    const evidence = testBuild.indexOf("scripts/validation-freshness.cjs");
    const typecheck = testBuild.indexOf("npm run typecheck");
    expect(evidence).toBeGreaterThan(-1);
    expect(evidence).toBeLessThan(typecheck);
    expect(testBuild).toContain("steps.evidence.outputs.reuse != 'true'");
    expect(testBuild).toContain("electron-pack.cjs");

    const release = read("release.yml");
    expect(release).toContain("previous result is");
    expect(release).toContain("npm test");
    expect(release).not.toContain("validation-freshness.cjs");
  });
});
