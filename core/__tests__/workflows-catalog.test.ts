/**
 * Shipped workflow catalog: each pack has workflow.json with real sequential
 * steps over existing FRIDAY skills/tools/agents/modules/connectors. All stay
 * enabled: false. No social-post packs.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const capabilities = require_(path.join(ROOT, "electron/capabilities.cjs")) as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: {
      id: string;
      tree: string;
      enabled: boolean;
      steps?: { id: string; label: string; kind: string; ref: string }[];
      schedule?: string;
    }[];
  };
};

function walkWorkflowJson(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkWorkflowJson(full, out);
    else if (entry.name === "workflow.json") out.push(full);
  }
  return out;
}

describe("shipped workflow catalog", () => {
  const files = walkWorkflowJson(path.join(ROOT, "workflows"));

  it("ships at least 80 real workflow.json packs, all disabled, with long step chains", () => {
    expect(files.length).toBeGreaterThanOrEqual(110);
    const ids = new Set<string>();
    for (const file of files) {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as {
        enabled?: boolean;
        id?: string;
        name?: string;
        steps?: unknown[];
        schedule?: string;
        author?: string;
      };
      expect(manifest.enabled, file).toBe(false);
      expect(Array.isArray(manifest.steps) && manifest.steps.length >= 3, file).toBe(true);
      expect(String(manifest.schedule || "").trim(), file).toBeTruthy();
      expect(ids.has(manifest.id || ""), `${manifest.id} duplicate`).toBe(false);
      ids.add(String(manifest.id));
      expect(String(manifest.author || "")).toMatch(/FRIDAY library/i);
      const blob = `${manifest.id} ${manifest.name}`.toLowerCase();
      expect(blob).not.toMatch(/^(twitter|instagram|facebook|linkedin)/);
      expect(blob).not.toMatch(/social media posting/);
    }
    const long = files.filter((file) => {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as { steps?: unknown[] };
      return (manifest.steps || []).length >= 8;
    });
    expect(long.length).toBeGreaterThanOrEqual(20);
  });

  it("lists every shipped workflow from appRoot and none are enabled", () => {
    const { items } = capabilities.list({ appRoot: ROOT, workspaceRoot: null });
    const packs = items.filter((item) => item.tree === "workflows");
    expect(packs.length).toBeGreaterThanOrEqual(110);
    expect(packs.every((item) => item.enabled === false)).toBe(true);
    expect(packs.every((item) => (item.steps || []).length >= 3)).toBe(true);
    expect(packs.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "workflows/saved/morning-briefing",
        "workflows/saved/workspace-cleanup",
        "workflows/saved/self-health",
        "workflows/saved/evening-wrapup",
        "workflows/saved/tender-filename-go-nogo",
        "workflows/saved/weekly-life-review",
        "workflows/saved/construction-weekly-pack",
        "workflows/saved/pre-commit-hygiene-chain",
      ]),
    );
  });

  it("exposes steps and schedule through normalize so the page can draw the diagram", () => {
    const { items } = capabilities.list({ appRoot: ROOT, workspaceRoot: null });
    const morning = items.find((item) => item.id === "workflows/saved/morning-briefing");
    expect(morning?.schedule).toMatch(/daily/i);
    expect(morning?.steps?.some((step) => step.kind === "agent")).toBe(true);
    expect(morning?.steps?.some((step) => step.kind === "connector")).toBe(true);
  });
});
