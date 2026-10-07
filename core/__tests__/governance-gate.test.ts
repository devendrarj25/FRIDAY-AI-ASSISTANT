import { describe, expect, it } from "vitest";
import {
  governance,
  ALWAYS_ASK_KINDS,
  evaluateChange,
  PROTECTED_POLICY_FILES,
} from "../../src/lib/friday/self/governance";
import { proposeFabricLimitation } from "../../src/lib/friday/self/limitation-loop";
import { autonomy } from "../../src/lib/friday/self/autonomy";

describe("self-upgrade approval gate", () => {
  it("never auto-approves an upgrade / install / code change, at any policy level", () => {
    for (const level of ["strict", "balanced", "trusted"] as const) {
      autonomy.update({ approvalLevel: level });
      for (const kind of ALWAYS_ASK_KINDS) {
        expect(governance.autoApproves("safe", kind), `${level}/${kind}`).toBe(false);
        expect(governance.autoApproves("review", kind), `${level}/${kind}`).toBe(false);
        expect(governance.autoApproves("risky", kind), `${level}/${kind}`).toBe(false);
      }
    }
  });

  it("lets Full autonomy apply an install, and Stop everything halts that", () => {
    autonomy.update({ approvalLevel: "full", halted: false });
    expect(governance.autoApproves("safe", "install")).toBe(true);
    autonomy.stopEverything();
    expect(governance.autoApproves("safe", "install")).toBe(false);
    expect(governance.autoApproves("risky", "code-change")).toBe(false);
    autonomy.update({ approvalLevel: "balanced", halted: false });
  });

  it("still lets reversible, read-only work through under a relaxed policy", () => {
    autonomy.update({ approvalLevel: "trusted" });
    expect(governance.autoApproves("safe", "research")).toBe(true);
    expect(governance.autoApproves("risky", "repair")).toBe(false);
    autonomy.update({ approvalLevel: "strict" });
    expect(governance.autoApproves("safe", "research")).toBe(false);
  });

  it("refuses a protected file at Full and never applies the proposal", () => {
    const proposed = proposeFabricLimitation({
      id: "touch-privacy",
      title: "rewrite the privacy gate",
      rationale: "shorter",
      evidence: ["electron/privacy-firewall.cjs"],
    });
    expect(proposed.applied).toBe(false);
    expect(proposed.autoApproved).toBe(false);
    for (const file of PROTECTED_POLICY_FILES) {
      const verdict = evaluateChange({ paths: [file], level: "full", halted: false });
      expect(verdict.allow).toBe("refuse");
      expect(verdict.applied).toBe(false);
      expect(verdict.reason).toBe("protected");
    }
    expect(evaluateChange({ paths: ["src/lib/friday/notes.ts"], level: "full" }).allow).toBe(
      "stage",
    );
    expect(evaluateChange({ paths: ["src/lib/friday/notes.ts"], level: "balanced" }).allow).toBe(
      "ask",
    );
    expect(
      evaluateChange({ paths: ["src/lib/friday/notes.ts"], level: "full", halted: true }).allow,
    ).toBe("refuse");
  });
});
