import { describe, expect, it } from "vitest";
import { auditApprovals, describeAudit } from "../../src/lib/friday/self/approvals-audit";
import type { GovItem } from "../../src/lib/friday/self/governance";

const NOW = new Date(2026, 9, 31, 12, 0).getTime();
const DAY = 86_400_000;
const item = (stage: GovItem["stage"], over: Partial<GovItem> = {}): GovItem =>
  ({
    id: Math.random().toString(36),
    kind: "research",
    title: "Something",
    rationale: "",
    risk: "review",
    evidence: [],
    stage,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    logs: [],
    ...over,
  }) as GovItem;

describe("approvals audit", () => {
  const summary = auditApprovals(
    [
      item("completed", { autoApproved: true, title: "Practise: parsing" }),
      item("completed"),
      item("applied", { kind: "install", risk: "risky" }),
      item("rejected"),
      item("failed"),
      item("rolled-back"),
      item("waiting-approval"),
      item("completed", { updatedAt: NOW - 30 * DAY }),
    ],
    NOW,
  );

  it("counts what was done on its own, after a yes, refused, failed, undone and waiting", () => {
    expect(summary).toMatchObject({
      total: 7,
      done: 3,
      automatic: 1,
      refused: 1,
      failed: 1,
      undone: 1,
      waiting: 1,
    });
    expect(summary.byKind).toMatchObject({ research: 6, install: 1 });
    expect(summary.byRisk["risky"]).toBe(1);
  });

  it("ignores older proposals and labels recent outcomes plainly", () => {
    expect(summary.recent.some((row) => row.outcome === "done on its own")).toBe(true);
    expect(summary.recent.map((row) => row.outcome)).toContain("waiting for you");
    expect(summary.total).toBe(7);
  });

  it("says it in a sentence, and says so when nothing happened", () => {
    expect(describeAudit(summary)[0]).toMatch(
      /7 proposal\(s\) in 7 days: 3 done \(1 on their own, 2 after your yes\), 1 refused/,
    );
    expect(describeAudit(auditApprovals([], NOW))[0]).toMatch(/Nothing was proposed/);
  });

  it("points out when nothing needed a click", () => {
    const only = auditApprovals([item("completed", { autoApproved: true })], NOW);
    expect(describeAudit(only).join(" ")).toMatch(/without a click/);
  });
});
