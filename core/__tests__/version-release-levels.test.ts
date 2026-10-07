/**
 * FRIDAY public release levels on the four-part line.
 * Only the chosen counter moves. The others keep counting.
 *
 * PATCH / FIX     1.0.1.2 -> 1.0.1.3
 * MINOR / CHANGES 1.0.1.2 -> 1.0.2.2
 * MAJOR / FEATURE 1.0.1.2 -> 1.1.1.2
 * EXTREME UPDATE  1.0.1.2 -> 2.0.1.2
 * REBUILD / revision  same version
 *
 * release_type auto never selects extreme. The fourth counter is numeric
 * (9 -> 10 -> 100).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const engine = require(path.resolve(process.cwd(), "scripts/release-engine.cjs"));

describe("public release levels · bump matrix", () => {
  it("PATCH / FIX increments only the fourth number", () => {
    expect(engine.bumpVersion("1.0.0.0", "patch")).toBe("1.0.0.1");
    expect(engine.bumpVersion("1.0.0.9", "patch")).toBe("1.0.0.10");
    expect(engine.bumpVersion("1.0.0.10", "patch")).toBe("1.0.0.11");
    expect(engine.bumpVersion("1.0.0.99", "patch")).toBe("1.0.0.100");
    expect(engine.releaseTypeLabel("patch")).toBe("PATCH / FIX");
  });

  it("MINOR / CHANGES increments only the third number", () => {
    expect(engine.bumpVersion("1.0.0.1", "minor")).toBe("1.0.1.1");
    expect(engine.bumpVersion("1.0.0.10", "minor")).toBe("1.0.1.10");
    expect(engine.bumpVersion("1.0.0.7", "minor")).toBe("1.0.1.7");
    expect(engine.bumpVersion("1.0.1.2", "minor")).toBe("1.0.2.2");
    expect(engine.releaseTypeLabel("minor")).toBe("MINOR / CHANGES");
  });

  it("MAJOR / FEATURE increments only the second number", () => {
    expect(engine.bumpVersion("1.0.1.0", "major")).toBe("1.1.1.0");
    expect(engine.bumpVersion("1.0.8.12", "major")).toBe("1.1.8.12");
    expect(engine.bumpVersion("1.5.8.12", "major")).toBe("1.6.8.12");
    expect(engine.bumpVersion("1.0.1.2", "major")).toBe("1.1.1.2");
    expect(engine.releaseTypeLabel("major")).toBe("MAJOR / FEATURE");
  });

  it("EXTREME UPDATE increments only the first number", () => {
    expect(engine.bumpVersion("1.1.0.0", "extreme")).toBe("2.1.0.0");
    expect(engine.bumpVersion("1.9.8.12", "extreme")).toBe("2.9.8.12");
    expect(engine.bumpVersion("1.0.1.2", "extreme")).toBe("2.0.1.2");
    expect(engine.releaseTypeLabel("extreme")).toBe("EXTREME UPDATE / FULL SYSTEM VERSION UPDATE");
  });

  it("REBUILD and revision keep the public version exactly", () => {
    expect(engine.bumpVersion("1.0.0.0", "rebuild")).toBe("1.0.0.0");
    expect(engine.bumpVersion("1.0.0.7", "rebuild")).toBe("1.0.0.7");
    expect(engine.bumpVersion("1.1.0.0", "rebuild")).toBe("1.1.0.0");
    expect(engine.bumpVersion("2.0.0.0", "rebuild")).toBe("2.0.0.0");
    expect(engine.bumpVersion("1.0.0.0", "revision")).toBe("1.0.0.0");
    expect(engine.bumpVersion("1.0.1.2", "revision")).toBe("1.0.1.2");
    expect(engine.releaseTypeLabel("revision")).toBe("REBUILD");
  });

  it("continues every counter from 1.0.0.0", () => {
    let v = "1.0.0.0";
    v = engine.bumpVersion(v, "patch");
    expect(v).toBe("1.0.0.1");
    v = engine.bumpVersion(v, "minor");
    expect(v).toBe("1.0.1.1");
    v = engine.bumpVersion(v, "patch");
    expect(v).toBe("1.0.1.2");
    v = engine.bumpVersion(v, "minor");
    expect(v).toBe("1.0.2.2");
    v = engine.bumpVersion(v, "patch");
    expect(v).toBe("1.0.2.3");
    v = engine.bumpVersion(v, "major");
    expect(v).toBe("1.1.2.3");
    v = engine.bumpVersion(v, "extreme");
    expect(v).toBe("2.1.2.3");
    v = engine.bumpVersion(v, "major");
    expect(v).toBe("2.2.2.3");
    v = engine.bumpVersion(v, "extreme");
    expect(v).toBe("3.2.2.3");
  });
});

describe("public release levels · numeric comparison", () => {
  it("orders multi-digit revisions numerically, never as strings", () => {
    expect(engine.compareBuilds("1.0.0.10", "1.0.0.9")).toBeGreaterThan(0);
    expect(engine.compareBuilds("1.0.0.100", "1.0.0.99")).toBeGreaterThan(0);
    expect(engine.compareBuilds("1.0.0.10", "1.0.1.0")).toBeLessThan(0);
    expect(engine.compareBuilds("1.0.1.0", "1.1.0.0")).toBeLessThan(0);
    expect(engine.compareBuilds("1.1.0.0", "2.0.0.0")).toBeLessThan(0);
  });

  it("does not treat npm encoding as a newer identity than its four-part twin", () => {
    expect(engine.compareBuilds("1.0.0", "1.0.0.0")).toBe(0);
    expect(engine.compareBuilds("1.0.0.1", "1.0.0")).toBeGreaterThan(0);
  });
});

describe("public release levels · auto vs explicit", () => {
  it("maps conventional commits onto PATCH / MINOR / MAJOR and never extreme", () => {
    expect(engine.nextVersion("1.0.0.0", "auto", ["fix: overlay clip"]).bump).toBe("patch");
    expect(engine.nextVersion("1.0.0.0", "auto", ["fix: overlay clip"]).version).toBe("1.0.0.1");
    expect(engine.nextVersion("1.0.0.1", "auto", ["feat: grouped desk tools"]).version).toBe(
      "1.0.1.1",
    );
    expect(engine.nextVersion("1.0.1.0", "auto", ["feat!: new kernel API"]).version).toBe(
      "1.1.1.0",
    );
    expect(engine.nextVersion("1.1.0.0", "auto", ["feat!: storage rewrite"]).bump).toBe("major");
    expect(engine.nextVersion("1.1.0.0", "auto", ["feat!: storage rewrite"]).version).toBe(
      "1.2.0.0",
    );
    expect(engine.nextVersion("1.0.1.2", "auto", ["feat!: storage rewrite"]).bump).not.toBe(
      "extreme",
    );
    expect(engine.bumpKindForScheme("extreme", "1.1.0.0")).toBe("major");
  });

  it("requires an explicit extreme intent to move the first counter", () => {
    expect(engine.nextVersion("1.1.0.0", "extreme", ["feat!: storage rewrite"]).version).toBe(
      "2.1.0.0",
    );
    expect(engine.nextVersion("1.0.1.2", "extreme", ["feat: anything"]).version).toBe("2.0.1.2");
  });

  it("fails closed when an update's auto type would have to guess", () => {
    const planned = engine.plan({
      previous: "1.0.0.0",
      type: "auto",
      subjects: ["updated some files", "WIP"],
    });
    expect(planned.ok).toBe(false);
    expect(planned.version).toBeNull();
    const decided = engine.decideRelease({
      mode: "update",
      type: "auto",
      current: "1.0.0.0",
      baseline: "1.0.0.0",
      released: ["1.0.0.0"],
      subjects: ["updated some files"],
    });
    expect(decided.action).toBe("error");
    expect(decided.reason).toMatch(/unclassified/i);
  });

  it("keeps the published number when mode is auto and the type is auto", () => {
    const decided = engine.decideRelease({
      mode: "auto",
      type: "auto",
      current: "1.0.1.2",
      baseline: "1.0.1.2",
      released: ["1.0.1.2"],
      subjects: ["feat!: a large upgrade", "updated some files"],
    });
    expect(decided.action).toBe("rebuild");
    expect(decided.version).toBe("1.0.1.2");
    expect(decided.bump).toBe("none");
  });
});

describe("public release levels · decideRelease", () => {
  it("rebuilds when nothing releasable landed", () => {
    const d = engine.decideRelease({
      mode: "auto",
      current: "1.0.0.0",
      baseline: "1.0.0.0",
      released: ["1.0.0.0"],
      subjects: ["Merge branch 'main'", "release: v1.0.0.0"],
    });
    expect(d.action).toBe("rebuild");
    expect(d.version).toBe("1.0.0.0");
    expect(d.releaseType).toBe("rebuild");
  });

  it("applies PATCH / FIX for a classified bug fix", () => {
    const d = engine.decideRelease({
      mode: "update",
      type: "auto",
      current: "1.0.0.0",
      baseline: "1.0.0.0",
      released: ["1.0.0.0"],
      subjects: ["fix: chat input freeze"],
    });
    expect(d.action).toBe("update");
    expect(d.version).toBe("1.0.0.1");
    expect(d.bump).toBe("patch");
    expect(d.releaseLabel).toBe("PATCH / FIX");
  });

  it("applies MINOR / CHANGES for a meaningful feature grouping", () => {
    const d = engine.decideRelease({
      mode: "update",
      current: "1.0.0.1",
      baseline: "1.0.0.1",
      released: ["1.0.0.1"],
      subjects: ["feat: owner-visible retry on doctor"],
    });
    expect(d.version).toBe("1.0.1.1");
    expect(d.bump).toBe("minor");
  });

  it("applies MAJOR / FEATURE for an explicit major type", () => {
    const d = engine.decideRelease({
      mode: "update",
      type: "major",
      current: "1.0.1.0",
      baseline: "1.0.1.0",
      released: ["1.0.1.0"],
      subjects: ["feat: substantial new capability"],
    });
    expect(d.version).toBe("1.1.1.0");
    expect(d.bump).toBe("major");
  });

  it("applies EXTREME UPDATE only when the owner asks for it", () => {
    const d = engine.decideRelease({
      mode: "update",
      type: "extreme",
      current: "1.1.0.0",
      baseline: "1.1.0.0",
      released: ["1.1.0.0"],
      subjects: ["feat!: generation rewrite"],
    });
    expect(d.version).toBe("2.1.0.0");
    expect(d.bump).toBe("extreme");
  });

  it("treats revision as a rebuild of the same number", () => {
    const d = engine.decideRelease({
      mode: "update",
      type: "revision",
      current: "1.0.1.2",
      baseline: "1.0.1.2",
      released: ["1.0.1.2"],
      subjects: ["feat: something huge"],
    });
    expect(d.action).toBe("rebuild");
    expect(d.version).toBe("1.0.1.2");
    expect(d.bump).toBe("none");
  });

  it("never bumps during an explicit rebuild, even with feat commits", () => {
    for (const current of ["1.0.0.0", "1.0.0.1", "2.0.0.0"]) {
      const d = engine.decideRelease({
        mode: "rebuild",
        current,
        baseline: current,
        released: [current],
        subjects: ["feat: something huge"],
      });
      expect(d.action).toBe("rebuild");
      expect(d.version).toBe(current);
    }
  });

  it("releases the unpublished version already on main instead of bumping again", () => {
    const d = engine.decideRelease({
      mode: "auto",
      type: "patch",
      current: "1.0.0.1",
      baseline: "1.0.0.0",
      released: ["1.0.0.0"],
      subjects: ["fix: packaging"],
    });
    expect(d.version).toBe("1.0.0.1");
    expect(d.bump).toBe("none");
  });
});

describe("public release levels · What's New stores the type", () => {
  it("records PATCH / FIX on generated notes", () => {
    const notes = engine.whatsNew({
      version: "1.0.0.1",
      previous: "v1.0.0.0",
      subjects: ["fix: overlay clip"],
      releaseType: "patch",
      date: new Date("2026-09-04T00:00:00Z"),
    });
    expect(notes).toContain("**Release type:** PATCH / FIX");
    expect(engine.extractNotesReleaseType(notes)).toBe("patch");
  });
});
