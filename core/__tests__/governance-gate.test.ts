import { describe, expect, it } from "vitest";
import { governance, ALWAYS_ASK_KINDS } from "../../src/lib/friday/self/governance";
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
});
