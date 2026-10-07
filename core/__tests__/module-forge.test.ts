/**
 * Module forge: plan → manifest + Python entry → capability-verify sandbox →
 * governance → installPack(). Stays disabled. Same install kind as agent-forge.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import {
  fileModuleGapDraft,
  forgeModule,
  looksLikeModuleGap,
  resetModuleGapDrafts,
  type ModuleForgeHost,
  type ModulePackWrite,
} from "../../src/lib/friday/brain/module-forge";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-module-forge-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetModuleGapDrafts();
});

const GOAL = "build me a module that lists CSV columns in a folder";

const CODE = `MANIFEST = None

def register(manifest):
    global MANIFEST
    MANIFEST = manifest

async def run(tools, folder="."):
    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    return {"ok": True, "dryRun": True, "entries": listing.get("entries", [])}

def self_test(payload=None):
    return {"ok": True, "loaded": True}
`;

const DRAFT = {
  name: "CSV column lister",
  slug: "csv-column-lister",
  description: "List CSV files in a folder via fs.read. Dry-run inspect only.",
  permissions: ["fs.read"],
  entry: "main.py",
  ui: { page: "CSV columns", icon: "table" },
  code: CODE,
};

async function autoApprove(action: GovAction): Promise<GovItem> {
  const result = await action.apply();
  return {
    id: "gov-test-module-forge",
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
    id: "gov-test-module-forge",
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

async function sandboxVerify(pack: ModulePackWrite) {
  const sandboxRoot = temp();
  const installed = capabilities.installPack({ workspaceRoot: sandboxRoot }, pack, "modules");
  if (!installed.ok || !installed.id || !installed.path) {
    return { ok: false, error: installed.error || "sandbox installPack failed" };
  }
  const checked = await verify.verifyCapability(
    { root: sandboxRoot },
    { id: installed.id, tree: "modules", dir: installed.path },
    { allowInstall: false },
  );
  if (!checked.ok) return { ok: false, error: checked.error || "sandbox run failed" };
  return checked.mode ? { ok: true, mode: checked.mode } : { ok: true };
}

function hostFor(ownerRoot: string, extra: Partial<ModuleForgeHost> = {}): ModuleForgeHost {
  return {
    complete: async () => ({ ok: true, text: JSON.stringify(DRAFT) }),
    sandboxVerify,
    installPack: async (pack) =>
      capabilities.installPack({ workspaceRoot: ownerRoot }, pack, "modules"),
    submit: autoApprove,
    ...extra,
  };
}

describe("looksLikeModuleGap", () => {
  it("matches an explicit module request and ignores greetings and skills", () => {
    expect(looksLikeModuleGap(GOAL)).toBe(true);
    expect(looksLikeModuleGap("create me a module that inspects logs")).toBe(true);
    expect(looksLikeModuleGap("hello there")).toBe(false);
    expect(looksLikeModuleGap("build me a skill that counts words")).toBe(false);
    expect(looksLikeModuleGap("build me an agent that files invoices")).toBe(false);
  });
});

describe("fileModuleGapDraft", () => {
  it("queues an install proposal and does not write a folder", () => {
    const ownerRoot = temp();
    const draft = fileModuleGapDraft(GOAL);
    expect(draft.stage).toBe("planning");
    expect(draft.log.some((line) => /module-forge draft/i.test(line.text))).toBe(true);
    expect(fs.existsSync(path.join(ownerRoot, "modules"))).toBe(false);
  });

  it("core brain files that draft when a genuine module gap is asked", async () => {
    resetModuleGapDrafts();
    const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
    const cognition = await coreBrain.cognize(GOAL, { mode: "manual" });
    expect(cognition.notes.join(" ")).toMatch(/module-forge draft/i);
    expect(cognition.tools.some((tool) => tool.query === "module-forge" && !tool.ok)).toBe(true);
  });
});

describe("forgeModule", () => {
  it("fails honestly without a desktop writer or injected host", async () => {
    const run = await forgeModule(GOAL);
    expect(run.stage).toBe("failed");
    expect(run.error).toMatch(/desktop app/i);
    expect(run.log[0]?.ok).toBe(false);
  });

  it("does not install when the owner rejects the governance gate", async () => {
    const ownerRoot = temp();
    const run = await forgeModule(GOAL, {
      host: hostFor(ownerRoot, { submit: rejected }),
    });
    expect(run.stage).toBe("failed");
    expect(run.error).toMatch(/did not approve/i);
    expect(fs.existsSync(path.join(ownerRoot, "modules"))).toBe(false);
  });

  it("sandbox-verifies then installs a disabled module pack", async () => {
    const ownerRoot = temp();
    const run = await forgeModule(GOAL, { host: hostFor(ownerRoot) });
    expect(run.stage, run.error).toBe("done");
    expect(run.moduleId).toMatch(/^modules\//);
    const dir = path.join(ownerRoot, "modules", "custom", "csv-column-lister");
    expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "main.py"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest.enabled).toBe(false);
    expect(manifest.entry).toBe("main.py");
    expect(manifest.ui.page).toBe("CSV columns");
  }, 60000);
});
