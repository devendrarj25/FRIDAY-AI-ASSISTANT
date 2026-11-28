/**
 * GitHub CI contract.
 *
 * Eleven workflow files under .github/workflows/, each with one responsibility.
 * The complete catalog is docs/FRIDAY_GITHUB_ACTIONS.md; this file asserts the
 * on-disk inventory, permissions, and Node toolchain contract.
 *
 *   release.yml          — FRIDAY Release: plan, prepare, validate, merge, publish
 *   test-build.yml       — FRIDAY Test Build (optional TEST prerelease)
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
import { prRuns } from "./helpers/pr-validation";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

const DIR = path.resolve(__dirname, "../../.github/workflows");
const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8");
const load = (f: string) => parseYaml(read(f)) as any;

/** Steps that declare `shell: bash`. PowerShell steps are left to their own shell. */
function bashSteps(file: string): { job: string; name: string; script: string }[] {
  const doc = load(file) as { jobs?: Record<string, { steps?: unknown }> };
  const found: { job: string; name: string; script: string }[] = [];
  for (const [job, body] of Object.entries(doc.jobs ?? {})) {
    const steps = (body as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const row = step as { name?: unknown; shell?: unknown; run?: unknown };
      if (typeof row.run !== "string") continue;
      if (!String(row.shell || "").startsWith("bash")) continue;
      found.push({ job, name: String(row.name || job), script: row.run });
    }
  }
  return found;
}

function runScripts(file: string): { job: string; name: string; script: string }[] {
  const doc = load(file) as { jobs?: Record<string, { steps?: unknown }> };
  const found: { job: string; name: string; script: string }[] = [];
  for (const [job, body] of Object.entries(doc.jobs ?? {})) {
    const steps = (body as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const row = step as { name?: unknown; run?: unknown };
      if (typeof row.run !== "string") continue;
      found.push({ job, name: String(row.name || job), script: row.run });
    }
  }
  return found;
}

const RELEASE_ONLY = [
  "release-engine.cjs decide",
  "release-engine.cjs apply",
  "release-manifest.cjs",
];

