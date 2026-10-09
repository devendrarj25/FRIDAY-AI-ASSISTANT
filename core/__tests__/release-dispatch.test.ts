/**
 * FRIDAY · release dispatch contract
 *
 * FRIDAY's in-app "Release / Build" panel is not a second release system: it
 * drives the one GitHub workflow through its two manual stages. These tests
 * lock the rules that make that safe:
 *   - every dispatch names its stage (prepare | publish),
 *   - publish is refused unless the release PR was actually merged into main,
 *   - a test EXE goes to test-build.yml and never to the release workflow.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("github-release.cjs", () => {
  const src = read("electron/github-release.cjs");

  it("dispatches the release workflow with an explicit stage", () => {
    expect(src).toContain('const stage = input.stage === "publish" ? "publish" : "prepare"');
    expect(src).toMatch(/inputs:\s*\{\s*\n\s*stage,/);
    expect(src).toContain('ref: "main"');
    expect(src).not.toMatch(/inputs:\s*\{[\s\S]*?prerelease:/);
  });

  it("refuses to publish an unmerged or already released version", () => {
    expect(src).toContain("notMerged: true");
    expect(src).toContain("alreadyReleased: true");
    expect(src).toMatch(/mode !== "rebuild" && \(!status\.pr \|\| !status\.pr\.merged\)/);
  });

  it("keeps the stale-source guard on prepare only", () => {
    expect(src).toContain("localChanges: true");
    expect(src).toContain("acknowledgeLocalChanges");
  });

  it("sends test builds to the test workflow, never to the release workflow", () => {
    expect(src).toContain('const TEST_WORKFLOW = "test-build.yml"');
    expect(src).toMatch(/dispatchTestBuild/);
    expect(src).toContain("workflows/${TEST_WORKFLOW}/dispatches");
  });

  it("ignores TEST prereleases when finding the current stable release", () => {
    expect(src).toContain("!r.prerelease");
    expect(src).toContain("config/friday-version.json?ref=main");
    expect(src).toContain("identityFromCanonical");
    expect(src).toContain("contents/package.json?ref=main");
    expect(src).toContain("engine.stableBaseline");
    expect(src).toContain("engine.releasePreview");
    expect(src).toContain("engine.stableConsumed");
    expect(src).not.toContain("engine.plan(");
    expect(src).toContain("compareBuilds");
    expect(src).toContain("(?:\\.\\d+)?");
    expect(src).toContain("release\\/v\\d+");
  });

  it("never merges, tags or releases from the desktop side", () => {
    for (const forbidden of ["/merge", "git tag", "releases/generate-notes"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});

describe("desktop wiring", () => {
  it("exposes the stage reads and test build over IPC and the preload bridge", () => {
    const main = read("electron/main.cjs");
    const preload = read("electron/preload.cjs");
    for (const channel of ["github:release-status", "github:dispatch-test-build"]) {
      expect(main, channel).toContain(channel);
      expect(preload, channel).toContain(channel);
    }
  });

  it("offers publish in the UI only when GitHub reports the publish stage", () => {
    const ui = read("src/components/friday/settings/ReleaseControls.tsx");
    expect(ui).toContain('status?.stage !== "publish"');
    expect(ui).toContain('startRelease("prepare"');
    expect(ui).toContain('startRelease("publish"');
    expect(ui).toContain("PATCH / FIX");
    expect(ui).toContain("EXTREME UPDATE");
  });

  it("dispatches the four-part public increment types including extreme", () => {
    const src = read("electron/github-release.cjs");
    expect(src).toContain('"revision"');
    expect(src).toContain('"extreme"');
    expect(src).toContain("patch");
    expect(src).toContain("minor");
    expect(src).toContain("major");
  });
});
