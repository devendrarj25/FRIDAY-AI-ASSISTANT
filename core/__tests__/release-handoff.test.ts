/**
 * FRIDAY · Prepare -> Publish version handoff
 *
 * The bug this locks: Prepare chose a new version, its release PR was still
 * open, and Publish silently read the stale package.json version and died with
 * "release v1.3.2 already exists". Publish must refuse with an actionable
 * message instead, while rebuild (same version, replaced assets) stays legal
 * and duplicate tag/release protection stays intact.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const engine = require(resolve(process.cwd(), "scripts/release-engine.cjs"));
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("publishHandoff", () => {
  it("refuses to publish while the prepared version is still an open PR", () => {
    const d = engine.publishHandoff({
      mode: "auto",
      current: "1.3.2",
      prepared: [{ version: "1.4.0", state: "open" }],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("error");
    expect(d.pending).toBe("1.4.0");
    expect(d.reason).toContain("1.4.0");
    expect(d.reason).toContain("still open");
  });

  it("selects the newest open release and classifies the older one as superseded", () => {
    const d = engine.publishHandoff({
      mode: "auto",
      current: "1.3.2",
      prepared: [
        { number: 33, version: "1.3.3", state: "open" },
        { number: 34, version: "1.3.4", state: "open" },
      ],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("error");
    expect(d.pending).toBe("1.3.4");
    expect(d.superseded).toEqual(["1.3.3"]);
    expect(d.reason).toContain("release/v1.3.4");
  });

  it("fails closed when duplicate open PRs declare the latest version", () => {
    const d = engine.publishHandoff({
      mode: "update",
      current: "1.3.2",
      prepared: [
        { number: 40, version: "1.3.4", state: "open" },
        { number: 41, version: "1.3.4", state: "open" },
      ],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("error");
    expect(d.reason).toContain("multiple open release Pull Requests");
    expect(d.reason).toContain("ambiguous");
  });

  it("publishes the prepared version once its PR is merged into main", () => {
    const d = engine.publishHandoff({
      mode: "auto",
      current: "1.4.0",
      prepared: [{ version: "1.4.0", state: "merged" }],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("update");
    expect(d.version).toBe("1.4.0");
    expect(d.tag).toBe("v1.4.0");
  });

  it("publishes merged v1.3.4 without being blocked by obsolete open v1.3.3", () => {
    const d = engine.publishHandoff({
      mode: "auto",
      current: "1.3.4",
      prepared: [
        { number: 33, version: "1.3.3", state: "open" },
        { number: 34, version: "1.3.4", state: "merged" },
      ],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("update");
    expect(d.version).toBe("1.3.4");
    expect(d.pending).toBeNull();
  });

  it("refuses a stale checkout when a newer release PR is already merged", () => {
    const d = engine.publishHandoff({
      mode: "auto",
      current: "1.3.2",
      prepared: [{ number: 34, version: "1.3.4", state: "merged" }],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("error");
    expect(d.pending).toBe("1.3.4");
    expect(d.reason).toContain("merged but main still declares");
  });

  it("ignores an obsolete open PR older than main", () => {
    const d = engine.publishHandoff({
      mode: "auto",
      current: "1.3.4",
      prepared: [{ number: 33, version: "1.3.3", state: "open" }],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("update");
    expect(d.pending).toBeNull();
  });

  it("refuses an open PR that conflicts with the version already on main", () => {
    const d = engine.publishHandoff({
      mode: "update",
      current: "1.3.4",
      prepared: [{ number: 34, version: "1.3.4", state: "open" }],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("error");
    expect(d.reason).toContain("still open rather than merged");
    expect(d.reason).toContain("FRIDAY Release");
    expect(d.reason).toContain("Safe Merge");
  });

  it("keeps rebuild on exactly the same version", () => {
    const d = engine.publishHandoff({
      mode: "rebuild",
      current: "1.3.2",
      prepared: [],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("rebuild");
    expect(d.version).toBe("1.3.2");
    expect(d.existing).toBe(true);
  });

  it("allows a deliberate rebuild even while a newer version is pending", () => {
    const d = engine.publishHandoff({
      mode: "rebuild",
      current: "1.3.2",
      prepared: [{ version: "1.4.0", state: "open" }],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("rebuild");
    expect(d.version).toBe("1.3.2");
  });

  it("never turns an existing release into a silent update", () => {
    const d = engine.publishHandoff({
      mode: "update",
      current: "1.3.2",
      prepared: [],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("error");
    expect(d.reason).toContain("already exists");
    expect(d.reason).toContain("rebuild");
  });

  it("publishes a never-released declared version as an update", () => {
    const d = engine.publishHandoff({
      mode: "auto",
      current: "1.4.0",
      prepared: [],
      released: ["v1.3.2"],
    });
    expect(d.action).toBe("update");
    expect(d.version).toBe("1.4.0");
  });

  it("refuses an invalid declared version instead of guessing", () => {
    expect(engine.publishHandoff({ current: "" }).action).toBe("error");
  });
});

describe("diagnosePublishBlockers", () => {
  it("names a missing prepare run and prints the Official Publish command", () => {
    const d = engine.diagnosePublishBlockers({
      version: "1.6.6",
      published: false,
      openPr: null,
      mergedPr: null,
    });
    expect(d.ok).toBe(false);
    expect(d.kind).toBe("no_prepare");
    expect(d.message).toContain("No merged release PR for release/v1.6.6");
    expect(d.message).toContain("FRIDAY Release");
    expect(d.message).toContain("mode=auto");
    expect(d.message).toContain("stage=prepare");
    expect(d.message).toContain("confirm=MERGE");
  });

  it("names an open unmerged release PR and the Safe Merge inputs", () => {
    const d = engine.diagnosePublishBlockers({
      version: "1.6.6",
      openPr: { number: 51, url: "https://example.test/51", mergeable: "MERGEABLE" },
    });
    expect(d.kind).toBe("pr_open_unmerged");
    expect(d.message).toContain("#51");
    expect(d.message).toContain("pr_numbers=51");
    expect(d.message).toContain("Safe Merge");
  });

  it("names failing checks instead of a generic unmerged error", () => {
    const d = engine.diagnosePublishBlockers({
      version: "1.6.6",
      openPr: {
        number: 51,
        failingChecks: ["PR Validation"],
      },
    });
    expect(d.message).toContain("PR Validation");
    expect(d.message).toContain("do not force-merge");
  });

  it("names a merged PR that is not yet on main", () => {
    const d = engine.diagnosePublishBlockers({
      version: "1.6.6",
      mergedPr: { number: 52 },
      ancestor: false,
      changelogOk: true,
    });
    expect(d.kind).toBe("merged_not_on_main");
    expect(d.message).toContain("not yet an ancestor");
  });

  it("names a missing changelog heading after merge", () => {
    const d = engine.diagnosePublishBlockers({
      version: "1.6.6",
      mergedPr: { number: 52 },
      ancestor: true,
      changelogOk: false,
    });
    expect(d.kind).toBe("changelog_missing");
  });

  it("names an already-published tag", () => {
    const d = engine.diagnosePublishBlockers({
      version: "1.6.5",
      published: true,
    });
    expect(d.kind).toBe("already_published");
    expect(d.message).toContain("mode=rebuild");
  });

  it("is ready when the merged PR is on main with a changelog heading", () => {
    const d = engine.diagnosePublishBlockers({
      version: "1.6.6",
      mergedPr: { number: 52 },
      ancestor: true,
      changelogOk: true,
    });
    expect(d).toMatchObject({ ok: true, kind: "ready" });
  });
});

describe("release workflow wiring", () => {
  const yml = read(".github/workflows/release.yml");

  it("publish resolves the version through the shared handoff guard", () => {
    expect(yml).toContain("release-engine.cjs handoff");
    expect(yml).toContain("--prepared prepared.json");
    expect(yml).toContain("headRefName");
    expect(yml).toContain("resolvePreparedState");
    expect(yml).toContain("Close superseded release preparations");
    expect(yml).toContain("closed superseded release preparation");
  });

  it("publish still refuses an existing tag and still proves the merge", () => {
    expect(yml).toContain("tag $tag already exists");
    expect(yml).toContain("Prove the release PR was merged into main");
    expect(yml).toContain("release-engine.cjs diagnose-publish");
    expect(yml).not.toContain("run stage 'prepare' and merge its PR first");
  });

  it("publish still ships the reviewed What's New from the prepared notes", () => {
    expect(yml).toContain('file="releases/notes/${{ steps.plan.outputs.tag }}.md"');
    expect(yml).toContain("release-engine.cjs guard-notes");
    expect(yml).toContain("Restore reviewed release notes after tests");
  });
});

describe("desktop release dispatch", () => {
  const src = read("electron/github-release.cjs");

  it("sends the rebuild/update/auto mode to the one release workflow", () => {
    expect(src).toContain('["auto", "rebuild", "update"].includes(input.mode)');
    expect(src).toMatch(/inputs:\s*\{\s*\n\s*stage,\s*\n\s*mode,/);
  });

  it("keeps the unmerged guard for update/auto and exempts only rebuild", () => {
    expect(src).toContain('if (mode !== "rebuild" && (!status.pr || !status.pr.merged))');
    expect(src).toContain('if (mode !== "rebuild" && status.pr?.released)');
  });
});