describe("untrusted workflow input stays out of the shell script", () => {
  it("reads dispatch inputs from the environment", () => {
    for (const file of fs.readdirSync(DIR)) {
      for (const step of runScripts(file)) {
        expect(step.script, `${file} ${step.job} / ${step.name}`).not.toMatch(/\$\{\{\s*inputs\./);
        expect(step.script, `${file} ${step.job} / ${step.name}`).not.toMatch(
          /\$\{\{\s*github\.event\.(pull_request|issue)\.(title|body)/,
        );
      }
    }
    const release = read("release.yml");
    expect(release).toContain("OWNER_NOTES: ${{ inputs.notes }}");
    expect(release).toContain("printf '%s\\n' \"$OWNER_NOTES\"");
    expect(release).toContain("RELEASE_TITLE: ${{ inputs.title }}");
    expect(release).toContain('title="$RELEASE_TITLE"');
    expect(release).toContain('stage="$STAGE"');
  });
});

describe("workflow inventory", () => {
  it("has exactly the expected workflows and no duplicates", () => {
    expect(fs.readdirSync(DIR).sort()).toEqual([
      "auto-recover.yml",
      "branch-cleanup.yml",
      "health-weekly.yml",
      "main-safety-recovery.yml",
      "maintenance.yml",
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

  it("every bash step is valid bash and does not jam case in front of a test", () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".yml"));
    const failures: string[] = [];
    let checked = 0;
    for (const file of files) {
      for (const step of bashSteps(file)) {
        checked += 1;
        if (/case[ \t]+\[/.test(step.script)) {
          failures.push(`${file} ${step.job} ${step.name}: case before [`);
        }
        const tmp = path.join(os.tmpdir(), `friday-wf-${process.pid}-${checked}.sh`);
        fs.writeFileSync(tmp, step.script);
        try {
          execFileSync("bash", ["-n", tmp], { stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
          const stderr =
            error && typeof error === "object" && "stderr" in error
              ? String((error as { stderr?: Buffer }).stderr || "")
              : String(error);
          failures.push(`${file} ${step.job} ${step.name}: ${stderr.trim()}`);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(failures).toEqual([]);
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

  it("keeps composite actions off the removed Node 20 action runtime", () => {
    // GitHub removed the Node 20 action runtime on 2026-09-23. A javascript
    // action that still says node20 fails before any step. These files stay
    // composite and run with the runner shell.
    const actions = path.resolve(DIR, "../actions");
    const names = fs
      .readdirSync(actions)
      .filter((name) => fs.existsSync(path.join(actions, name, "action.yml")));
    expect(names.sort()).toEqual(["checkout", "friday-node", "python"]);
    for (const name of names) {
      const src = fs.readFileSync(path.join(actions, name, "action.yml"), "utf8");
      expect(src, name).toContain("using: composite");
      expect(src, name).not.toMatch(/using:\s*node\d+/);
      expect(src, name).not.toContain("ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION");
    }
  });

  it("selects Python 3.12 beside its libraries, not a copied exe", () => {
    const action = fs.readFileSync(path.resolve(DIR, "../actions/python/action.yml"), "utf8");
    expect(action).toContain("command -v python3.12");
    expect(action).toContain("py -3.12");
    expect(action).toContain("MINGW*|MSYS*|CYGWIN*");
    expect(action).toContain("sys.version_info[:2] == (3, 12)");
    expect(action).toContain("Windows Store python alias");
    expect(action).toContain("indows[Aa]pps");
    expect(action).toContain("os.path.dirname(sys.executable)");
    expect(action).toContain('echo "$dir" >> "$GITHUB_PATH"');
    expect(action).toContain('ln -sfn "$bin" "$RUNNER_TEMP/pybin/python"');
    expect(action).not.toContain('cp "$bin"');
  });

  it("finds Python 3.12 in the runner tool cache, then installs it with uv, when the image has dropped it from PATH", () => {
    const action = fs.readFileSync(path.resolve(DIR, "../actions/python/action.yml"), "utf8");
    // The order matters: PATH names first, then the tool cache, then uv, and only then the error.
    const pathNames = action.indexOf("command -v python3.12");
    const toolCache = action.indexOf("RUNNER_TOOL_CACHE");
    const uv = action.indexOf("python install 3.12");
    const failure = action.indexOf("uv could not install it");
    expect(pathNames).toBeGreaterThan(-1);
    expect(toolCache).toBeGreaterThan(pathNames);
    expect(uv).toBeGreaterThan(toolCache);
    expect(failure).toBeGreaterThan(uv);
    // Never a third-party action: the allow-list permits only devendrarj25 actions.
    // pip's commands (ruff, pytest, zizmor) must be found: a tool-cache Python's scripts folder goes on PATH,
    // and a uv interpreter (externally managed) gets a venv whose own bin is on PATH.
    expect(action).toContain("sysconfig.get_path('scripts')");
    expect(action).toContain('-m venv "$RUNNER_TEMP/py312"');
    expect(action).toContain('echo "$venvbin" >> "$GITHUB_PATH"');
    expect(action).not.toContain("actions/setup-python@");
    expect(action).not.toMatch(/uses:\s*(?!\.\/)/);
  });

  it("does not call actions outside this repository", () => {
    // Settings allow only actions owned by devendrarj25. actions/checkout and
    // github/codeql-action fail the run before any job starts.
    for (const file of fs.readdirSync(DIR).filter((name) => name.endsWith(".yml"))) {
      const src = read(file);
      expect(src, file).not.toMatch(/uses:\s+(actions|github)\//);
      expect(src, file).not.toContain("checkout@main");
      if (src.includes("actions/checkout")) {
        expect(src, file).toContain("uses: $/.github/actions/checkout");
      }
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
    expect(action).toContain("NODE_MAJOR: ${{ steps.engines.outputs.node_major }}");
    expect(action).toContain('echo "node-version: ${NODE_MAJOR}.x"');
    // Values from package.json reach the scripts as environment variables only: no `${{ }}` is pasted into a
    // shell or `node -e` script, so an engines string can never become code.
    const runs = action
      .split(/\n\s+run: \|/)
      .slice(1)
      .map((block) => block.split(/\n\s+- name:/)[0]);
    expect(runs.length).toBeGreaterThan(3);
    for (const block of runs) expect(block).not.toContain("${{");
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
    expect(src).toContain("PR Validation is called only by FRIDAY Release.");
    expect(src).toContain("FRIDAY Release must name the exact commit to validate.");
    // github.event_name inside a called workflow is the caller's event, so a
    // comparison with workflow_call never matches and must not gate the refusal.
    expect(src).not.toContain("github.event_name == 'workflow_call'");
    expect(src).not.toContain('[ "$event" = "workflow_call" ]');
    expect(src).toContain("github.workflow_ref");
    expect(src).toContain(".github/workflows/release.yml@");
    expect(src).toContain(".github/workflows/pr-validation.yml@");
    const refuse = doc.jobs.gate.steps.find(
      (step: { name?: string }) => step.name === "Refuse a call that is not FRIDAY Release",
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
    // Read-only by default; only `static` (the heal push and the pending status) and the
    // jobs that publish the status raise it, each in its own block.
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(doc.jobs.static.permissions).toEqual({ contents: "write", statuses: "write" });
    expect(doc.jobs.validate.permissions).toEqual({ contents: "read", statuses: "write" });
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
    ]) {
      expect(src, cmd).toContain(cmd);
    }
    // The Windows build is the shared pipeline Release and the CMD pack run.
    expect(src).toContain("scripts/build-pipeline.cjs --channel production --caller pr-validation");
    for (const cmd of [
      "scripts/electron-pack.cjs",
      "scripts/verify-build.cjs",
      "scripts/windows-installer-smoke.ps1",
    ]) {
      expect(prRuns(cmd), cmd).toBe(true);
    }
  });

  it("contains no release or tag logic", () => {
    for (const forbidden of [
      ...RELEASE_ONLY,
      "gh release create",
      "gh release upload",
      "gh release edit",
      "gh release delete",
      "git tag",
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    // The one release command allowed is a read: fetching the previously
    // published installer to update FROM in the installer test.
    expect(src.match(/gh release \w+/g)).toEqual(["gh release download"]);
    // The single permitted write is the documentation auto-heal commit pushed
    // back to the pull request branch - never to main, never a release.
    expect(src.match(/\bpush origin\b/g) || []).toHaveLength(1);
    // The push authenticates on its own command line: the checkout credential is gone before npm ci.
    expect(src).toContain('bash scripts/ci-git.sh push origin "HEAD:refs/heads/$branch"');
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
    expect(heal).toBeLessThan(src.indexOf("npm test -- --reporter=default"));
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
    expect(heal).toBeLessThan(prepare.indexOf("npm test -- --reporter=default"));
    // The engine owns the staged file list, including this version's notes.
    expect(prepare).toContain("release-engine.cjs files --version");
  });

  it("release publish heals in-tree before the build and never pushes the repair", () => {
    const src = read("release.yml");
    const publish = src.slice(src.indexOf("\n  publish:\n"));
    const heal = publish.indexOf("--through verify-versions");
    expect(heal).toBeGreaterThan(-1);
    expect(publish.indexOf("npm run typecheck")).toBeLessThan(heal);
    expect(publish).not.toContain("npm test");
    expect(publish).toContain("in-tree, never pushed");
    expect(publish).not.toContain("git push origin main");
    const pipeline = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
    expect(pipeline.indexOf("scripts/release-engine.cjs heal")).toBeLessThan(
      pipeline.indexOf("scripts/release-engine.cjs verify"),
    );
  });

  it("test EXE build heals in-tree before the tests without committing", () => {
    const src = read("test-build.yml");
    const heal = src.indexOf("--through verify-versions");
    expect(heal).toBeGreaterThan(-1);
    expect(heal).toBeLessThan(src.indexOf("npm test -- --reporter=default"));
    expect(src).not.toContain("git commit");
    expect(src).not.toContain("git push");
  });

  it("packages Windows EXEs only through the shared pipeline", () => {
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
      const src = read(file);
      expect(src, file).not.toContain("npx electron-builder");
    }
    const release = read("release.yml");
    const testBuild = read("test-build.yml");
    const pipeline = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
    expect(release).toContain(
      "build-pipeline.cjs --channel production --caller release --from stage-toolchain",
    );
    expect(testBuild).toContain(
      "build-pipeline.cjs --channel test --caller test --from stage-toolchain",
    );
    expect(pipeline).toContain("scripts/electron-pack.cjs");
    expect(release).not.toContain("npm run release:package");
    expect(testBuild).not.toContain("scripts/electron-pack.cjs");
  });

  it("the local CMD build heals instead of hard-failing on drift", () => {
    const pipeline = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
    const cmd = fs.readFileSync(path.resolve(__dirname, "../../scripts/build-windows.cmd"), "utf8");
    expect(cmd).toContain("build-pipeline.cjs");
    const heal = pipeline.indexOf("scripts/release-engine.cjs heal");
    const verify = pipeline.indexOf("scripts/release-engine.cjs verify");
    expect(heal).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(heal);
    expect(pipeline.indexOf("scripts/electron-pack.cjs")).toBeGreaterThan(heal);
  });

  it("Authenticode-signs CMD artifacts when CSC_LINK is set, and never self-signs by default", () => {
    const pipeline = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
    const sign = fs.readFileSync(path.resolve(__dirname, "../../scripts/sign-windows.ps1"), "utf8");
    expect(
      fs.readFileSync(path.resolve(__dirname, "../../scripts/build-windows.cmd"), "utf8"),
    ).toContain("build-pipeline.cjs");
    expect(pipeline).toContain("CSC_LINK");
    expect(pipeline).toContain("sign-windows.ps1");
    expect(pipeline).toContain("unsigned build");
    expect(pipeline).not.toContain("AllowSelfSigned");
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
    expect(src).toContain("--from stage-toolchain");
    expect(src).toContain("TEST_VERSION: ${{ steps.testversion.outputs.version }}");
    expect(src).toContain('--version "$env:TEST_VERSION"');
    expect(
      fs.readFileSync(path.resolve(__dirname, "../../scripts/build-pipeline.cjs"), "utf8"),
    ).toContain('["stamp", "--version", options.version]');
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
    const pipeline = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
    expect(src).toContain("--channel test");
    expect(pipeline).toContain("-c.appId=dev.friday.desk.test");
    expect(pipeline).toContain("-c.productName=FRIDAY Test");
  });

  it("only ever deletes TEST prereleases, never an official release", () => {
    expect(src).toContain("select(.isPrerelease)");
    expect(src.split("gh release delete").length - 1).toBe(1);
  });

  it("stamps the test channel and uploads the packaged EXE artifacts", () => {
    const pipeline = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
    expect(pipeline).toContain("build-channel.json");
    expect(pipeline).toContain('channel: "test"');
    expect(src).toContain("friday-test-build-");
    expect(src).not.toContain("actions/upload-artifact");
    expect(src).toContain("FRIDAY-Test-");
    expect(doc.on.workflow_dispatch.inputs.package.default).toContain("portable only");
    expect(pipeline).toContain('"portable"');
    expect(pipeline).toContain('"all"');
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
    const recipe = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
    const cmd = fs.readFileSync(path.resolve(__dirname, "../../scripts/build-windows.cmd"), "utf8");
    expect(cmd).toContain("build-pipeline.cjs");
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
      expect(recipe, name).toContain(name);
    }
    expect(live).toContain("build-pipeline.cjs");
    expect(recipe).toContain("readiness-test.cjs --pack");
  });
});

describe("official release", () => {
  const src = read("release.yml");
  const doc = load("release.yml");

  it("is one manual workflow, serialized, and main only", () => {
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    expect(doc.on.push).toBeUndefined();
    expect(doc.on.pull_request).toBeUndefined();
    expect(doc.on.schedule).toBeUndefined();
    expect(doc.on.workflow_call).toBeUndefined();
    expect(doc.concurrency.group).toBe("friday-release");
    expect(doc.concurrency["cancel-in-progress"]).toBe(false);
    expect(doc.jobs.prepare.concurrency).toBeUndefined();
    expect(doc.jobs.publish.concurrency).toBeUndefined();
    expect(src).toContain("Official releases run from main only");
    expect(src).toContain("FRIDAY Release is manual only (workflow_dispatch).");
    expect(src).not.toMatch(/case[ \t]+\[/);
    expect(src).not.toContain("allowed=false");
    const guards = bashSteps("release.yml").filter((step) =>
      step.script.includes("FRIDAY Release is manual only (workflow_dispatch)."),
    );
    expect(guards.map((step) => step.job).sort()).toEqual(["plan", "prepare", "publish"]);
    for (const step of guards) {
      if (step.job === "plan") continue;
      expect(step.script, step.job).toContain('[ "$EVENT_NAME" = "workflow_dispatch" ]');
      expect(step.script, step.job).toContain('case "$WORKFLOW_REF" in');
    }
    expect(src).not.toContain("official-publish.yml");
    expect(src).not.toContain("uses: ./.github/workflows/release.yml");
    expect(src).not.toContain("github.event_name == 'workflow_call'");
    expect(src).not.toContain('[ "$event" = "workflow_call" ]');
    expect(src).toContain("github.workflow_ref");
    expect(src.match(/\.github\/workflows\/release\.yml@/g)).toHaveLength(2);
    expect(src).toContain("ref: main");
    expect(doc.name).toBe("FRIDAY Release");
  });

  it("is stable-only; TEST prereleases belong exclusively to test-build.yml", () => {
    expect(doc.on.workflow_dispatch.inputs.prerelease).toBeUndefined();
    expect(src).not.toContain("--prerelease");
    expect(src).toContain("isPrerelease");
  });

  it("publish runs the same real CMD build scripts as scripts/build-windows.cmd", () => {
    const recipe = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
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
      expect(recipe, name).toContain(name);
    }
    expect(live).toContain("build-pipeline.cjs");
    expect(recipe).toContain("readiness-test.cjs --pack");
    expect(
      fs.readFileSync(path.resolve(__dirname, "../../scripts/build-windows.cmd"), "utf8"),
    ).toContain("build-pipeline.cjs");
  });

  it("keeps plan and confirm on Ubuntu and the pack on the shared pipeline", () => {
    for (const name of [
      "plan",
      "pin",
      "evidence",
      "confirm-checks",
      "verify-main",
      "confirm",
      "summary",
    ]) {
      expect(doc.jobs[name]["runs-on"], name).toBe("ubuntu-latest");
    }
    expect(doc.jobs.prepare["runs-on"]).toBe("windows-latest");
    expect(doc.jobs.publish["runs-on"]).toBe("windows-latest");
    const publish = src.slice(src.indexOf("\n  publish:\n"));
    expect(publish).toContain("build-pipeline.cjs");
    expect(publish).not.toContain("setup-python.cjs");
  });

  it("uses optional secret-backed Authenticode signing before checksums", () => {
    expect(src).toContain("WINDOWS_SIGNING_CERTIFICATE_BASE64");
    expect(src).toContain("WINDOWS_SIGNING_CERTIFICATE_PASSWORD");
    const pipeline = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
    expect(pipeline.indexOf("sign-windows.ps1")).toBeLessThan(
      pipeline.indexOf("scripts/release-manifest.cjs"),
    );
    expect(at("WINDOWS_SIGNING_CERTIFICATE_BASE64")).toBeLessThan(
      at("build-pipeline.cjs --channel production --caller release --from stage-toolchain"),
    );
  });

  it("owns the whole SemVer/build/verify/tag/release pipeline exactly once", () => {
    for (const cmd of [
      "scripts/release-engine.cjs decide",
      "scripts/release-engine.cjs apply",
      "build-pipeline.cjs --channel production --caller release --from stage-toolchain",
      "bash scripts/ci-publish-release.sh",
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

  it("keeps plan, prepare, validate, merge, publish and confirm in one workflow", () => {
    expect(Object.keys(doc.jobs)).toEqual([
      "plan",
      "prepare",
      "pin",
      "evidence",
      "validate",
      "confirm-checks",
      "merge",
      "verify-main",
      "publish",
      "confirm",
      "summary",
    ]);
    expect(doc.on.workflow_dispatch.inputs.stage.options).toEqual(["all", "prepare", "publish"]);
    expect(doc.on.workflow_dispatch.inputs.stage.default).toBe("all");
    expect(String(doc.jobs.prepare.if)).toContain("inputs.stage == 'prepare'");
    expect(String(doc.jobs.publish.if)).toContain("inputs.stage == 'publish'");
    expect(String(doc.jobs.plan.if)).toContain("inputs.stage != 'publish'");
    expect(doc.jobs.validate.uses).toBe("./.github/workflows/pr-validation.yml");
    expect(doc.jobs.merge.uses).toBe("./.github/workflows/safe-merge.yml");
    expect(doc.jobs.validate.with.caller).toBe("friday-release");
    expect(doc.jobs.merge.with.caller).toBe("friday-release");
  });

  it("never pushes the version commit to protected main", () => {
    expect(steps).not.toMatch(/git push origin HEAD:\$\{\{ github\.ref_name \}\}/);
    expect(steps).not.toMatch(/git push[^\n]*\bmain\b/);
    expect(steps).toContain('bash scripts/ci-git.sh push origin "HEAD:$branch"');
    expect(steps).not.toMatch(/push[^\n]*--force/);
    expect(steps).toContain("gh pr create --base main");
    expect(steps).toContain("not permitted to create or approve pull requests");
    expect(steps).toContain("Allow GitHub Actions to create and approve pull requests");
    expect(steps).toContain("compare/main...$branch?expand=1");
    expect(doc.permissions["pull-requests"]).toBe("read");
    expect(doc.jobs.prepare.permissions["pull-requests"]).toBe("write");
    expect(doc.jobs.publish.permissions["pull-requests"]).toBe("read");
  });

  it("validates a clean main before anything is versioned or built", () => {
    expect(steps).toContain("Validate clean main");
    expect(steps).toContain("git status --porcelain");
    expect(at("Validate clean main")).toBeLessThan(at("scripts/release-engine.cjs decide"));
    expect(at("Validate clean main")).toBeLessThan(
      at("build-pipeline.cjs --channel production --caller release --from stage-toolchain"),
    );
  });

  it("prepares version, changelog and notes on a release branch only", () => {
    expect(at("scripts/release-engine.cjs decide")).toBeLessThan(
      at("scripts/release-engine.cjs apply"),
    );
    expect(at("scripts/release-engine.cjs apply")).toBeLessThan(
      at("Open the release Pull Request"),
    );
    expect(at("npm test")).toBeLessThan(at("Open the release Pull Request"));
    expect(at("Open the release Pull Request")).toBeLessThan(
      at("build-pipeline.cjs --channel production --caller release --from stage-toolchain"),
    );
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
      at("build-pipeline.cjs --channel production --caller release --from stage-toolchain"),
    );
  });

  it("builds and verifies before the tag and release", () => {
    expect(
      at("build-pipeline.cjs --channel production --caller release --from stage-toolchain"),
    ).toBeLessThan(at("bash scripts/ci-publish-release.sh"));
    expect(at("bash scripts/ci-publish-release.sh")).toBeLessThan(
      at("Confirm the release and its assets"),
    );
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
    expect(steps).toContain('bash scripts/ci-delete-branch.sh "$branch"');
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
    const pipeline = fs.readFileSync(
      path.resolve(__dirname, "../../scripts/build-pipeline.cjs"),
      "utf8",
    );
    expect(src).toContain("--channel production");
    expect(pipeline).toContain('path.join(root, "resources", "build-channel.json")');
    expect(pipeline).toContain("removeTree(file)");
    expect(pipeline).toContain("maxRetries: 5");
    expect(pipeline).toContain("force: true");
  });

  it("re-restores reviewed notes before packaging and guards them before GitHub publish", () => {
    expect(src).toContain("Restore reviewed release notes before packaging");
    expect(src).toContain("release-engine.cjs guard-notes");
    expect(src).toContain("Refusing to describe the whole history as this release.");
    expect(src).not.toContain("measuring the full history");
    expect(src).not.toContain("git log --no-merges --pretty=%s > commits.txt");
    const publish = src.slice(src.indexOf("\n  publish:\n"));
    expect(publish.indexOf("Require a fresh green PR Validation")).toBeLessThan(
      publish.indexOf("Restore reviewed release notes before packaging"),
    );
    expect(publish.indexOf("Restore reviewed release notes before packaging")).toBeLessThan(
      publish.indexOf("Build with the shared pipeline"),
    );
    expect(at("Guard canonical What's New before publishing")).toBeLessThan(
      at("bash scripts/ci-publish-release.sh"),
    );
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
    // The delete itself lives in one script that every cleanup path shares.
    expect(src).toContain('bash scripts/ci-delete-branch.sh "$BRANCH"');
    const script = fs.readFileSync(path.resolve(DIR, "../../scripts/ci-delete-branch.sh"), "utf8");
    expect(script).toContain("git/refs/heads/$encoded");
    // main and long-lived branches are never deleted; a merged release/vX.Y.Z
    // branch is temporary and is cleaned up like any other work branch.
    expect(script).toContain("main|master|develop|development|release|recovery/*)");
    expect(script).not.toContain("release/*)");
  });

  it("after the merged head, sweeps every other branch whose work is already in main, and nothing else", () => {
    const doc = load("branch-cleanup.yml");
    const src = read("branch-cleanup.yml");
    // The sweep reads pull requests, so the token needs that permission; it still cannot write them.
    expect(doc.permissions["pull-requests"]).toBe("read");
    expect(doc.permissions.contents).toBe("write");
    // Two merges close together never race each other, and a waiting run is not cancelled mid-delete.
    expect(doc.concurrency.group).toBe("friday-branch-cleanup");
    expect(doc.concurrency["cancel-in-progress"]).toBe(false);
    // Full history, because "already in main" is an ancestry question.
    expect(src).toMatch(/uses: \$\/\.github\/actions\/checkout\n\s+with:\n\s+fetch-depth: 0/);
    const at = src.indexOf("Delete every other branch whose work is already in main");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at)).toContain("bash scripts/ci-sweep-branches.sh");
    // The merged head is deleted first, by its own step, so a failing sweep never leaves it behind.
    expect(src.indexOf('bash scripts/ci-delete-branch.sh "$BRANCH"')).toBeLessThan(at);
  });

  it("the sweep script reads branches only, skips with a warning when it cannot read, and never forces anything", () => {
    const sweep = fs.readFileSync(path.resolve(DIR, "../../scripts/ci-sweep-branches.sh"), "utf8");
    expect(sweep).toContain("bash scripts/ci-branch-state.sh");
    expect(sweep).toContain("--open-prs open-prs.json --merged-prs merged-prs.json");
    expect(sweep).toContain('bash scripts/ci-delete-branch.sh "$branch"');
    // Branches only: no release and no run is ever in the plan, and the protected names are skipped again here.
    expect(sweep).toContain('echo "[]" > releases.json');
    expect(sweep).toContain('echo "[]" > runs.json');
    expect(sweep).toContain("main|master|develop|development|release|recovery/*) continue");
    expect(sweep).not.toMatch(/gh (release|run) delete/);
    expect(sweep).not.toMatch(/git\s+push|--force|git branch -D/);
    // The merge already succeeded: an unreadable GitHub or an undeletable branch is a warning, never a failure.
    expect(sweep.match(/::warning::/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sweep).toMatch(/exit 0\s*$/);
  });

  it("Safe Merge sweeps too, because a merge made with the workflow token does not start Branch Cleanup", () => {
    const doc = load("safe-merge.yml");
    const steps = doc.jobs.merge.steps;
    const names = steps.map((step: { name?: string }) => step.name);
    const mergeAt = names.indexOf("Merge the eligible pull requests");
    const sweepAt = names.indexOf("Delete every other branch whose work is already in main");
    expect(mergeAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(mergeAt);
    expect(steps[sweepAt].if).toContain("inputs.delete_branch == 'true'");
    expect(steps[sweepAt].run).toContain("bash scripts/ci-sweep-branches.sh");
    // The sweep needs the whole history, which this workflow already fetches, and the pull request read it has.
    const fetch = steps.find((step: { name?: string }) => step.name === "Fetch source");
    expect(fetch.with["fetch-depth"]).toBe(0);
    expect(doc.permissions["pull-requests"]).toBe("write");
  });

  it("collects branch facts in one script that every cleanup path shares, and deletes nothing itself", () => {
    const script = fs.readFileSync(path.resolve(DIR, "../../scripts/ci-branch-state.sh"), "utf8");
    expect(script).toContain('git merge-base --is-ancestor "$sha" origin/main');
    expect(script).toContain("gh pr list --state open");
    expect(script).toContain("gh pr list --state merged --base main");
    expect(script).toContain("headRefOid,isCrossRepository");
    expect(script).not.toMatch(/\bDELETE\b|--delete|git branch -[dD]|git push/);
    expect(read("maintenance.yml")).toContain("bash scripts/ci-branch-state.sh");
    expect(read("maintenance.yml")).toContain("--merged-prs merged-prs.json");
  });

  it("Repository Control deletes through the verified script, merges only the checked commit, and sweeps like the others", () => {
    const doc = load("repository-control.yml");
    const src = read("repository-control.yml");
    // The merge is of the commit whose checks were read; a head that moved in between is refused by GitHub.
    expect(src).toContain(
      'gh pr merge "$PR_NUMBER" --repo "$REPO" --merge --match-head-commit "$head_sha"',
    );
    // The delete after a merge is the shared script (retry and a read that proves it), never a bare API call whose
    // failure is printed as "already removed".
    expect(src).toContain('bash scripts/ci-delete-branch.sh "$head"');
    expect(src).not.toContain("branch $head was already removed");
    expect(src).not.toMatch(
      /gh api -X DELETE "repos\/\$REPO\/git\/refs\/heads\/\$head" >\/dev\/null/,
    );
    const names = doc.jobs.control.steps.map((step: { name?: string }) => step.name);
    const sweep =
      doc.jobs.control.steps[
        names.indexOf("Delete every other branch whose work is already in main")
      ];
    expect(sweep.if).toContain("inputs.action == 'merge-pr'");
    expect(sweep.if).toContain("inputs.delete_branch_after_merge");
    expect(sweep.run).toContain("bash scripts/ci-sweep-branches.sh");
    // The Node toolchain it needs is installed for that action too.
    const node =
      doc.jobs.control.steps[names.indexOf("Node toolchain (from package.json engines)")];
    expect(node.if).toContain("inputs.action == 'merge-pr' && inputs.delete_branch_after_merge");
  });

  it("Security Scan retries the scanner image pull and pins its audit tool like PR Validation", () => {
    const security = read("security.yml");
    const pr = read("pr-validation.yml");
    expect(security).toContain("Pull the secret scanner image");
    expect(security).toContain("for attempt in 1 2 3 4; do");
    expect(security.indexOf("Pull the secret scanner image")).toBeLessThan(
      security.indexOf("Scan for committed secrets"),
    );
    // One pinned pip-audit everywhere, so a new release cannot turn a weekly run red.
    for (const file of [security, read("health-weekly.yml"), pr]) {
      expect(file).toContain('"pip-audit==2.10.1"');
      expect(file).not.toMatch(/pip install --quiet pip-audit\s/);
    }
  });

  it("the write token and the signing certificate reach only the steps that use them", () => {
    // Test Build builds any ref (a branch, a pull request, a Dependabot update) and Release builds main; both hold a
    // token that can write. It belongs to the steps that call gh (and validation-freshness, which does), and the
    // certificate to the one step that signs, not to `npm ci`, the tests or the rest of the build.
    const cases: [string, string[]][] = [
      ["test-build.yml", ["test-build"]],
      ["release.yml", ["prepare", "publish"]],
    ];
    for (const [file, jobs] of cases) {
      const doc = load(file);
      for (const name of jobs) {
        const job = doc.jobs[name];
        const where = `${file} ${name}`;
        expect(job.env?.GH_TOKEN, where).toBeUndefined();
        expect(job.env?.CERTIFICATE_BASE64, where).toBeUndefined();
        for (const step of job.steps) {
          if (step.uses) continue;
          const run = String(step.run || "");
          const needsToken =
            /\bgh\s/.test(run) || run.includes("validation-freshness") || run.includes("GH_TOKEN");
          const label = `${where}: ${step.name}`;
          if (needsToken) expect(step.env?.GH_TOKEN, label).toBe("${{ github.token }}");
          else expect(step.env?.GH_TOKEN, label).toBeUndefined();
          if (run.includes("CERTIFICATE_BASE64")) {
            expect(step.name, label).toBe("Build with the shared pipeline");
            expect(step.env.CERTIFICATE_BASE64, label).toBe(
              "${{ secrets.WINDOWS_SIGNING_CERTIFICATE_BASE64 }}",
            );
          }
        }
        // The steps that run the project's own code never see the token.
        for (const step of job.steps) {
          const run = String(step.run || "");
          if (/npm (ci|test|run)|build-pipeline\.cjs/.test(run) && !/\bgh\s/.test(run)) {
            expect(step.env?.GH_TOKEN, `${where}: ${step.name}`).toBeUndefined();
          }
        }
      }
    }
  });

  it("every commit a workflow creates is made as the owner, never under an automation name", () => {
    for (const file of fs.readdirSync(DIR)) {
      const src = read(file);
      for (const line of src.split("\n").filter((l) => /git config user\.(name|email)/.test(l))) {
        expect(line, file).toMatch(/devendrarj25/);
      }
      expect(src, file).not.toMatch(/friday-ci|FRIDAY Main Safety|FRIDAY Repository Control"/);
    }
    // The owner's no-reply address, the one the repository history already carries (never a plain address).
    for (const file of [
      "pr-validation.yml",
      "release.yml",
      "repository-control.yml",
      "main-safety-recovery.yml",
    ]) {
      expect(read(file), file).toContain("311363093+devendrarj25@users.noreply.github.com");
    }
  });

  it("a Test Build that publishes is never cancelled mid-upload and runs one at a time", () => {
    const doc = load("test-build.yml");
    const src = read("test-build.yml");
    // Publishing builds share one group (the next TEST number is read from the existing releases) and are
    // not cancellable; a try-out build is still replaced by a newer one for the same ref.
    expect(doc.concurrency.group).toContain("inputs.publish && 'friday-test-publish'");
    expect(doc.concurrency.group).toContain("format('friday-test-build-{0}'");
    expect(doc.concurrency["cancel-in-progress"]).toBe("${{ !inputs.publish }}");
    expect(src).toContain("friday-test-build-");
  });

  it("deletes a merged branch through REST with retries and proves it is gone", () => {
    const script = fs.readFileSync(path.resolve(DIR, "../../scripts/ci-delete-branch.sh"), "utf8");
    expect(script).toContain("gh api -X DELETE");
    expect(script).toContain("for attempt in 1 2 3 4 5");
    // Success is a read that no longer finds the ref, never the delete's exit code.
    expect(script).toContain("if ! exists; then");
    expect(script).toMatch(/::error::branch .* still on the remote/);
    expect(script).toMatch(/exit 1\s*$/);
    // A failed `git push --delete` once printed "already removed" for a branch
    // that was still there. No workflow may delete a branch that way again.
    for (const file of fs.readdirSync(DIR)) {
      expect(read(file), file).not.toMatch(/git\s+push\s+origin\s+--delete/);
    }
    for (const file of ["branch-cleanup.yml", "safe-merge.yml", "maintenance.yml"]) {
      expect(read(file), file).toContain("scripts/ci-delete-branch.sh");
    }
  });

  it("lets only the owner, github-actions[bot] and dependabot[bot] start any workflow", () => {
    for (const file of fs.readdirSync(DIR)) {
      const doc = load(file);
      for (const [name, job] of Object.entries<any>(doc.jobs)) {
        // A job that needs another is held behind it; a called workflow is
        // guarded by its own jobs. Every other job opens with the actor check.
        if (job.needs || job.uses) continue;
        const first = job.steps[0];
        const where = `${file} ${name}`;
        expect(first.name, where).toBe("Only the owner and the two GitHub bots may run this");
        expect(first.env.OWNER, where).toBe("${{ github.repository_owner }}");
        expect(first.env.ACTOR, where).toBe("${{ github.actor }}");
        expect(first.env.TRIGGERING_ACTOR, where).toBe("${{ github.triggering_actor }}");
        expect(first.run, where).toContain('"$OWNER"|"github-actions[bot]"|"dependabot[bot]") ;;');
        expect(first.run, where).toContain("exit 1");
      }
    }
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
        expect(src).toContain('[ "$CONFIRM" = "MERGE" ]');
        expect(src).toContain("CONFIRM: ${{ inputs.confirm }}");
        expect(src).not.toContain("inputs.confirm }}' = 'MERGE'");
        expect(src).toContain("merge-engine.cjs evaluate");
        expect(src).toContain("--match-head-commit");
        expect(src).toContain('gh pr merge "$pr" --merge');
        expect(src).toContain("Safe Merge is manual only, or one call from FRIDAY Release.");
        expect(src).toContain("Safe Merge is manual only (workflow_dispatch).");
        expect(src).not.toContain("github.event_name == 'workflow_call'");
        expect(src).not.toContain('[ "$event" = "workflow_call" ]');
        expect(src).toContain("github.workflow_ref");
        expect(src).toContain(".github/workflows/release.yml@");
        expect(src).toContain(".github/workflows/safe-merge.yml@");
        expect(src).not.toMatch(
          /--squash|--rebase|--admin|enable-?auto-?merge|automerge|auto_merge/i,
        );
        continue;
      }
      if (file === "release.yml") {
        expect(Object.keys(load(file).on)).toEqual(["workflow_dispatch"]);
        expect(src).not.toMatch(/gh pr merge/);
        expect(src).not.toMatch(/gh workflow run/);
        expect(src).not.toContain("ci-workflow-run");
        expect(src).not.toMatch(/enable-?auto-?merge|automerge|auto_merge/i);
        expect(src).toContain("gh pr create --base main");
        const publish = load(file);
        expect(publish.jobs.prepare.permissions["pull-requests"]).toBe("write");
        expect(publish.jobs.publish.permissions["pull-requests"]).toBe("read");
        expect(publish.jobs.merge.permissions["pull-requests"]).toBe("write");
        for (const name of [
          "plan",
          "pin",
          "evidence",
          "confirm-checks",
          "verify-main",
          "confirm",
          "summary",
        ]) {
          expect(publish.jobs[name].permissions?.["pull-requests"], name).toBe("read");
          expect(publish.jobs[name].permissions?.contents, name).toBe("read");
        }
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
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
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
    expect(template).toContain("FRIDAY Test Build");
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
    const src = read2("release.yml");
    expect(src).toContain("steps.plan.outputs.step == 'error'");
    expect(src).toContain("Stop on an unsafe or ambiguous release state");
    expect(src).toContain("options: [auto, patch, minor, major, extreme, revision]");
  });

  it("makes the Safe Merge confirmation a required dispatch input", () => {
    const src = read2("safe-merge.yml");
    const doc = load("safe-merge.yml");
    expect(src).toMatch(/confirm:[\s\S]{0,160}required: true/);
    expect(src).toContain('= "MERGE" ]');
    // Safe Merge 37200400230: startup_failure, zero jobs. A required input
    // must not also declare a default, and delete_branch must be the string
    // FRIDAY Release already sends (`true`), not a boolean.
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
    const push = src.indexOf('bash scripts/ci-git.sh push origin "HEAD:refs/heads/$branch"');
    expect(guard).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(guard);
    expect(src).toContain('if [ -n "$PINNED_SHA" ]; then');
    expect(src).toContain("PINNED_SHA: ${{ inputs.sha }}");
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
    for (const forbidden of ["FRIDAY Release", "FRIDAY Test Build", "Safe Merge"]) {
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
    expect(src).toContain("healed: ${{ steps.heal.outputs.sha }}");
    expect(src).toContain("HEALED_SHA: ${{ needs.static.outputs.healed }}");
    expect(src).toContain('for one in "$sha" "$HEALED_SHA"');
    expect(src.indexOf('echo "sha=$healed" >> "$GITHUB_OUTPUT"')).toBeGreaterThan(
      src.indexOf('bash scripts/ci-git.sh push origin "HEAD:refs/heads/$branch"'),
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
    expect(src).toContain("gitleaks:v8.30.1");
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
    const staticSteps = doc.jobs.static.steps as Array<{ name?: string; run?: string }>;
    const kernelSteps = doc.jobs.kernel.steps as Array<{ name?: string; run?: string }>;
    const staticInstalls = staticSteps.filter((step) =>
      String(step.run || "").includes("kernel/requirements-dev.txt"),
    );
    const kernelInstalls = kernelSteps.filter((step) =>
      String(step.run || "").includes("kernel/requirements-dev.txt"),
    );
    expect(staticInstalls).toHaveLength(1);
    expect(kernelInstalls).toHaveLength(1);
    const lintAt = staticSteps.findIndex((step) => step.name === "Lint");
    const kernelAt = kernelSteps.findIndex((step) => step.name === "Kernel tests");
    const staticInstallAt = staticSteps.findIndex(
      (step) => step.name === "Install kernel dev requirements",
    );
    const kernelInstallAt = kernelSteps.findIndex(
      (step) => step.name === "Install kernel dev requirements",
    );
    expect(staticInstallAt).toBeGreaterThan(-1);
    expect(kernelInstallAt).toBeGreaterThan(-1);
    expect(lintAt).toBeGreaterThan(staticInstallAt);
    expect(kernelAt).toBeGreaterThan(kernelInstallAt);
    expect(String(staticSteps[lintAt]?.run)).not.toContain("pip install");
    expect(
      doc.jobs.validate.steps.some((step: { run?: string }) =>
        String(step.run || "").includes("context='PR Validation'"),
      ),
    ).toBe(true);
    expect(src).not.toContain("npm audit fix");
  });

  it("FRIDAY Test Build and FRIDAY Release reuse a fresh green PR Validation on the same commit", () => {
    const publish = read("release.yml");
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
    expect(testBuild).toContain("build-pipeline.cjs");
    expect(
      fs.readFileSync(path.resolve(__dirname, "../../scripts/build-pipeline.cjs"), "utf8"),
    ).toContain("electron-pack.cjs");

    const release = read("release.yml");
    const prepare = release.slice(release.indexOf("\n  prepare:\n"), release.indexOf("\n  pin:\n"));
    const publishJob = release.slice(
      release.indexOf("\n  publish:\n"),
      release.indexOf("\n  confirm:\n"),
    );
    expect(prepare).toContain("previous result is");
    expect(prepare).toContain("npm test");
    expect(prepare).not.toContain("validation-freshness.cjs");
    expect(prepare.indexOf("npm run typecheck")).toBeLessThan(prepare.indexOf("npm test"));
    expect(publishJob).not.toContain("npm test");
    expect(publishJob).toContain("merged tree is not the validated tree");
    expect(publishJob).toContain("validation-freshness.cjs");
    expect(publishJob).toContain("--require-reuse");
    expect(publishJob).not.toContain("skip_linux");
    expect(publishJob.indexOf("npm run typecheck")).toBeLessThan(
      publishJob.indexOf("Require a fresh green PR Validation"),
    );
    expect(publishJob.indexOf("Require a fresh green PR Validation")).toBeLessThan(
      publishJob.indexOf("Build with the shared pipeline"),
    );
    expect(read("pr-validation.yml")).toContain("node scripts/run-actionlint.cjs");
    expect(read("pr-validation.yml")).toContain("gitleaks:v8.30.1@sha256:");
    expect(read("security.yml")).toContain("gitleaks:v8.30.1@sha256:");
    expect(release).toContain("validation-freshness.cjs");
  });
});

describe("PR Validation keeps the write token away from the pull request's code", () => {
  const src = read("pr-validation.yml");
  const job = (name: string) => {
    const at = src.indexOf(`\n  ${name}:\n`);
    const next = src.slice(at + 1).search(/\n {2}[a-z-]+:\n/);
    return src.slice(at, next < 0 ? undefined : at + 1 + next);
  };

  it("names GH_TOKEN only on the steps that call gh or push, never for the whole job, in static and docs-only", () => {
    for (const name of ["static", "docs-only"]) {
      const text = job(name);
      expect(text, name).not.toMatch(/\n {4}env:\n {6}GH_TOKEN:/);
      expect(text, name).toContain("          GH_TOKEN: ${{ github.token }}");
    }
  });

  it("removes the checkout credential before npm ci runs the pull request's dependencies", () => {
    for (const name of ["static", "docs-only"]) {
      const text = job(name);
      const drop = text.indexOf(
        "name: Remove the checkout credential before the pull request's code runs",
      );
      const install = text.search(/\n\s+run: npm ci\n/);
      const fetch = text.indexOf('git fetch --no-tags origin "$BASE_REF"');
      expect(drop, name).toBeGreaterThan(fetch);
      expect(install, name).toBeGreaterThan(drop);
      expect(text, name).toContain('git config --local --unset-all "$key"');
    }
  });
});

/**
 * The build record (friday-bundle.json) and the weight packs in the two publishing workflows. The behaviour of the
 * pack step itself is run against stand-ins in ci-release-packs.test.ts; these pins hold the shape of the YAML.
 */
describe("build record and weight packs in the publishing workflows", () => {
  const release = read("release.yml");
  const testBuild = read("test-build.yml");
  const releaseDoc = load("release.yml");
  const stepText = (src: string, name: string) => {
    const start = src.indexOf(`      - name: ${name}\n`);
    expect(start, name).toBeGreaterThan(-1);
    const next = src.indexOf("\n      - name: ", start + 1);
    return src.slice(start, next < 0 ? undefined : next);
  };
  const code = (text: string) =>
    text
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

  it("keeps the last 3 OFFICIAL releases by their v tag, so a weight pack release is never deleted", () => {
    const cleanup = stepText(release, "Keep only the last 3 releases");
    expect(cleanup).toContain('select(.tagName|startswith("v"))');
    expect(cleanup).toContain("select(.isPrerelease|not)");
    expect(cleanup).toContain(".[3:]");
    expect(release.split("gh release delete").length - 1).toBe(1);
  });

  it("keeps the last 3 TEST prereleases by their test tag, never an official release or a weight pack", () => {
    const cleanup = stepText(testBuild, "Keep only the last 3 TEST prereleases");
    expect(cleanup).toContain("select(.isPrerelease)");
    expect(cleanup).toContain('select(.tagName|test("^v[0-9][0-9.]*-test\\\\.[0-9]+$"))');
    expect(testBuild.split("gh release delete").length - 1).toBe(1);
  });

  it("uploads friday-bundle.json in the release, in a rebuild too, and refuses a release without it", () => {
    const create = stepText(release, "Create GitHub Release");
    expect(create).toContain('"release/friday-bundle.json" \\');
    expect(create.indexOf("friday-bundle.json")).toBeLessThan(create.indexOf('"CHANGELOG.md"'));
    expect(create).toMatch(/\[ ! -f "release\/friday-bundle\.json" \][\s\S]{0,200}exit 1/);
    // the rebuild upload and the new-release script both take the same asset list
    const rebuild = create.slice(create.indexOf("gh release upload"));
    expect(rebuild).toContain('"${assets[@]}"');
    expect(create).toContain('"${assets[@]}"');
  });

  it("confirms the bundle asset, that every pack tag it names is a release, and that no asset passes 2 GiB", () => {
    const confirm = stepText(release, "Confirm the release and its assets");
    expect(confirm).toContain('grep -q "friday-bundle.json"');
    expect(confirm).toContain(
      'require("./electron/build-bundle.cjs").read("release/friday-bundle.json")',
    );
    expect(confirm).toContain('gh release view "$ptag"');
    expect(confirm).toContain("2147483648");
    expect(confirm).toContain(".size > 2147483648");
  });

  it("publishes the missing weight packs after the build and before the app release, one model at a time", () => {
    const publish = releaseDoc.jobs.publish.steps.map((step: { name: string }) => step.name);
    const at = publish.indexOf("Publish missing weight packs");
    expect(at).toBeGreaterThan(publish.indexOf("Build with the shared pipeline"));
    expect(at).toBeLessThan(publish.indexOf("Create GitHub Release"));
    const step = releaseDoc.jobs.publish.steps[at];
    const run = code(String(step.run));
    expect(step.shell).toBe("bash");
    expect(run).toContain("set -euo pipefail");
    expect(run).toContain('--pack "$pack" --only "$model" --out "$out" --part-bytes "$part_bytes"');
    expect(run).toContain('work="${RUNNER_TEMP:?RUNNER_TEMP required}/friday-packs"');
    expect(run).toContain('rm -rf "$out"');
    expect(run).toContain("df -Pk");
    expect(run).toContain("skipped - every weight pack release already exists");
    // draft first, checked before it is public, and never the latest release
    expect(run).toContain("-F draft=true");
    expect(run).toContain("-f make_latest=false");
    expect(run).toContain("is not the built file");
    expect(run).toContain("2147483648");
    expect(run).toContain("1900000000");
    // an existing tag is never touched
    expect(run).not.toContain("gh release delete");
    expect(run).not.toContain("gh release create");
    expect(run).not.toContain("--clobber");
    expect(run).not.toMatch(/gh release (edit|upload) "\$ptag"/);
    expect(run).not.toContain("--prerelease");
    // the token stays in the step env, the commit comes from the plan, nothing is echoed
    expect(step.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(step.env.RELEASE_SHA).toBe("${{ steps.plan.outputs.sha }}");
    expect(run).not.toContain('echo "$GH_TOKEN"');
  });

  it("gives the publish job room for the packs and the step its own limit, under the 6 hour job maximum", () => {
    const step = releaseDoc.jobs.publish.steps.find(
      (row: { name: string }) => row.name === "Publish missing weight packs",
    );
    expect(step["timeout-minutes"]).toBeLessThan(releaseDoc.jobs.publish["timeout-minutes"]);
    expect(releaseDoc.jobs.publish["timeout-minutes"]).toBeGreaterThanOrEqual(300);
    expect(releaseDoc.jobs.publish["timeout-minutes"]).toBeLessThanOrEqual(360);
  });

  it("publishes the build record with a TEST prerelease and builds no weight pack there", () => {
    const publish = stepText(testBuild, "Publish the TEST prerelease (Test update channel)");
    expect(publish).toContain(
      'assets=("$setup" "$portable" release/friday-update.json release/friday-bundle.json release/SHA256SUMS.txt)',
    );
    expect(publish).toMatch(/\[ -f release\/friday-bundle\.json \] \|\| \{[\s\S]{0,200}exit 1/);
    expect(publish).toContain(
      '"FRIDAY-Portable-$version.exe" friday-update.json friday-bundle.json; do',
    );
    expect(testBuild).not.toContain("Publish missing weight packs");
    expect(testBuild).not.toContain("build-friday-models");
  });
});
