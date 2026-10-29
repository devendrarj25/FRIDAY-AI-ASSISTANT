/**
 * Installed skills must actually take part in a turn — but only when the
 * request unambiguously calls for one, and never for risky skills.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  chooseSkill,
  chooseSkills,
  describeSkillValue,
  lastScoredCount,
  resetSkillIndex,
  scoreSkill,
} from "../../src/lib/friday/brain/skill-router";
import type { SkillManifest } from "../../src/lib/friday/brain/skill-forge";

const skill = (over: Partial<SkillManifest> = {}): SkillManifest => ({
  id: "invoice-summary",
  name: "Invoice Summary",
  summary: "Summarise invoice totals from a spreadsheet",
  category: "office",
  capabilities: [],
  risk: "safe",
  inputs: [],
  version: 1,
  author: "owner",
  enabled: true,
  builtin: false,
  runs: 0,
  failures: 0,
  ...over,
});

describe("skill router", () => {
  it("fires when the owner names the skill", () => {
    expect(scoreSkill("run my invoice summary please", skill())).toBe(1);
    expect(chooseSkill("run my invoice summary please", [skill()])?.id).toBe("invoice-summary");
  });

  it("fires when enough of the skill's own words are present", () => {
    expect(chooseSkill("summarise the invoice totals in this spreadsheet", [skill()])).toBeTruthy();
  });

  it("stays out of ordinary conversation", () => {
    expect(chooseSkill("how are you today?", [skill()])).toBeNull();
    expect(chooseSkill("what is the weather", [skill()])).toBeNull();
  });

  it("never auto-runs disabled or risky skills", () => {
    expect(chooseSkill("run my invoice summary", [skill({ enabled: false })])).toBeNull();
    expect(chooseSkill("run my invoice summary", [skill({ risk: "exec" })])).toBeNull();
    expect(chooseSkill("run my invoice summary", [skill({ risk: "write" })])).toBeNull();
  });

  it("picks the strongest match when several could apply", () => {
    const other = skill({
      id: "invoice-mailer",
      name: "Invoice Mailer",
      summary: "Email invoices",
    });
    expect(chooseSkill("run invoice summary now", [other, skill()])?.id).toBe("invoice-summary");
  });

  it("can run several named skills in sequence without scoring the whole catalog", () => {
    resetSkillIndex();
    const mailer = skill({
      id: "invoice-mailer",
      name: "Invoice Mailer",
      summary: "Email invoices",
    });
    const noise = Array.from({ length: 80 }, (_, i) =>
      skill({
        id: `noise-${i}`,
        name: `Noise Pack ${i}`,
        summary: `Unrelated packing list helper number ${i}`,
        category: "home",
      }),
    );
    const catalog = [skill(), mailer, ...noise];
    const picked = chooseSkills("run Invoice Summary then Invoice Mailer", catalog, { limit: 3 });
    expect(picked.map((item) => item.id)).toEqual(["invoice-summary", "invoice-mailer"]);
    expect(lastScoredCount()).toBeLessThan(catalog.length);
    expect(lastScoredCount()).toBeGreaterThan(0);
  });

  it("does not score every skill when the index already has a candidate hit", () => {
    resetSkillIndex();
    const catalog = [
      skill(),
      ...Array.from({ length: 120 }, (_, i) =>
        skill({
          id: `other-${i}`,
          name: `Other Tool ${i}`,
          summary: `Garden watering interval table ${i}`,
          category: "home",
        }),
      ),
    ];
    expect(chooseSkill("run my invoice summary please", catalog)?.id).toBe("invoice-summary");
    expect(lastScoredCount()).toBeLessThan(20);
  });

  it("renders skill output for the model without unbounded payloads", () => {
    expect(describeSkillValue("hello")).toBe("hello");
    expect(describeSkillValue({ total: 12 })).toContain('"total": 12');
    expect(describeSkillValue(null)).toBe("(no output)");
    expect(describeSkillValue("x".repeat(9000)).length).toBe(4000);
  });
});

describe("skill-forge gap drafts", () => {
  beforeEach(async () => {
    const { governance } = await import("../../src/lib/friday/self/governance");
    governance.resetForTests();
  });

  it("files a real governance skill draft and never installs it", async () => {
    const { fileSkillGapDraft, looksLikeCapabilityGap, resetSkillGapDrafts } =
      await import("../../src/lib/friday/brain/skill-forge");
    const { governance } = await import("../../src/lib/friday/self/governance");
    resetSkillGapDrafts();
    expect(looksLikeCapabilityGap("hello")).toBe(false);
    expect(looksLikeCapabilityGap("create a skill that counts words in a pasted invoice")).toBe(
      true,
    );
    const draft = fileSkillGapDraft("create a skill that counts words in a pasted invoice");
    expect(draft.stage).toBe("planning");
    expect(draft.skillId).toBeNull();
    const item = governance.list().find((entry) => entry.evidence.includes(`forge:${draft.id}`));
    expect(item?.kind).toBe("skill");
    expect(item?.stage).toBe("discovered");
    expect(item?.stage).not.toBe("applied");
  });

  it("core brain files that draft when a genuine gap is asked", async () => {
    const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
    const cognition = await coreBrain.cognize(
      "create a skill that counts words in a pasted invoice",
      { mode: "manual" },
    );
    expect(cognition.notes.join(" ")).toMatch(/skill-forge draft/i);
    expect(cognition.tools.some((tool) => tool.query === "skill-forge" && !tool.ok)).toBe(true);
  });
});
