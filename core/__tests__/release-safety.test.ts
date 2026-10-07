import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const engine = require(path.resolve(process.cwd(), "scripts/release-engine.cjs")) as {
  detectBump: (subjects: string[]) => string;
  ambiguousSubjects: (subjects: string[]) => string[];
  plan: (input: { previous: string; type?: string; subjects: string[] }) => {
    ok?: boolean;
    version: string | null;
    bump: string | null;
    ambiguous: string[];
    safeDefault: boolean;
    error?: string;
  };
};

describe("release safety · version can never drift upwards by accident", () => {
  it("refuses to guess a bump from unclassifiable commits", () => {
    const subjects = ["updated some files", "work in progress", "added stuff to the panel"];
    expect(engine.detectBump(subjects)).toBe("patch");
    const planned = engine.plan({ previous: "v1.2.0", subjects });
    expect(planned.ok).toBe(false);
    expect(planned.version).toBeNull();
    expect(planned.bump).toBeNull();
    expect(planned.ambiguous).toHaveLength(3);
    expect(planned.error).toMatch(/unclassified/i);
  });

  it("still raises the version for explicit conventional signals", () => {
    expect(engine.detectBump(["feat: voice picker"])).toBe("minor");
    expect(engine.detectBump(["feat!: new kernel API"])).toBe("major");
    expect(engine.plan({ previous: "v1.2.0", subjects: ["feat: x"] }).safeDefault).toBe(false);
  });

  it("an explicit release type always wins over detection", () => {
    const planned = engine.plan({ previous: "v1.2.0", type: "major", subjects: ["random note"] });
    expect(planned.version).toBe("2.0.0");
    expect(planned.safeDefault).toBe(false);
  });

  it("ignores merge and release noise when reporting ambiguity", () => {
    expect(
      engine.ambiguousSubjects(["Merge branch 'main'", "release: v1.2.0", "fix: real fix"]),
    ).toEqual([]);
  });
});

describe("release safety · stale source guard", () => {
  const release = require(path.resolve(process.cwd(), "electron/github-release.cjs")) as {
    dispatchRelease: (
      root: string,
      input: Record<string, unknown>,
    ) => Promise<{ ok: boolean; localChanges?: boolean; state?: { dirty?: number } }>;
  };

  it("refuses a release while this PC holds newer source, and never releases silently", async () => {
    const push = require(path.resolve(process.cwd(), "electron/github-push.cjs"));
    const sync = require(path.resolve(process.cwd(), "electron/github-sync.cjs"));
    const originalSync = push.syncState;
    const originalConfig = sync.readConfig;
    push.syncState = async () => ({
      ok: true,
      repo: true,
      synced: false,
      dirty: 2,
      ahead: 1,
      branch: "main",
    });
    sync.readConfig = () => ({ repo: "owner/friday", branch: "main", token: "t" });
    try {
      const refused = await release.dispatchRelease("/tmp/friday", { releaseType: "patch" });
      expect(refused.ok).toBe(false);
      expect(refused.localChanges).toBe(true);
      expect(refused.state?.dirty).toBe(2);
    } finally {
      push.syncState = originalSync;
      sync.readConfig = originalConfig;
    }
  });
});

describe("development source push safety", () => {
  const push = require(path.resolve(process.cwd(), "electron/github-push.cjs")) as {
    isProtectedBranch: (branch: string) => boolean;
  };

  it("treats main and other release branches as protected push targets", () => {
    for (const branch of ["main", "MAIN", " master ", "release", "gh-pages"]) {
      expect(push.isProtectedBranch(branch)).toBe(true);
    }
    expect(push.isProtectedBranch("feature/chat-fix")).toBe(false);
    expect(push.isProtectedBranch("fix/startup")).toBe(false);
  });
});
