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

  it("does not call actions outside this repository", () => {
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
    const action = fs.readFileSync(path.resolve(DIR, "../actions/checkout/action.yml"), "utf8");
    expect(action).toContain("x-access-token");
    expect(action).toContain("AUTHORIZATION: basic");
    expect(action).toContain('GIT_CONFIG_KEY_0="http.${SERVER}/.extraheader"');
    expect(action).toContain('GIT_CONFIG_KEY_1="credential.helper"');
    expect(action).toContain('git config --local "http.${SERVER}/.extraheader"');
    expect(action).toContain('git config --local credential.helper ""');
    expect(action).not.toContain("AUTHORIZATION: bearer");
    expect(action).toContain("refs/pull/[0-9]+/(merge|head)");
    expect(action).toContain("refs/tags/${branch}");
    expect(action).toContain('git checkout --force -B "$branch" "origin/$branch"');
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
