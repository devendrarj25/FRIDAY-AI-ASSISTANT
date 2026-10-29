/**
 * Phase 3: newest verified-free fallback and a paid spend log.
 * No live provider call and no clock read.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();
const router = require_("../../electron/model-router.cjs");

const verified = (modelId: string) => ({
  id: `gemini:${modelId}`,
  type: "cloud" as const,
  contextK: 32,
  providerId: "gemini",
  providerModelId: modelId,
  accessRecord: {
    billingMode: "FREE_QUOTA",
    eligibility: "ELIGIBLE",
    verification: "VERIFIED",
    evidence: { source: "live_probe", checkedAt: 1, confidence: 1 },
  },
  meta: { providerId: "gemini", kind: "cloud", modelName: modelId, connected: true },
});

describe("newest verified free", () => {
  const older = verified("gemini-2.0-flash");
  const newer = verified("gemini-2.5-flash");

  it("prefers the newest verified model and falls back when that id failed", () => {
    const first = router.preferNewestFree([older, newer]);
    expect(first.chosen.id).toBe(newer.id);
    expect(first.order[0].id).toBe(newer.id);
    const failed = router.preferNewestFree([older, newer], { failedIds: [newer.id] });
    expect(failed.chosen.id).toBe(older.id);
    expect(failed.order.map((model: { id: string }) => model.id)).toContain(newer.id);
  });

  it("does not call a model that is off the saved allowlist", () => {
    const routed = router.routeRequest([older, newer], {
      mode: "cloud-only",
      policy: "free-preferred",
      allowlist: { ids: [older.id, newer.id], paidEnabled: false },
    });
    expect(routed.candidates[0]).toBe(newer.id);
    const dropped = router.routeRequest([older, newer], {
      mode: "cloud-only",
      policy: "free-preferred",
      allowlist: { ids: [older.id], paidEnabled: false },
      failedIds: [],
    });
    expect(dropped.candidates).toEqual([older.id]);
  });

  it("leaves an unverified free model behind a verified older one", () => {
    const signal = {
      id: "gemini:gemini-3.0-flash",
      type: "cloud",
      contextK: 32,
      providerId: "gemini",
      providerModelId: "gemini-3.0-flash",
      meta: { providerId: "gemini", kind: "cloud", modelName: "gemini-3.0-flash", connected: true },
    };
    const order = router.preferNewestFree([signal, older]).order;
    expect(order[0].id).toBe(older.id);
  });
});

describe("paid spend log", () => {
  it("adds a charge, rolls the day, and refuses a secret", () => {
    const first = router.recordSpend(
      { perDayUsd: 1, perMonthUsd: 5, spentDayUsd: 0, spentMonthUsd: 0 },
      { usd: 0.4, at: "2026-01-02T00:00:00.000Z", modelId: "openai:gpt-4.1" },
    );
    expect(first.ok).toBe(true);
    expect(first.budget.spentDayUsd).toBe(0.4);
    expect(first.budget.spentMonthUsd).toBe(0.4);
    const next = router.recordSpend(first.budget, {
      usd: 0.2,
      at: "2026-01-03T00:00:00.000Z",
      modelId: "openai:gpt-4.1",
      log: first.log,
    });
    expect(next.budget.spentDayUsd).toBe(0.2);
    expect(next.budget.spentMonthUsd).toBe(0.6);
    expect(JSON.stringify(next.log)).not.toMatch(/sk-/);
    const secret = router.recordSpend(first.budget, {
      usd: 0.1,
      at: "2026-01-02T00:00:00.000Z",
      modelId: "sk-aaaaaaaaaaaaaaaa",
    });
    expect(secret.ok).toBe(false);
    const over = router.budgetDecision({ perDayUsd: 1, spentDayUsd: 0.8 }, 0.3);
    expect(over.allows).toBe(false);
  });

  it("records spend through the desktop budget, not a second check", () => {
    const main = readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
    expect(main).toContain('ipcMain.handle("models:record-spend"');
    expect(main).toContain("modelRouter.recordSpend(");
    expect(main).not.toContain("second billing");
  });
});
