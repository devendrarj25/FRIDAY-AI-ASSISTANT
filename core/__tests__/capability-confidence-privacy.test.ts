import { describe, expect, it } from "vitest";
import {
  BASELINES,
  CONFIDENT_RUNS,
  scoreFor,
  capabilityMatrix,
  type CapabilityDomain,
} from "../../src/lib/friday/self/capability-matrix";
import { domainsForTask, estimateConfidence } from "../../src/lib/friday/brain/confidence";
import { orderByConfidence } from "../../src/lib/friday/brain/cost-policy";
import type { ModelCapabilityRecord } from "../../src/lib/friday/brain/model-registry";
import { governance, protectedPolicyPaths } from "../../src/lib/friday/self/governance";
import { autonomy } from "../../src/lib/friday/self/autonomy";

import { createRequire } from "node:module";

const privacyFirewall = createRequire(import.meta.url)("../../electron/privacy-firewall.cjs");

const record = (id: string, kind: "local" | "cloud", provider: string): ModelCapabilityRecord =>
  ({
    id,
    name: id,
    provider,
    kind,
    roles: ["planner"],
    cost: kind === "local" ? "free" : "metered",
    available: true,
  }) as unknown as ModelCapabilityRecord;

describe("capability matrix", () => {
  it("reports the declared baseline until a real run exists", () => {
    const score = scoreFor("coding", { runs: 0, successes: 0, lastRunAt: null });
    expect(score.provisional).toBe(true);
    expect(score.score).toBe(Math.round(BASELINES.coding * 100));
    expect(score.observed).toBeNull();
  });

  it("moves toward the measured rate as real runs accumulate", () => {
    const measured = scoreFor("coding", {
      runs: CONFIDENT_RUNS,
      successes: CONFIDENT_RUNS,
      lastRunAt: 1,
    });
    expect(measured.provisional).toBe(false);
    expect(measured.score).toBe(100);
    const failing = scoreFor("coding", { runs: CONFIDENT_RUNS, successes: 0, lastRunAt: 1 });
    expect(failing.score).toBe(0);
  });

  it("stores and returns real scores through the live store", () => {
    capabilityMatrix.reset();
    const before = capabilityMatrix.score("tool-use").score;
    capabilityMatrix.record("tool-use", false);
    const after = capabilityMatrix.score("tool-use");
    expect(after.runs).toBe(1);
    expect(after.provisional).toBe(false);
    expect(after.score).toBeLessThan(before);
    capabilityMatrix.reset();
  });
});

describe("confidence engine drives the routing decision", () => {
  const ability =
    (values: Partial<Record<CapabilityDomain, number>>) => (domain: CapabilityDomain) =>
      values[domain] ?? 0.9;

  it("matches a task to the domains it really needs", () => {
    expect(domainsForTask("refactor this typescript function")).toContain("coding");
    expect(domainsForTask("say hi")).toEqual(["conversation"]);
  });

  it("stays local when the measured capability is strong", () => {
    const confidence = estimateConfidence("refactor this python script", {
      ability: ability({ coding: 0.9 }),
    });
    expect(confidence.local).toBe(true);
  });

  it("prefers a stronger cloud model when confidence is low", () => {
    const confidence = estimateConfidence("refactor this python script", {
      ability: ability({ coding: 0.2 }),
    });
    expect(confidence.local).toBe(false);
    const ordered = orderByConfidence(
      [record("local-a", "local", "ollama"), record("cloud-a", "cloud", "openai")],
      confidence,
      "allow-paid",
      new Set(),
      // cloud is manual-only: this is the owner having picked it himself
      { allowed: true, ids: new Set(["cloud-a"]) },
    );
    expect(ordered.map((r) => r.id)).toEqual(["cloud-a", "local-a"]);
  });

  it("never overrides a free-only policy, however low the confidence", () => {
    const ordered = orderByConfidence(
      [record("local-a", "local", "ollama"), record("cloud-a", "cloud", "openai")],
      { local: false },
      "free-only",
      new Set(),
    );
    expect(ordered.map((r) => r.id)).toEqual(["local-a"]);
  });
});

describe("privacy / data-egress firewall", () => {
  it("classifies content by the most sensitive signal that matched", () => {
    expect(privacyFirewall.classify("password: hunter2").level).toBe("sensitive");
    expect(privacyFirewall.classify("mail me at a@b.com").level).toBe("private");
    expect(privacyFirewall.classify("see electron/main.cjs").level).toBe("internal");
    expect(privacyFirewall.classify("what is the capital of France").level).toBe("public");
  });

  it("never gates local inference", () => {
    const verdict = privacyFirewall.guardEgress({
      model: { type: "local", id: "llama" },
      content: "password: hunter2",
    });
    expect(verdict.requiresConfirmation).toBe(false);
  });

  it("asks every single time for an external send, with no remembered answer", () => {
    const model = { type: "cloud", id: "gpt", label: "GPT" };
    for (let i = 0; i < 3; i += 1) {
      const verdict = privacyFirewall.guardEgress({ model, content: "just a greeting" });
      expect(verdict.external).toBe(true);
      expect(verdict.requiresConfirmation).toBe(true);
    }
    const detail = privacyFirewall.describeEgress(
      privacyFirewall.guardEgress({ model, content: "my api_key = sk-abcdefghijklmnop" }),
      model,
      null,
    );
    expect(detail).toMatch(/SENSITIVE/);
    expect(detail).toMatch(/never remembered/i);
  });
});

describe("hard safety rule — the approval code protects itself", () => {
  it("flags a change that touches governance or action-risk", () => {
    expect(protectedPolicyPaths(["src/lib/friday/self/governance.ts"])).toHaveLength(1);
    expect(protectedPolicyPaths(["src\\lib\\friday\\brain\\action-risk.ts"])).toEqual([
      "src/lib/friday/brain/action-risk.ts",
    ]);
    expect(protectedPolicyPaths(["electron/privacy-firewall.cjs"])).toEqual([
      "electron/privacy-firewall.cjs",
    ]);
    expect(protectedPolicyPaths(["electron/tool-authority.cjs"])).toEqual([
      "electron/tool-authority.cjs",
    ]);
    expect(protectedPolicyPaths(["kernel/tools.py"])).toEqual(["kernel/tools.py"]);
    expect(protectedPolicyPaths(["kernel/privacy.py"])).toEqual(["kernel/privacy.py"]);
    expect(protectedPolicyPaths(["electron/credentials.cjs"])).toEqual([
      "electron/credentials.cjs",
    ]);
    expect(protectedPolicyPaths(["src/lib/friday/brain/cost-policy.ts"])).toEqual([]);
  });

  it("refuses to auto-approve a change that edits the approval code, even at the most relaxed level", async () => {
    autonomy.update({ approvalLevel: "trusted" });
    let applied = false;
    const item = governance.submit({
      kind: "research",
      title: "Self-development — tidy up governance",
      rationale: "routine tidy-up",
      risk: "safe",
      evidence: ["modified · src/lib/friday/self/governance.ts"],
      apply: async () => {
        applied = true;
        return { ok: true, detail: "applied" };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = governance.getSnapshot().pending;
    expect(pending.some((p) => p.title.includes("tidy up governance"))).toBe(true);
    expect(applied).toBe(false);
    const waiting = pending.find((p) => p.title.includes("tidy up governance"));
    expect(waiting?.logs.some((l) => /SAFETY-CRITICAL/.test(l.line))).toBe(true);
    governance.reject(waiting!.id);
    await item;
    expect(applied).toBe(false);
  });
});
