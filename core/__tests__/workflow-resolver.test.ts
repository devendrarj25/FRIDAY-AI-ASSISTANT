/**
 * Every command a workflow or composite action runs must name a real script.
 * A fixture with a missing file must fail. Hosted execution stays unverified.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { resolveRoot, resolveRun, resolveUse } = require_(
  path.resolve(__dirname, "../../scripts/workflow-resolve.cjs"),
);

const ROOT = path.resolve(__dirname, "../..");

describe("workflow command resolver", () => {
  it("resolves every run command, action, and script target", () => {
    const problems = resolveRoot(ROOT) as string[];
    expect(problems).toEqual([]);
  });

  it("fails when a run command names a file that is not in the tree", () => {
    const problems = resolveRun(ROOT, "node scripts/does-not-exist.cjs") as string[];
    expect(problems.some((line) => line.includes("does-not-exist.cjs"))).toBe(true);
  });

  it("fails when a run command names an npm script that is not in package.json", () => {
    const problems = resolveRun(ROOT, "npm run not-a-real-script") as string[];
    expect(problems.some((line) => line.includes("not-a-real-script"))).toBe(true);
  });

  it("accepts a local reusable workflow and rejects a missing one", () => {
    expect(resolveUse(ROOT, "./.github/workflows/release.yml")).toEqual([]);
    const missing = resolveUse(ROOT, "./.github/workflows/does-not-exist.yml") as string[];
    expect(missing.some((line) => line.includes("does-not-exist.yml"))).toBe(true);
    const foreign = resolveUse(ROOT, "actions/checkout@v4") as string[];
    expect(foreign.some((line) => line.includes("outside this repository"))).toBe(true);
  });
});
