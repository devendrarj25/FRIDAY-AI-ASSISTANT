import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { collectModules, PIPELINE, TREE_MODULES } from "../registry";
import { updatesModule } from "../../plugins/updates";

const require = createRequire(import.meta.url);
const capabilities = require("../../electron/capabilities.cjs") as {
  list: (roots: { appRoot?: string; workspaceRoot?: string }) => {
    items: {
      id: string;
      tree: string;
      enabled: boolean;
      origin: string;
      risk: string;
      summary?: string;
      inputs?: string[];
    }[];
    counts: Record<string, { total: number; enabled: number }>;
  };
  setEnabled: (roots: { workspaceRoot?: string }, id: string, enabled: boolean) => { ok: boolean };
};

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-caps-"));
  const skill = path.join(root, "skills", "custom", "summarize");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(
    path.join(skill, "manifest.json"),
    JSON.stringify({
      name: "Summarize",
      version: "1.2.0",
      risk: "safe",
      permissions: ["fs.read"],
      summary: "Condense text",
      inputs: ["text"],
    }),
  );
  const tool = path.join(root, "tools", "system", "shell");
  fs.mkdirSync(tool, { recursive: true });
  fs.writeFileSync(
    path.join(tool, "manifest.json"),
    JSON.stringify({ name: "Shell", risk: "exec" }),
  );
  // A folder with no manifest and no entry file must be ignored, not invented.
  fs.mkdirSync(path.join(root, "tools", "system", "empty"), { recursive: true });
  return root;
}

describe("capability discovery", () => {
  it("finds real manifests on disk and ignores empty folders", () => {
    const root = tempWorkspace();
    const { items, counts } = capabilities.list({ workspaceRoot: root });
    const ids = items.map((i) => i.id);
    expect(ids).toContain("skills/custom/summarize");
    expect(ids).toContain("tools/system/shell");
    expect(ids).not.toContain("tools/system/empty");
    expect(counts["skills"]?.total).toBe(1);
    expect(items.find((i) => i.id === "tools/system/shell")?.risk).toBe("exec");
    expect(items.find((i) => i.id === "skills/custom/summarize")?.summary).toBe("Condense text");
    expect(items.find((i) => i.id === "skills/custom/summarize")?.inputs).toEqual(["text"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists enabled state across scans", () => {
    const root = tempWorkspace();
    expect(
      capabilities.setEnabled({ workspaceRoot: root }, "skills/custom/summarize", false).ok,
    ).toBe(true);
    const after = capabilities.list({ workspaceRoot: root });
    expect(after.items.find((i) => i.id === "skills/custom/summarize")?.enabled).toBe(false);
    expect(fs.existsSync(path.join(root, "config", "capabilities.json"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses to toggle without a workspace root instead of failing silently", () => {
    expect(capabilities.setEnabled({}, "skills/custom/summarize", false).ok).toBe(false);
  });
});

describe("module auto-registration", () => {
  it("collects folder modules into the boot pipeline without duplicates", () => {
    expect(TREE_MODULES.length).toBeGreaterThan(40);
    const ids = PIPELINE.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mod of TREE_MODULES) expect(typeof mod.init).toBe("function");
  });

  it("ignores barrel exports that are not modules", () => {
    expect(collectModules({ helper: () => 1, value: 42 })).toEqual([]);
  });

  it("registers the plugins/updates segment the barrel already exports", () => {
    expect(updatesModule.id).toBe("plugins/updates");
    expect(typeof updatesModule.init).toBe("function");
    expect(TREE_MODULES.some((mod) => mod.id === "plugins/updates")).toBe(true);
    // Runtime download staging is <root>/updates. The ignore must stay anchored
    // there so this source folder can be committed.
    const ignore = fs.readFileSync(path.resolve(".gitignore"), "utf8").split("\n");
    expect(ignore).toContain("/updates/");
    expect(ignore).not.toContain("updates/");
  });
});
