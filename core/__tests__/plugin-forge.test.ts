/**
 * Plugin forge: plan → plugin.json + CJS hooks → capability-verify sandbox →
 * governance → installPack(). Stays disabled. Same install kind as module-forge.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import {
  filePluginGapDraft,
  forgePlugin,
  looksLikePluginGap,
  resetPluginGapDrafts,
  type PluginForgeHost,
  type PluginPackWrite,
} from "../../src/lib/friday/brain/plugin-forge";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugin-forge-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetPluginGapDrafts();
});

const GOAL = "build me a plugin that logs each finished chat turn";

const CODE = `module.exports = {
  register() {},
  "on-turn-complete": async function (payload, ctx) {
    ctx.fs.writeFile("last-hook.json", JSON.stringify({ at: Date.now(), payload }, null, 2));
    return { ok: true };
  },
  selfTest() { return { ok: true, loaded: true }; },
};
`;

const DRAFT = {
  name: "Turn logger",
  slug: "turn-logger",
  description: "Log on-turn-complete into plugin data.",
  permissions: [],
  hooks: ["on-turn-complete"],
  entry: "index.cjs",
  code: CODE,
};

async function autoApprove(action: GovAction): Promise<GovItem> {
  const result = await action.apply();
  return {
    id: "gov-test-plugin-forge",
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
    id: "gov-test-plugin-forge",
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

async function sandboxVerify(pack: PluginPackWrite) {
  const sandboxRoot = temp();
  const installed = capabilities.installPack({ workspaceRoot: sandboxRoot }, pack, "plugins");
  if (!installed.ok || !installed.id || !installed.path) {
    return { ok: false, error: installed.error || "sandbox installPack failed" };
  }
  const checked = await verify.verifyCapability(
    { root: sandboxRoot },
    { id: installed.id, tree: "plugins", dir: installed.path },
    { allowInstall: false },
  );
  if (!checked.ok) return { ok: false, error: checked.error || "sandbox run failed" };
  return checked.mode ? { ok: true, mode: checked.mode } : { ok: true };
}

function hostFor(ownerRoot: string, extra: Partial<PluginForgeHost> = {}): PluginForgeHost {
  return {
    complete: async () => ({ ok: true, text: JSON.stringify(DRAFT) }),
    sandboxVerify,
    installPack: async (pack) =>
      capabilities.installPack({ workspaceRoot: ownerRoot }, pack, "plugins"),
    submit: autoApprove,
    ...extra,
  };
}

describe("looksLikePluginGap", () => {
  it("matches an explicit plugin request and ignores greetings and modules", () => {
    expect(looksLikePluginGap(GOAL)).toBe(true);
    expect(looksLikePluginGap("create me a plugin that stamps boot")).toBe(true);
    expect(looksLikePluginGap("hello there")).toBe(false);
    expect(looksLikePluginGap("build me a module that inspects logs")).toBe(false);
  });
});

describe("filePluginGapDraft", () => {
  it("queues an install proposal and does not write a folder", () => {
    const ownerRoot = temp();
    const draft = filePluginGapDraft(GOAL);
    expect(draft.stage).toBe("planning");
    expect(draft.log.some((line) => /plugin-forge draft/i.test(line.text))).toBe(true);
    expect(fs.existsSync(path.join(ownerRoot, "plugins"))).toBe(false);
  });

  it("core brain files that draft when a genuine plugin gap is asked", async () => {
    resetPluginGapDrafts();
    const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
    const cognition = await coreBrain.cognize(GOAL, { mode: "manual" });
    expect(cognition.notes.join(" ")).toMatch(/plugin-forge draft/i);
    expect(cognition.tools.some((tool) => tool.query === "plugin-forge" && !tool.ok)).toBe(true);
  });
});

describe("forgePlugin", () => {
  it("fails honestly without a desktop writer or injected host", async () => {
    const run = await forgePlugin(GOAL);
    expect(run.stage).toBe("failed");
    expect(run.error).toMatch(/desktop app/i);
    expect(run.log[0]?.ok).toBe(false);
  });

  it("does not install when the owner rejects the governance gate", async () => {
    const ownerRoot = temp();
    const run = await forgePlugin(GOAL, {
      host: hostFor(ownerRoot, { submit: rejected }),
    });
    expect(run.stage).toBe("failed");
    expect(run.error).toMatch(/did not approve/i);
    expect(fs.existsSync(path.join(ownerRoot, "plugins"))).toBe(false);
  });

  it("sandbox-verifies then installs a disabled plugin pack", async () => {
    const ownerRoot = temp();
    const run = await forgePlugin(GOAL, { host: hostFor(ownerRoot) });
    expect(run.stage, run.error).toBe("done");
    expect(run.pluginId).toMatch(/^plugins\//);
    const dir = path.join(ownerRoot, "plugins", "installed", "turn-logger");
    expect(fs.existsSync(path.join(dir, "plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "index.cjs"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
    expect(manifest.enabled).toBe(false);
    expect(manifest.hooks).toContain("on-turn-complete");
    expect(manifest.entry).toBe("index.cjs");
  }, 60000);
});
