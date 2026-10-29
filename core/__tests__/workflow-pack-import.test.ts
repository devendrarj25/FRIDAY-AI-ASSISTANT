/**
 * Workflow-page import: only workflow-shaped packs, install still goes through
 * installPack() writing workflow.json, and a skill folder is refused.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const workflowPack = require("../../electron/workflow-pack.cjs") as {
  looksLikeWorkflow: (pack: unknown) => boolean;
  healWorkflowPack: (pack: unknown) => {
    ok: boolean;
    pack?: {
      tree?: string;
      id?: string;
      enabled?: boolean;
      steps?: unknown[];
      healed?: boolean;
    };
    error?: string;
  };
  prepareWorkflowsOnly: (
    payload: unknown,
    extra?: { nonWorkflowKinds?: string[] },
  ) => { ok: boolean; packs?: { id?: string; enabled?: boolean }[]; error?: string };
  collectWorkflowPacksFromDir: (dir: string) => {
    packs: { id?: string }[];
    nonWorkflowKinds: string[];
  };
};
const capabilities = require("../../electron/capabilities.cjs") as {
  installPack: (
    roots: { workspaceRoot: string },
    pack: unknown,
    hint?: string,
  ) => { ok: boolean; id?: string; tree?: string; path?: string; error?: string };
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-workflow-pack-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ROOT = path.resolve(__dirname, "../..");
const WORKFLOW_DIR = path.join(ROOT, "workflows", "saved", "morning-briefing");
const SKILL_DIR = path.join(ROOT, "skills", "custom", "wrt-headlines");

describe("workflow-pack heal and workflows-only prepare", () => {
  it("heals an incomplete workflow into workflow.json shape, still disabled", () => {
    const healed = workflowPack.healWorkflowPack({
      name: "Scratch flow",
      schedule: "on demand",
    });
    expect(healed.ok).toBe(true);
    expect(healed.pack?.tree).toBe("workflows");
    expect(healed.pack?.enabled).toBe(false);
    expect((healed.pack?.steps || []).length).toBeGreaterThanOrEqual(3);
    expect(healed.pack?.healed).toBe(true);
  });

  it("collects a real shipped workflow and installPack writes workflow.json disabled", () => {
    const dir = temp();
    fs.cpSync(WORKFLOW_DIR, path.join(dir, "morning-briefing"), { recursive: true });
    const collected = workflowPack.collectWorkflowPacksFromDir(dir);
    expect(collected.packs.length).toBeGreaterThanOrEqual(1);
    const prepared = workflowPack.prepareWorkflowsOnly(collected.packs, {
      nonWorkflowKinds: collected.nonWorkflowKinds,
    });
    expect(prepared.ok).toBe(true);
    const workspace = temp();
    const written = capabilities.installPack(
      { workspaceRoot: workspace },
      (prepared.packs || [])[0],
      "workflows",
    );
    expect(written.ok, written.error).toBe(true);
    expect(written.tree).toBe("workflows");
    expect(fs.existsSync(path.join(written.path || "", "workflow.json"))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(written.path || "", "workflow.json"), "utf8"),
    );
    expect(manifest.enabled).toBe(false);
    expect(Array.isArray(manifest.steps) && manifest.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a skill folder on the Workflows importer", () => {
    const dir = temp();
    fs.cpSync(SKILL_DIR, path.join(dir, "wrt-headlines"), { recursive: true });
    const collected = workflowPack.collectWorkflowPacksFromDir(dir);
    expect(collected.nonWorkflowKinds).toContain("skills");
    const prepared = workflowPack.prepareWorkflowsOnly(collected.packs, {
      nonWorkflowKinds: collected.nonWorkflowKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected a Skills pack/i);
  });

  it("collects a friday.pack.json with steps and heals a raw id+steps object", () => {
    const dir = temp();
    fs.writeFileSync(
      path.join(dir, "friday.pack.json"),
      JSON.stringify({
        name: "Desk wrap",
        steps: [
          { id: "s1", label: "Inspect", kind: "note", ref: "inspect", risk: "safe" },
          { id: "s2", label: "Record", kind: "note", ref: "record", risk: "safe" },
          { id: "s3", label: "Wrap", kind: "note", ref: "wrap", risk: "safe" },
        ],
      }),
    );
    const collected = workflowPack.collectWorkflowPacksFromDir(dir);
    expect(collected.packs.some((item) => item.id === "desk-wrap")).toBe(true);
    const prepared = workflowPack.prepareWorkflowsOnly({
      id: "raw-desk",
      steps: [{ label: "Inspect" }, { label: "Record" }, { label: "Wrap" }],
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.packs?.[0]?.enabled).toBe(false);
  });
});

describe("main process wires prepareWorkflowsOnly", () => {
  it("installCapabilityPayload and classified source mention workflows", () => {
    const main = fs.readFileSync(path.join(ROOT, "electron/main.cjs"), "utf8");
    expect(main).toContain("workflowPack.prepareWorkflowsOnly");
    expect(main).toContain("collectWorkflowPacksFromDir");
    expect(main).toContain("capabilities:install-workflow-zip");
  });
});
