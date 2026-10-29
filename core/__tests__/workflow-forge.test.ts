/**
 * Workflow forge: plan → workflow.json with steps → capability-verify sandbox →
 * governance → installPack(). Stays disabled. Runner dry-runs write steps and
 * fails a missing connector honestly.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import {
  blankWorkflowDraft,
  fileWorkflowGapDraft,
  forgeWorkflow,
  looksLikeWorkflowGap,
  resetWorkflowGapDrafts,
  runWorkflowPack,
  saveWorkflowPack,
  type WorkflowForgeHost,
  type WorkflowPackManifest,
  type WorkflowPackWrite,
} from "../../src/lib/friday/brain/workflow-forge";
import type { GovAction, GovItem } from "../../src/lib/friday/self/governance";

const require = createRequire(import.meta.url);
const capabilities = require("../../electron/capabilities.cjs") as {
  installPack: (
    roots: { workspaceRoot: string },
    pack: unknown,
    hint?: string,
  ) => { ok: boolean; id?: string; path?: string; error?: string };
};
const verify = require("../../electron/capability-verify.cjs") as {
  verifyCapability: (
    roots: { root: string },
    pack: { id: string; tree: string; dir: string },
    options?: { allowInstall?: boolean },
  ) => Promise<{ ok: boolean; status?: string; error?: string; mode?: string }>;
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-workflow-forge-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetWorkflowGapDrafts();
});

const GOAL = "build me a workflow that inspects git dirty files then drafts a status";

const DRAFT = {
  name: "Git status wrap",
  slug: "git-status-wrap",
  description: "Inspect dirty files and draft a local status.",
  schedule: "on demand",
  risk: "safe",
  steps: [
    {
      id: "s1",
      label: "Scan git dirty files",
      kind: "agent",
      ref: "agents/core/git-dirty-scanner",
      risk: "safe",
    },
    {
      id: "s2",
      label: "Draft a status line",
      kind: "skill",
      ref: "skills/custom/com-status-update",
      risk: "safe",
    },
    {
      id: "s3",
      label: "Keep the note local",
      kind: "note",
      ref: "record",
      risk: "safe",
    },
  ],
};

async function autoApprove(action: GovAction): Promise<GovItem> {
  const result = await action.apply();
  return {
    id: "gov-test-workflow-forge",
    kind: action.kind,
    title: action.title,
    rationale: action.rationale,
    risk: action.risk,
    evidence: action.evidence ?? [],
    stage: result.ok ? "completed" : "failed",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    logs: [],
    ...(result.ok ? {} : { error: result.detail }),
  };
}

async function sandboxVerify(pack: WorkflowPackWrite) {
  const sandboxRoot = temp();
  const installed = capabilities.installPack({ workspaceRoot: sandboxRoot }, pack, "workflows");
  if (!installed.ok || !installed.id || !installed.path) {
    return { ok: false, error: installed.error || "sandbox installPack failed" };
  }
  const checked = await verify.verifyCapability(
    { root: sandboxRoot },
    { id: installed.id, tree: "workflows", dir: installed.path },
    { allowInstall: false },
  );
  if (!checked.ok) return { ok: false, error: checked.error || "sandbox run failed" };
  return checked.mode ? { ok: true, mode: checked.mode } : { ok: true };
}

function hostFor(ownerRoot: string, extra: Partial<WorkflowForgeHost> = {}): WorkflowForgeHost {
  return {
    complete: async () => ({ ok: true, text: JSON.stringify(DRAFT) }),
    sandboxVerify,
    installPack: async (pack) =>
      capabilities.installPack({ workspaceRoot: ownerRoot }, pack, "workflows"),
    submit: autoApprove,
    ...extra,
  };
}

describe("looksLikeWorkflowGap", () => {
  it("matches an explicit workflow request and ignores greetings and plugins", () => {
    expect(looksLikeWorkflowGap(GOAL)).toBe(true);
    expect(looksLikeWorkflowGap("create me a workflow that cleans downloads")).toBe(true);
    expect(looksLikeWorkflowGap("hello there")).toBe(false);
    expect(looksLikeWorkflowGap("build me a plugin that stamps boot")).toBe(false);
  });
});

describe("fileWorkflowGapDraft", () => {
  it("queues an install proposal and does not write a folder", () => {
    const ownerRoot = temp();
    const draft = fileWorkflowGapDraft(GOAL);
    expect(draft.stage).toBe("planning");
    expect(draft.log.some((line) => /workflow-forge draft/i.test(line.text))).toBe(true);
    expect(fs.existsSync(path.join(ownerRoot, "workflows"))).toBe(false);
  });

  it("core brain files that draft when a genuine workflow gap is asked", async () => {
    resetWorkflowGapDrafts();
    const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
    const cognition = await coreBrain.cognize(GOAL, { mode: "manual" });
    expect(cognition.notes.join(" ")).toMatch(/workflow-forge draft/i);
    expect(cognition.tools.some((tool) => tool.query === "workflow-forge" && !tool.ok)).toBe(true);
  });
});

describe("forgeWorkflow", () => {
  it("fails honestly without a desktop writer or injected host", async () => {
    const run = await forgeWorkflow(GOAL);
    expect(run.stage).toBe("failed");
    expect(run.error).toMatch(/desktop app/i);
    expect(run.log[0]?.ok).toBe(false);
  });

  it("sandbox-verifies then installPack writes workflow.json disabled", async () => {
    const ownerRoot = temp();
    const run = await forgeWorkflow(GOAL, { host: hostFor(ownerRoot) });
    expect(run.stage).toBe("done");
    expect(run.workflowId).toMatch(/workflows\/saved\/git-status-wrap/);
    const file = path.join(ownerRoot, "workflows", "saved", "git-status-wrap", "workflow.json");
    expect(fs.existsSync(file)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(manifest.enabled).toBe(false);
    expect(manifest.steps.length).toBeGreaterThanOrEqual(3);
  });
});

describe("runWorkflowPack", () => {
  const pack: WorkflowPackManifest = {
    id: "workflows/saved/demo-flow",
    name: "Demo flow",
    description: "Test runner",
    category: "office",
    schedule: "on demand",
    enabled: true,
    risk: "safe",
    steps: [
      { id: "s1", label: "Local note", kind: "note", ref: "inspect", risk: "safe" },
      {
        id: "s2",
        label: "Gmail if connected",
        kind: "connector",
        ref: "google-gmail",
        risk: "safe",
      },
      {
        id: "s3",
        label: "Cache trim",
        kind: "agent",
        ref: "agents/core/cache-trim",
        risk: "write",
      },
    ],
  };

  it("runs note steps, fails a missing connector, and dry-runs write steps", async () => {
    const result = await runWorkflowPack(pack.id, {
      dryRun: true,
      host: {
        list: async () => [pack],
        listConnectors: async () => [{ id: "google-gmail", name: "Gmail", connected: false }],
      },
    });
    expect(result.steps[0]?.ok).toBe(true);
    expect(result.steps[1]?.ok).toBe(false);
    expect(result.steps[1]?.detail).toMatch(/not connected/i);
    expect(result.steps[2]?.skipped).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("passes the previous step output into the next invoke prompt", async () => {
    const prompts: string[] = [];
    const result = await runWorkflowPack(pack.id, {
      dryRun: true,
      prompt: "start",
      host: {
        list: async () => [
          {
            ...pack,
            steps: [
              { id: "s1", label: "Local note", kind: "note", ref: "inspect", risk: "safe" },
              {
                id: "s2",
                label: "Skill follow",
                kind: "skill",
                ref: "skills/custom/demo",
                risk: "safe",
              },
            ],
          },
        ],
        invokeSkill: async (_id, input) => {
          prompts.push(String((input as { prompt?: string } | undefined)?.prompt || ""));
          return { ok: true, value: "skill-ok" };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(prompts[0]).toMatch(/Previous step output/);
  });
});

describe("saveWorkflowPack", () => {
  it("writes a visual draft as workflow.json disabled without a coder model", async () => {
    const ownerRoot = temp();
    const draft = blankWorkflowDraft("Visual desk wrap");
    draft.steps[0]!.label = "Look at the desk";
    const run = await saveWorkflowPack(draft, {
      host: {
        installPack: async (pack) =>
          capabilities.installPack({ workspaceRoot: ownerRoot }, pack, "workflows"),
        sandboxVerify: async () => ({ ok: true, mode: "manifest" }),
        submit: autoApprove,
        complete: async () => ({ ok: false, error: "coder must not run" }),
      },
    });
    expect(run.stage).toBe("done");
    expect(run.workflowId).toMatch(/workflows\/saved\/visual-desk-wrap/);
    const file = path.join(ownerRoot, "workflows", "saved", "visual-desk-wrap", "workflow.json");
    expect(fs.existsSync(file)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(manifest.enabled).toBe(false);
    expect(manifest.steps[0]?.label).toBe("Look at the desk");
  });
});
