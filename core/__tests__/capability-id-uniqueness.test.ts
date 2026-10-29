/**
 * Combined skills + tools + agents + modules + plugins discovery ids must be unique.
 * Fresh-install listing (appRoot only, no workspace) must already include
 * every shipped pack.
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
      risk: string;
      origin: string;
    }[];
  };
};

function walkNamed(dir: string, filename: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkNamed(full, filename, out);
    else if (entry.name === filename) out.push(full);
  }
  return out;
}

describe("combined capability ids and fresh-install listing", () => {
  it("has unique discovery ids across skills, tools, agents, modules, plugins, and workflows", () => {
    const skillFiles = walkNamed(path.join(ROOT, "skills"), "skill.json").filter(
      (file) => !file.includes(`${path.sep}node_modules${path.sep}`),
    );
    const toolFiles = walkNamed(path.join(ROOT, "tools"), "tool.json");
    const agentFiles = fs
      .readdirSync(path.join(ROOT, "agents", "core"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(ROOT, "agents", "core", entry.name, "manifest.json"))
      .filter((file) => fs.existsSync(file));
    const moduleFiles = walkNamed(path.join(ROOT, "modules"), "manifest.json");
    const pluginFiles = walkNamed(path.join(ROOT, "plugins"), "plugin.json");
    const workflowFiles = walkNamed(path.join(ROOT, "workflows"), "workflow.json");

    const ids: string[] = [];
    for (const file of skillFiles) {
      const rel = path.relative(path.join(ROOT, "skills"), path.dirname(file)).replace(/\\/g, "/");
      ids.push(`skills/${rel}`);
    }
    for (const file of toolFiles) {
      const rel = path.relative(path.join(ROOT, "tools"), path.dirname(file)).replace(/\\/g, "/");
      ids.push(`tools/${rel}`);
    }
    for (const file of agentFiles) {
      ids.push(`agents/core/${path.basename(path.dirname(file))}`);
    }
    for (const file of moduleFiles) {
      const rel = path.relative(path.join(ROOT, "modules"), path.dirname(file)).replace(/\\/g, "/");
      ids.push(`modules/${rel}`);
    }
    for (const file of pluginFiles) {
      const rel = path.relative(path.join(ROOT, "plugins"), path.dirname(file)).replace(/\\/g, "/");
      ids.push(`plugins/${rel}`);
    }
    for (const file of workflowFiles) {
      const rel = path
        .relative(path.join(ROOT, "workflows"), path.dirname(file))
        .replace(/\\/g, "/");
      ids.push(`workflows/${rel}`);
    }

    const seen = new Map<string, number>();
    for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(dupes, `duplicate discovery ids: ${dupes.join(", ")}`).toEqual([]);
    expect(ids.length).toBeGreaterThanOrEqual(200 + 165 + 90 + 70 + 70 + 110);
  });

  it("lists every shipped skill, tool, and agent on a fresh install (workspace unset)", () => {
    const { items } = capabilities.list({ appRoot: ROOT, workspaceRoot: null });
    const skills = items.filter(
      (item) => item.tree === "skills" && item.id.startsWith("skills/custom/"),
    );
    const tools = items.filter((item) => item.tree === "tools");
    const agents = items.filter(
      (item) => item.tree === "agents" && item.id.startsWith("agents/core/"),
    );
    expect(skills.length).toBeGreaterThanOrEqual(200);
    expect(tools.length).toBeGreaterThanOrEqual(165);
    expect(agents.length).toBeGreaterThanOrEqual(90);
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of [...skills, ...tools, ...agents]) {
      expect(item.enabled, item.id).toBe(false);
    }
    const modules = items.filter((item) => item.tree === "modules");
    expect(modules.length).toBeGreaterThanOrEqual(70);
    expect(modules.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "modules/repo-import",
        "modules/developer/project-scaffold",
        "modules/developer/stack-audit",
        "modules/developer/table-inspect",
        "modules/developer/data-normalize",
        "modules/developer/sqlite-inspect",
        "modules/system/log-inspect",
        "modules/developer/git-status-report",
        "modules/automation/checksum-manifest",
        "modules/communication/markdown-toc",
        "modules/ai/gguf-inventory",
        "modules/ui/html-headings",
      ]),
    );
    const enabledModules = modules.filter((item) => item.enabled);
    expect(enabledModules.map((item) => item.id)).toEqual(["modules/repo-import"]);
    const pluginItems = items.filter((item) => item.tree === "plugins");
    expect(pluginItems.length).toBeGreaterThanOrEqual(70);
    expect(pluginItems.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "plugins/installed/turn-complete-log",
        "plugins/installed/boot-env-stamp",
        "plugins/installed/idle-temp-census",
        "plugins/installed/git-head-stamp",
        "plugins/installed/slow-turn-watch",
        "plugins/installed/secret-filename-watch",
        "plugins/installed/os-snapshot-boot",
      ]),
    );
    expect(pluginItems.filter((item) => item.enabled)).toEqual([]);
    const workflowItems = items.filter((item) => item.tree === "workflows");
    expect(workflowItems.length).toBeGreaterThanOrEqual(110);
    expect(workflowItems.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "workflows/saved/morning-briefing",
        "workflows/saved/workspace-cleanup",
        "workflows/saved/self-health",
        "workflows/saved/evening-wrapup",
        "workflows/saved/weekly-life-review",
      ]),
    );
    expect(workflowItems.filter((item) => item.enabled)).toEqual([]);
  });

  it("does not auto-enable write/exec packs; lists safe-but-disabled candidates", () => {
    const { items } = capabilities.list({ appRoot: ROOT, workspaceRoot: null });
    const section = items.filter((item) => ["skills", "tools", "agents"].includes(item.tree));
    const writeExecOn = section.filter((item) => item.enabled && item.risk !== "safe");
    expect(writeExecOn, writeExecOn.map((item) => item.id).join(", ")).toEqual([]);
    const safeDisabled = section.filter((item) => item.risk === "safe" && !item.enabled);
    expect(safeDisabled.length).toBeGreaterThan(0);
  });
});
