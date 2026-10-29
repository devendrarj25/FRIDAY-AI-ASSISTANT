/**
 * Agent forge: plan → manifest (reuse installed skills) → capability-verify
 * sandbox → governance → installPack(). Never invents skill code. The owner
 * copy stays disabled. Extra file vs the prompt's list — needed to prove a
 * real folder lands on disk.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import {
  fileAgentGapDraft,
  forgeAgent,
  looksLikeAgentGap,
  resetAgentGapDrafts,
  type AgentForgeHost,
  type AgentPackWrite,
} from "../../src/lib/friday/brain/agent-forge";
import { listSkills } from "../../src/lib/friday/brain/skill-forge";
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
  smokeTest: (args: {
    root: string;
    dir: string;
    tree: string;
  }) => Promise<{ ok: boolean; mode?: string; output?: string }>;
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-agent-forge-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetAgentGapDrafts();
});

const TENDER_GOAL = "build me an agent that summarises today's tender deadlines";

const TENDER_MANIFEST = {
  name: "Tender deadline summariser",
  slug: "tender-deadline-summariser",
  description: "Summarise today's tender deadlines from installed tender and summary skills.",
  role: "Summarise today's tender deadlines for the owner",
  skills: ["tender.read", "desk.summary"],
  permissions: ["files"],
  risk: "safe",
};

async function autoApprove(action: GovAction): Promise<GovItem> {
  const result = await action.apply();
  return {
    id: "gov-test-agent-forge",
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

function rejected(): Promise<GovItem> {
  return Promise.resolve({
    id: "gov-test-agent-forge",
    kind: "install",
    title: "rejected",
    rationale: "test",
    risk: "review",
    evidence: [],
    stage: "rejected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    logs: [],
  });
}

async function sandboxVerify(pack: AgentPackWrite) {
  const sandboxRoot = temp();
  const installed = capabilities.installPack({ workspaceRoot: sandboxRoot }, pack, "agents");
  if (!installed.ok || !installed.id || !installed.path) {
    return { ok: false, error: installed.error || "sandbox installPack failed" };
  }
  const checked = await verify.verifyCapability(
    { root: sandboxRoot },
    { id: installed.id, tree: "agents", dir: installed.path },
    { allowInstall: false },
  );
  if (!checked.ok) return { ok: false, error: checked.error || "sandbox run failed" };
  return checked.mode ? { ok: true, mode: checked.mode } : { ok: true };
}

function hostFor(ownerRoot: string, extra: Partial<AgentForgeHost> = {}): AgentForgeHost {
  return {
    complete: async () => ({ ok: true, text: JSON.stringify(TENDER_MANIFEST) }),
    listInstalledSkills: async () => {
      const skills = await listSkills();
      return skills.map((item) => ({ id: item.id, name: item.name }));
    },
    sandboxVerify,
    installPack: async (pack) =>
      capabilities.installPack({ workspaceRoot: ownerRoot }, pack, "agents"),
    submit: autoApprove,
    ...extra,
  };
}

describe("looksLikeAgentGap", () => {
  it("matches an explicit agent request and ignores greetings", () => {
    expect(looksLikeAgentGap(TENDER_GOAL)).toBe(true);
    expect(looksLikeAgentGap("create me an agent that files invoices")).toBe(true);
    expect(looksLikeAgentGap("hello there")).toBe(false);
    expect(looksLikeAgentGap("build me a skill that counts words")).toBe(false);
  });
});

describe("fileAgentGapDraft", () => {
  it("queues an install proposal and does not write a folder", () => {
    const ownerRoot = temp();
    const draft = fileAgentGapDraft(TENDER_GOAL);
    expect(draft.stage).toBe("planning");
    expect(draft.log.some((line) => /agent-forge draft/i.test(line.text))).toBe(true);
    expect(fs.existsSync(path.join(ownerRoot, "agents"))).toBe(false);
  });

  it("core brain files that draft when a genuine agent gap is asked", async () => {
    resetAgentGapDrafts();
    const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
    const cognition = await coreBrain.cognize(TENDER_GOAL, { mode: "manual" });
    expect(cognition.notes.join(" ")).toMatch(/agent-forge draft/i);
    expect(cognition.tools.some((tool) => tool.query === "agent-forge" && !tool.ok)).toBe(true);
  });
});

describe("forgeAgent", () => {
  it("fails honestly without a desktop writer or injected host", async () => {
    const run = await forgeAgent(TENDER_GOAL);
    expect(run.stage).toBe("failed");
    expect(run.error).toMatch(/desktop app/i);
    expect(run.log[0]?.ok).toBe(false);
  });

  it("stops when a needed skill is not installed and writes nothing", async () => {
    const ownerRoot = temp();
    let installed = 0;
    const run = await forgeAgent(TENDER_GOAL, {
      host: hostFor(ownerRoot, {
        complete: async () => ({
          ok: true,
          text: JSON.stringify({
            name: "Invented",
            role: "do the job",
            skills: ["not-a-real-skill"],
            permissions: [],
            risk: "safe",
          }),
        }),
        installPack: async (pack) => {
          installed += 1;
          return capabilities.installPack({ workspaceRoot: ownerRoot }, pack, "agents");
        },
      }),
    });
    expect(run.stage).toBe("failed");
    expect(run.error).toMatch(/not-a-real-skill/);
    expect(run.log.some((line) => line.text.includes("Writing the agent"))).toBe(true);
    expect(run.log.some((line) => /Verifying in the sandbox/.test(line.text))).toBe(false);
    expect(installed).toBe(0);
    expect(fs.existsSync(path.join(ownerRoot, "agents"))).toBe(false);
  });

  it("does not install when the owner rejects the governance gate", async () => {
    const ownerRoot = temp();
    const run = await forgeAgent(TENDER_GOAL, {
      host: hostFor(ownerRoot, { submit: rejected }),
    });
    expect(run.stage).toBe("failed");
    expect(run.error).toMatch(/did not approve/i);
    expect(run.log.some((line) => /Waiting for your approval/.test(line.text))).toBe(true);
    expect(fs.existsSync(path.join(ownerRoot, "agents", "installed"))).toBe(false);
  });

  it("retries a sandbox failure once, matching skill-forge's default bound", async () => {
    const ownerRoot = temp();
    let verifies = 0;
    const run = await forgeAgent(TENDER_GOAL, {
      maxAttempts: 3,
      host: hostFor(ownerRoot, {
        sandboxVerify: async (pack) => {
          verifies += 1;
          if (verifies === 1) return { ok: false, error: "sandbox exploded on purpose" };
          return sandboxVerify(pack);
        },
      }),
    });
    expect(verifies).toBe(2);
    expect(run.attempts).toBe(2);
    expect(run.stage).toBe("done");
    expect(run.log.some((line) => /sandbox exploded on purpose/.test(line.text))).toBe(true);
  });

  it("forges a tender-deadline agent: disabled folder, real capability-verify", async () => {
    const ownerRoot = temp();
    const installed = await listSkills();
    expect(installed.some((item) => item.id === "tender.read")).toBe(true);
    expect(installed.some((item) => item.id === "desk.summary")).toBe(true);

    const stages: string[] = [];
    const run = await forgeAgent(TENDER_GOAL, {
      id: "tender-deadline-summariser",
      host: hostFor(ownerRoot),
      onProgress: (next) => stages.push(next.stage),
    });

    expect(run.stage).toBe("done");
    expect(run.agentId).toBe("agents/installed/tender-deadline-summariser");
    expect(run.pipeline).toBeTruthy();
    expect(run.log.some((line) => /^Planned with /.test(line.text) && line.ok)).toBe(true);
    expect(run.log.some((line) => /Writing the agent/.test(line.text) && line.ok)).toBe(true);
    expect(run.log.some((line) => /Verifying in the sandbox/.test(line.text) && line.ok)).toBe(
      true,
    );
    expect(run.log.some((line) => /Sandbox run passed/.test(line.text) && line.ok)).toBe(true);
    expect(run.log.some((line) => /Waiting for your approval/.test(line.text) && line.ok)).toBe(
      true,
    );
    expect(
      run.log.some((line) =>
        /Installed as agents\/installed\/tender-deadline-summariser/.test(line.text),
      ),
    ).toBe(true);
    expect(run.log.every((line) => line.ok || /sandbox exploded/.test(line.text))).toBe(true);
    expect(stages).toContain("planning");
    expect(stages).toContain("writing");
    expect(stages).toContain("verifying");
    expect(stages).toContain("installing");
    expect(stages).toContain("done");

    const dir = path.join(ownerRoot, "agents", "installed", "tender-deadline-summariser");
    const manifestPath = path.join(dir, "manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      enabled: boolean;
      verification?: { status?: string };
      role?: string;
      skills?: string[];
      id?: string;
    };
    expect(manifest.enabled).toBe(false);
    expect(manifest.verification?.status).toBe("pending");
    expect(manifest.role).toBe("Summarise today's tender deadlines for the owner");
    expect(manifest.skills).toEqual(["tender.read", "desk.summary"]);
    expect(manifest.id).toBe("agents/installed/tender-deadline-summariser");

    const checked = await verify.verifyCapability(
      { root: ownerRoot },
      { id: "agents/installed/tender-deadline-summariser", tree: "agents", dir },
      { allowInstall: false },
    );
    expect(checked.ok).toBe(true);
    expect(checked.mode).toBe("manifest");
    const still = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { enabled: boolean };
    expect(still.enabled).toBe(false);

    const smoked = await verify.smokeTest({ root: ownerRoot, dir, tree: "agents" });
    expect(smoked.ok).toBe(true);
    expect(smoked.mode).toBe("manifest");

    const evidence = {
      stage: run.stage,
      agentId: run.agentId,
      attempts: run.attempts,
      log: run.log.map((line) => ({ text: line.text, ok: line.ok })),
      manifest,
      capabilityVerify: { ok: checked.ok, mode: checked.mode },
      smokeTest: { ok: smoked.ok, mode: smoked.mode, output: smoked.output ?? null },
    };
    const evidencePath = path.join(ownerRoot, "forge-evidence.json");
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    fs.writeFileSync(path.join(ownerRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
    // Stash outside afterEach cleanup so the session can copy walkthrough artifacts.
    const stash = path.join(os.tmpdir(), "friday-agent-forge-evidence");
    fs.mkdirSync(stash, { recursive: true });
    fs.writeFileSync(
      path.join(stash, "agent_forge_tender_run.json"),
      JSON.stringify(evidence, null, 2),
    );
    fs.writeFileSync(
      path.join(stash, "agent_forge_tender_manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  }, 60000);

  it("keeps only installed workflow ids on a forged agent", async () => {
    const ownerRoot = temp();
    const run = await forgeAgent(TENDER_GOAL, {
      host: hostFor(ownerRoot, {
        complete: async () => ({
          ok: true,
          text: JSON.stringify({
            ...TENDER_MANIFEST,
            workflows: ["workflows/saved/morning-briefing", "workflows/saved/not-real"],
          }),
        }),
        listInstalledWorkflows: async () => [
          { id: "workflows/saved/morning-briefing", name: "Morning briefing chain" },
        ],
      }),
    });
    expect(run.stage).toBe("done");
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(ownerRoot, "agents", "installed", "tender-deadline-summariser", "manifest.json"),
        "utf8",
      ),
    ) as { workflows?: string[] };
    expect(manifest.workflows).toEqual(["workflows/saved/morning-briefing"]);
  });
});
