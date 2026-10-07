import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeSelfReport,
  inspectSelf,
  inspectSourceHealth,
  analyzeOwnFailure,
  problemsFromArchitectureIndex,
  problemsFromAuditText,
  problemsFromCoolingModels,
  problemsFromVerifyResult,
  proposeSourceFix,
} from "../../src/lib/friday/brain/self-diagnosis";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { governance } from "../../src/lib/friday/self/governance";

const root = process.cwd();
const auditPath = join(root, "AUDIT.md");

const readWorkspace = async (relative: string): Promise<string | null> => {
  const full = join(root, relative);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
};

describe("FRIDAY self-diagnosis", () => {
  it("reports honestly instead of claiming health it hasn't verified", () => {
    const report = inspectSelf();
    const text = describeSelfReport(report);
    expect(typeof report.healthy).toBe("boolean");
    if (!report.inspected) expect(text).toMatch(/haven't inspected/i);
    expect(report.facts.join(" ")).toMatch(/Intelligence-fabric benchmark is loaded/);
  });

  it("answers 'what's wrong' from her own state", () => {
    const reply = baselineRespond("what is wrong with the system?");
    expect(reply.handled).toBe(true);
    expect(reply.kind).toBe("diagnosis");
  });

  it("recognises a pasted error and offers a real fix", () => {
    const reply = baselineRespond("Error: listen EADDRINUSE: address already in use :::8080");
    expect(reply.handled).toBe(true);
    expect(reply.text.length).toBeGreaterThan(0);
  });

  it("routes 'find bugs in your source' through diagnosis, not a model", async () => {
    const reply = baselineRespond("find bugs in your own source");
    expect(reply.handled).toBe(true);
    expect(reply.kind).toBe("diagnosis");
    expect(typeof reply.resolve).toBe("function");
    const text = await reply.resolve!();
    expect(text).toMatch(/approval/i);
  });
});

describe("source health", () => {
  it("treats a recorded prettier error count as a SelfProblem", () => {
    const problems = problemsFromAuditText(
      [
        "| Check | Command | Result |",
        "| --- | --- | --- |",
        "| Lint | `npm run lint` | **12 prettier errors**, 4 warnings |",
        "| Types | `npm run typecheck` | clean |",
      ].join("\n"),
    );
    const lint = problems.find((problem) => problem.id === "source:audit:lint");
    expect(lint).toBeDefined();
    expect(lint?.area).toBe("source");
    expect(lint?.detail).toMatch(/12 prettier errors/i);
    expect(lint?.steps?.length).toBeGreaterThanOrEqual(3);
    expect(lint?.fix).toMatch(/approval/i);
    expect(problems.some((problem) => problem.id === "source:audit:typecheck")).toBe(false);
  });

  it("does not treat a clean lint row as a current source problem", () => {
    const problems = problemsFromAuditText(
      [
        "| Check | Command | Result |",
        "| --- | --- | --- |",
        "| Lint | `npm run lint` | clean — 0 errors, 94 react-refresh warnings |",
        "| Types | `npm run typecheck` | clean |",
        "| Tests | `npm test` | 246 files passed |",
      ].join("\n"),
    );
    expect(problems.find((problem) => problem.id === "source:audit:lint")).toBeUndefined();
    expect(problems.find((problem) => problem.id === "source:audit:typecheck")).toBeUndefined();
    expect(problems.find((problem) => problem.id === "source:audit:tests")).toBeUndefined();
  });

  it("uses only the first Lint/Types/Tests verification row, not later dated tables", () => {
    const problems = problemsFromAuditText(
      [
        "| Check | Command | Result |",
        "| --- | --- | --- |",
        "| Lint | `npm run lint` | clean — 0 errors, 94 react-refresh warnings |",
        "| Types | `npm run typecheck` | clean |",
        "| Tests | `npm test` | 246 files passed |",
        "",
        "| Check | Command | Result |",
        "| --- | --- | --- |",
        "| Lint | `npm run lint` | **249 prettier errors** |",
        "| Types | `npm run typecheck` | failed |",
        "| Tests | `npm test` | 12 failed |",
      ].join("\n"),
    );
    expect(problems.find((problem) => problem.id === "source:audit:lint")).toBeUndefined();
    expect(problems.find((problem) => problem.id === "source:audit:typecheck")).toBeUndefined();
    expect(problems.find((problem) => problem.id === "source:audit:tests")).toBeUndefined();
  });

  it("reads the live AUDIT.md table; lint is a problem only when that table still fails", async () => {
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toMatch(/prettier/i);
    const problems = problemsFromAuditText(audit);
    const lint = problems.find((problem) => problem.id === "source:audit:lint");
    const lintRow = audit.match(/\|\s*Lint\s*\|\s*`npm run lint`\s*\|\s*(.+?)\s*\|/);
    const lintFailed = /(?:[1-9]\d*)\s+(prettier\s+)?errors?/i.test(lintRow?.[1] ?? "");
    if (lintFailed) {
      expect(lint).toBeDefined();
    } else {
      expect(lint).toBeUndefined();
    }
    const live = await inspectSourceHealth({
      sources: {
        readText: readWorkspace,
        index: async () => null,
        verify: async () => ({ ok: true, checks: [] }),
      },
    });
    const liveLint = live.find((problem) => problem.id === "source:audit:lint");
    if (lintFailed) expect(liveLint).toBeDefined();
    else expect(liveLint).toBeUndefined();
    const report = inspectSelf();
    expect(report.problems.some((problem) => problem.id === "source:audit:lint")).toBe(lintFailed);
  });

  it("folds unresolved imports from the architecture index", () => {
    const problems = problemsFromArchitectureIndex({
      at: 1,
      root: root,
      totals: { files: 10, edges: 2, broken: 1 },
      areas: {},
      entryPoints: [],
      broken: [{ file: "src/lib/friday/brain/self-diagnosis.ts", specifier: "./missing-mod" }],
      externals: 0,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.id).toBe("source:imports");
    expect(problems[0]?.detail).toMatch(/missing-mod/);
    expect(problems[0]?.steps?.join(" ")).toMatch(/approval/i);
  });

  it("folds failing sandbox verify checks the same way Doctor problems carry steps", () => {
    const problems = problemsFromVerifyResult({
      ok: false,
      checks: [
        {
          id: "typecheck",
          label: "Typecheck",
          ok: false,
          detail: "src/lib/friday/brain/self-diagnosis.ts(1,1): error TS2307: Cannot find module.",
        },
        { id: "tests", label: "Test suite", ok: true, detail: "all tests passed" },
      ],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.id).toBe("source:verify:typecheck");
    expect(problems[0]?.severity).toBe("critical");
    expect(problems[0]?.steps?.[0]).toMatch(/npm run typecheck/);
  });

  it("prefers a live sandbox lint check over a stale AUDIT.md lint row", () => {
    const audit = readFileSync(auditPath, "utf8");
    const live = problemsFromVerifyResult({
      ok: false,
      checks: [{ id: "lint", label: "Lint (ESLint)", ok: false, detail: "3 prettier errors" }],
    });
    const tracked = problemsFromAuditText(audit, new Set(["lint"]));
    expect(live.some((problem) => problem.id === "source:verify:lint")).toBe(true);
    expect(tracked.some((problem) => problem.id === "source:audit:lint")).toBe(false);
  });

  it("files a source fix as a code-change proposal and never applies it", () => {
    const queued = proposeSourceFix({
      id: "source:audit:lint",
      severity: "warning",
      area: "source",
      title: "Lint errors tracked in AUDIT.md",
      detail: "npm run lint — 44 prettier errors",
      fix: "Do not auto-apply.",
      steps: [
        "Run npm run lint",
        "Fix only the files that belong to this change",
        "Approve the proposal",
      ],
    });
    expect(queued.queued).toBe(true);
    expect(queued.stage).toBe("discovered");
    const item = governance.get(queued.id);
    expect(item?.kind).toBe("code-change");
    expect(item?.stage).toBe("discovered");
    expect(item?.stage).not.toBe("applied");
    expect(item?.stage).not.toBe("completed");
    const again = proposeSourceFix({
      id: "source:audit:lint",
      severity: "warning",
      area: "source",
      title: "Lint errors tracked in AUDIT.md",
      detail: "npm run lint — 44 prettier errors",
    });
    expect(again.queued).toBe(false);
  });
});

describe("turn-stage self-diagnosis", () => {
  it("detects a recorded stage timeout, explains it, and only proposes a fix", async () => {
    const { recordStageOutcome, resetStageOutcomes } =
      await import("../../src/lib/friday/brain/turn-timing");
    resetStageOutcomes();
    recordStageOutcome({
      runId: "cognize",
      stage: "web-search",
      ms: 12000,
      extra: "timed out after 12000ms",
      failed: true,
      timedOut: true,
    });
    const report = inspectSelf();
    const found = report.problems.find((problem) => problem.id === "brain:turn-stages");
    expect(found).toBeDefined();
    expect(found?.detail).toMatch(/web-search/);
    expect(found?.fix).toMatch(/approval/i);
    const proposed = proposeSourceFix(found!);
    expect(proposed.stage).toBe("discovered");
    expect(governance.get(proposed.id)?.stage).not.toBe("applied");
    resetStageOutcomes();
  });
});

describe("causal analysis of FRIDAY's own failures", () => {
  it("names a single evidenced finding as root cause and never auto-applies a fix", () => {
    const causal = analyzeOwnFailure({
      problems: [
        {
          id: "brain:turn-stages",
          severity: "warning",
          area: "brain",
          title: "web-search timed out",
          detail: "cognize/web-search: timed out after 12000ms",
          fix: "Ask me to propose a change — it waits for your approval.",
        },
      ],
    });
    expect(causal.stages.map((stage) => stage.id)).toEqual([
      "observe",
      "collect-evidence",
      "dependency-analysis",
      "hypotheses",
      "test-hypotheses",
      "root-cause",
      "impact",
      "repair-options",
      "safest-option",
      "verify",
    ]);
    expect(causal.inconclusive).toBe(false);
    expect(causal.rootCause).toMatch(/web-search timed out/);
    expect(causal.verified).toBe(true);
    expect(causal.safest).toMatch(/governance/i);
    expect(causal.repairOptions.every((option) => option.risk === "ask")).toBe(true);
  });

  it("stays inconclusive when independent areas fail and does not guess", () => {
    const causal = analyzeOwnFailure({
      problems: [
        {
          id: "brain:turn-stages",
          severity: "warning",
          area: "brain",
          title: "web-search timed out",
          detail: "timed out",
        },
        {
          id: "models:none",
          severity: "warning",
          area: "models",
          title: "No model is reachable",
          detail: "available() is empty",
        },
      ],
    });
    expect(causal.inconclusive).toBe(true);
    expect(causal.rootCause).toBeNull();
    expect(causal.reason).toMatch(/will not pick/);
  });

  it("does not invent a root cause when a finding has no store detail", () => {
    const causal = analyzeOwnFailure({
      problems: [
        {
          id: "guess",
          severity: "info",
          area: "brain",
          title: "something might be wrong",
          detail: "   ",
        },
      ],
    });
    expect(causal.inconclusive).toBe(true);
    expect(causal.rootCause).toBeNull();
    expect(causal.hypotheses[0]?.supported).toBe(false);
  });
});

describe("model cooldown diagnosis", () => {
  it("names cooling models as a warning, never as healthy", () => {
    const problems = problemsFromCoolingModels([
      { name: "Cloud GPT", coolingDown: true, healthCategory: "quota_exceeded" },
    ]);
    expect(problems[0]?.id).toBe("models:cooldown");
    expect(problems[0]?.severity).toBe("warning");
    expect(problems[0]?.detail).toMatch(/quota_exceeded/);
  });
});
