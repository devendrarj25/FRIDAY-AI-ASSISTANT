import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const freshness = require("../../scripts/validation-freshness.cjs") as {
  MAX_AGE_MS: number;
  decideReuse: (input: { sha: string; evidence: Array<Record<string, string>>; now?: number }) => {
    action: string;
    reuse: boolean;
    reason: string;
  };
};

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const SHA = "a".repeat(40);

describe("PR Validation reuse", () => {
  it("reuses a success on this commit from the last 7 days", () => {
    const decision = freshness.decideReuse({
      sha: SHA,
      now: NOW,
      evidence: [
        {
          context: "PR Validation",
          state: "success",
          updated_at: "2026-06-14T12:00:00.000Z",
          sha: SHA,
        },
      ],
    });
    expect(decision.action).toBe("reuse");
    expect(decision.reuse).toBe(true);
  });

  it("accepts the workflow job check as the same evidence", () => {
    const decision = freshness.decideReuse({
      sha: SHA,
      now: NOW,
      evidence: [
        {
          name: "PR Validation / validate",
          conclusion: "success",
          completed_at: "2026-06-15T00:00:00.000Z",
          head_sha: SHA,
        },
      ],
    });
    expect(decision.reuse).toBe(true);
  });

  it("runs again when the result is old, failed, or for another commit", () => {
    const old = freshness.decideReuse({
      sha: SHA,
      now: NOW,
      evidence: [
        {
          context: "PR Validation",
          state: "success",
          updated_at: new Date(NOW - freshness.MAX_AGE_MS - 1000).toISOString(),
          sha: SHA,
        },
      ],
    });
    expect(old.action).toBe("run");
    expect(old.reuse).toBe(false);

    const failed = freshness.decideReuse({
      sha: SHA,
      now: NOW,
      evidence: [
        { context: "PR Validation", state: "failure", updated_at: "2026-06-15T11:00:00.000Z" },
      ],
    });
    expect(failed.action).toBe("run");

    const running = freshness.decideReuse({
      sha: SHA,
      now: NOW,
      evidence: [
        {
          name: "PR Validation",
          status: "in_progress",
          conclusion: "",
          completed_at: "2026-06-15T11:30:00.000Z",
          sha: SHA,
        },
      ],
    });
    expect(running.action).toBe("wait");
    expect(running.reuse).toBe(false);

    const other = freshness.decideReuse({
      sha: SHA,
      now: NOW,
      evidence: [
        {
          context: "PR Validation",
          state: "success",
          updated_at: "2026-06-15T11:00:00.000Z",
          sha: "b".repeat(40),
        },
      ],
    });
    expect(other.action).toBe("run");
  });

  it("waits when a run is already in progress instead of starting a second one", () => {
    const decision = freshness.decideReuse({
      sha: SHA,
      now: NOW,
      evidence: [
        {
          context: "PR Validation",
          state: "pending",
          updated_at: "2026-06-15T11:50:00.000Z",
          sha: SHA,
        },
      ],
    });
    expect(decision.action).toBe("wait");
    expect(decision.reuse).toBe(false);
  });

  it("does not treat a different check as PR Validation", () => {
    const decision = freshness.decideReuse({
      sha: SHA,
      now: NOW,
      evidence: [
        {
          context: "Security Scan",
          state: "success",
          updated_at: "2026-06-15T11:00:00.000Z",
          sha: SHA,
        },
      ],
    });
    expect(decision.action).toBe("run");
  });
});
