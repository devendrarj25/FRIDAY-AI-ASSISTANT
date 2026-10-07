import { beforeEach, describe, expect, it } from "vitest";
import { autonomy, DEFAULT_AUTONOMY } from "../../src/lib/friday/self/autonomy";
import { governance } from "../../src/lib/friday/self/governance";

beforeEach(() => {
  autonomy.reset();
  governance.clearSettled();
});

describe("autonomy settings", () => {
  it("merge-patches and keeps every other setting", () => {
    const next = autonomy.update({ approvalLevel: "strict" });
    expect(next.approvalLevel).toBe("strict");
    expect(next.researchSources).toEqual(DEFAULT_AUTONOMY.researchSources);
  });

  it("only allows research from approved sources", () => {
    expect(autonomy.allowsSource("https://github.com/foo/bar")).toBe(true);
    expect(autonomy.allowsSource("https://docs.python.org/3/")).toBe(true);
    expect(autonomy.allowsSource("https://random-site.example/x")).toBe(false);
    autonomy.update({ researchEnabled: false });
    expect(autonomy.allowsSource("https://github.com/foo/bar")).toBe(false);
  });
});

describe("governance approval gate", () => {
  it("never applies a risky action without approval", async () => {
    let applied = false;
    const run = governance.submit({
      id: "test:risky",
      kind: "install",
      title: "Install a package",
      rationale: "needed by a proposal",
      risk: "risky",
      apply: async () => {
        applied = true;
        return { ok: true, detail: "installed" };
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(applied).toBe(false);
    expect(governance.get("test:risky")?.stage).toBe("waiting-approval");
    governance.reject("test:risky");
    const item = await run;
    expect(applied).toBe(false);
    expect(item.stage).toBe("rejected");
  });

  it("auto-approves safe work at the balanced level and verifies it", async () => {
    const item = await governance.submit({
      id: "test:safe",
      kind: "repair",
      title: "Repair database index",
      rationale: "index missing",
      risk: "safe",
      dryRun: async () => ({ ok: true, detail: "dry-run clean" }),
      apply: async () => ({ ok: true, detail: "repaired", checkpoint: "backup-1" }),
      verify: async () => ({ ok: true, detail: "index present" }),
    });
    expect(item.autoApproved).toBe(true);
    expect(item.stage).toBe("completed");
    expect(item.checkpoint).toBe("backup-1");
  });

  it("strict level asks even for safe work", () => {
    autonomy.update({ approvalLevel: "strict" });
    expect(governance.autoApproves("safe")).toBe(false);
    autonomy.update({ approvalLevel: "trusted" });
    expect(governance.autoApproves("review")).toBe(true);
    expect(governance.autoApproves("risky")).toBe(false);
  });

  it("rolls back automatically when the apply step fails", async () => {
    let rolledBack = false;
    // A self-upgrade is never auto-approved, so the owner approves it here.
    const pending = governance.submit({
      id: "test:rollback",
      kind: "self-upgrade",
      title: "Install new build",
      rationale: "new version staged",
      risk: "safe",
      apply: async () => ({ ok: false, detail: "installer exited 1", checkpoint: "cp-9" }),
      rollback: async (checkpoint) => {
        rolledBack = checkpoint === "cp-9";
        return { ok: rolledBack, detail: "previous build restored" };
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    governance.approve("test:rollback");
    const item = await pending;
    expect(rolledBack).toBe(true);
    expect(item.stage).toBe("rolled-back");
  });

  it("stops before approval when the dry-run fails", async () => {
    const item = await governance.submit({
      id: "test:dryrun",
      kind: "code-change",
      title: "Patch module",
      rationale: "bug fix",
      risk: "safe",
      dryRun: async () => ({ ok: false, detail: "sandbox typecheck failed" }),
      apply: async () => ({ ok: true, detail: "should never run" }),
    });
    expect(item.stage).toBe("failed");
    expect(item.dryRun?.ok).toBe(false);
  });
});
