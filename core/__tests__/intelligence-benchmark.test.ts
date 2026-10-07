/**
 * Fabric limitations file through existing governance. Lightweight
 * BEFORE/AFTER benchmark over Parts A–J. No new self-modification path.
 */
import { describe, expect, it } from "vitest";

import { ALWAYS_ASK_KINDS, governance } from "../../src/lib/friday/self/governance";
import { runIntelligenceBenchmark } from "../../src/lib/friday/self/intelligence-benchmark";
import {
  limitationAlwaysAsks,
  proposeFabricLimitation,
} from "../../src/lib/friday/self/limitation-loop";

describe("governed limitation loop", () => {
  it("discovers a code-change limitation and never applies it", () => {
    const proposal = proposeFabricLimitation({
      id: "unit-probe-code-change",
      title: "Unit probe — do not apply",
      rationale: "Confirms discover-only filing.",
      evidence: ["limitation-loop.test"],
      kind: "code-change",
      risk: "review",
    });
    expect(proposal.applied).toBe(false);
    expect(proposal.autoApproved).toBe(false);
    expect(proposal.stage).toBe("discovered");
    expect(limitationAlwaysAsks("code-change")).toBe(true);
    expect(ALWAYS_ASK_KINDS.has("code-change")).toBe(true);
    const item = governance.get(proposal.id);
    expect(item?.stage).toBe("discovered");
    expect(governance.autoApproves("review", "code-change")).toBe(false);
    const again = proposeFabricLimitation({
      id: "unit-probe-code-change",
      title: "Unit probe — do not apply",
      rationale: "duplicate",
    });
    expect(again.queued).toBe(false);
  });
});

describe("intelligence fabric benchmark", () => {
  it("holds BEFORE/AFTER floors without a governance bypass", () => {
    const report = runIntelligenceBenchmark();
    expect(report.safetyBypassDetected).toBe(false);
    expect(report.failed).toBe(0);
    const ids = report.checks.map((check) => check.id);
    expect(report.scoreKind).toBe("directional-plus-gold");
    expect(ids).toEqual(
      expect.arrayContaining([
        "memory-recall",
        "context-continuity",
        "knowledge-accuracy",
        "causal-honesty",
        "planning-replan",
        "routing-quality",
        "self-evaluation",
        "reasoning-honesty",
        "query-expand",
        "knowledge-strips",
        "related-route",
        "owner-identity-gold",
        "safety-no-bypass",
        "modality-honesty",
      ]),
    );
    for (const check of report.checks) {
      expect(check.after, check.id).toBeGreaterThanOrEqual(check.before);
      expect(check.ok, `${check.id}: ${check.detail}`).toBe(true);
    }
  });
});
