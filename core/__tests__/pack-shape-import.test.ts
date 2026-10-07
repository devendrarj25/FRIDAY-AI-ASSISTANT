/**
 * Cross-section import guard: a real tool pack dropped on Skills (and a real
 * skill pack dropped on Tools) must be refused with the detected tree named.
 * Zip / folder / git all use the same pack-shape.cjs gate as file import.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { detectKind, detectKindFromManifest } from "../../src/lib/friday/hub-engine";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const packShape = require("../../electron/pack-shape.cjs") as {
  detectPackShape: (pack: unknown) => { tree: string | null; reason: string };
  refuseError: (section: string, detected: { tree: string; reason: string }) => string;
};
const skillPack = require("../../electron/skill-pack.cjs") as {
  prepareSkillsOnly: (
    payload: unknown,
    extra?: { nonSkillKinds?: string[] },
  ) => { ok: boolean; packs?: unknown[]; error?: string };
  collectSkillPacksFromDir: (dir: string) => {
    packs: unknown[];
    nonSkillKinds: string[];
  };
};
const toolPack = require("../../electron/tool-pack.cjs") as {
  prepareToolsOnly: (
    payload: unknown,
    extra?: { nonToolKinds?: string[] },
  ) => { ok: boolean; packs?: unknown[]; error?: string };
  collectToolPacksFromDir: (dir: string) => {
    packs: unknown[];
    nonToolKinds: string[];
  };
};
const agentPack = require("../../electron/agent-pack.cjs") as {
  prepareAgentsOnly: (
    payload: unknown,
    extra?: { nonAgentKinds?: string[] },
  ) => { ok: boolean; packs?: unknown[]; error?: string };
  collectAgentPacksFromDir: (dir: string) => {
    packs: unknown[];
    nonAgentKinds: string[];
  };
};
const modulePack = require("../../electron/module-pack.cjs") as {
  prepareModulesOnly: (
    payload: unknown,
    extra?: { nonModuleKinds?: string[] },
  ) => { ok: boolean; packs?: unknown[]; error?: string };
  collectModulePacksFromDir: (dir: string) => {
    packs: unknown[];
    nonModuleKinds: string[];
  };
};
const pluginPack = require("../../electron/plugin-pack.cjs") as {
  preparePluginsOnly: (
    payload: unknown,
    extra?: { nonPluginKinds?: string[] },
  ) => { ok: boolean; packs?: unknown[]; error?: string };
  collectPluginPacksFromDir: (dir: string) => {
    packs: unknown[];
    nonPluginKinds: string[];
  };
};
const workflowPack = require("../../electron/workflow-pack.cjs") as {
  prepareWorkflowsOnly: (
    payload: unknown,
    extra?: { nonWorkflowKinds?: string[] },
  ) => { ok: boolean; packs?: unknown[]; error?: string };
  collectWorkflowPacksFromDir: (dir: string) => {
    packs: unknown[];
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

const TOOL_DIR = path.join(ROOT, "tools", "system", "disk-space");
const SKILL_DIR = path.join(ROOT, "skills", "custom", "wrt-headlines");
const AGENT_DIR = path.join(ROOT, "agents", "core", "downloads-cleanup");
const MODULE_DIR = path.join(ROOT, "modules", "repo-import");
const PLUGIN_DIR = path.join(ROOT, "plugins", "installed", "turn-complete-log");
const WORKFLOW_DIR = path.join(ROOT, "workflows", "saved", "morning-briefing");

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pack-shape-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function copyPack(from: string, to: string) {
  fs.cpSync(from, to, { recursive: true });
}

describe("pack-shape detector on real shipped packs", () => {
  it("reads disk-space as a tool, wrt-headlines as a skill, downloads-cleanup as an agent", () => {
    const tool = {
      ...readJson(path.join(TOOL_DIR, "tool.json")),
      filename: "tool.json",
      code: fs.readFileSync(path.join(TOOL_DIR, "index.cjs"), "utf8"),
    };
    const skill = {
      ...readJson(path.join(SKILL_DIR, "skill.json")),
      filename: "skill.json",
      code: fs.readFileSync(path.join(SKILL_DIR, "skill.mjs"), "utf8"),
    };
    const agent = {
      ...readJson(path.join(AGENT_DIR, "manifest.json")),
      filename: "manifest.json",
      code: fs.readFileSync(path.join(AGENT_DIR, "index.cjs"), "utf8"),
    };
    expect(packShape.detectPackShape(tool).tree).toBe("tools");
    expect(packShape.detectPackShape(skill).tree).toBe("skills");
    expect(packShape.detectPackShape(agent).tree).toBe("agents");
    const modulePackBody = {
      ...readJson(path.join(MODULE_DIR, "manifest.json")),
      filename: "manifest.json",
      code: fs.readFileSync(path.join(MODULE_DIR, "main.py"), "utf8"),
    };
    expect(packShape.detectPackShape(modulePackBody).tree).toBe("modules");
    const pluginPackBody = {
      ...readJson(path.join(PLUGIN_DIR, "plugin.json")),
      filename: "plugin.json",
      code: fs.readFileSync(path.join(PLUGIN_DIR, "index.cjs"), "utf8"),
    };
    expect(packShape.detectPackShape(pluginPackBody).tree).toBe("plugins");
    const workflowPackBody = {
      ...readJson(path.join(WORKFLOW_DIR, "workflow.json")),
      filename: "workflow.json",
    };
    expect(packShape.detectPackShape(workflowPackBody).tree).toBe("workflows");
  });
});

describe("cross-section import refuse (real packs, one gate)", () => {
  it("refuses a real tool folder on the Skills importer and names Tools", () => {
    const dir = temp();
    copyPack(TOOL_DIR, path.join(dir, "disk-space"));
    const collected = skillPack.collectSkillPacksFromDir(dir);
    expect(collected.nonSkillKinds).toContain("tools");
    const prepared = skillPack.prepareSkillsOnly(collected.packs, {
      nonSkillKinds: collected.nonSkillKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected a Tools pack/i);
    expect(String(prepared.error)).toMatch(/Skills page only accepts skill packs/i);
    expect(String(prepared.error)).toMatch(/Import it on the Tools page/i);
    expect(String(prepared.error)).toMatch(/will not reshape/i);

    const raw = {
      ...readJson(path.join(TOOL_DIR, "tool.json")),
      code: fs.readFileSync(path.join(TOOL_DIR, "index.cjs"), "utf8"),
    };
    const workspace = temp();
    const written = capabilities.installPack({ workspaceRoot: workspace }, raw, "skills");
    expect(written.ok).toBe(false);
    expect(String(written.error)).toMatch(/Detected a Tools pack/i);
    expect(fs.existsSync(path.join(workspace, "skills"))).toBe(false);
  });

  it("refuses a real skill folder on the Tools importer and names Skills", () => {
    const dir = temp();
    copyPack(SKILL_DIR, path.join(dir, "wrt-headlines"));
    const collected = toolPack.collectToolPacksFromDir(dir);
    expect(collected.nonToolKinds).toContain("skills");
    const prepared = toolPack.prepareToolsOnly(collected.packs, {
      nonToolKinds: collected.nonToolKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected a Skills pack/i);
    expect(String(prepared.error)).toMatch(/Tools page only accepts tool packs/i);
    expect(String(prepared.error)).toMatch(/Import it on the Skills page/i);

    const raw = {
      ...readJson(path.join(SKILL_DIR, "skill.json")),
      code: fs.readFileSync(path.join(SKILL_DIR, "skill.mjs"), "utf8"),
    };
    const written = capabilities.installPack({ workspaceRoot: temp() }, raw, "tools");
    expect(written.ok).toBe(false);
    expect(String(written.error)).toMatch(/Detected a Skills pack/i);
  });

  it("refuses a real agent folder on the Skills importer and names Agents", () => {
    const dir = temp();
    copyPack(AGENT_DIR, path.join(dir, "downloads-cleanup"));
    const collected = skillPack.collectSkillPacksFromDir(dir);
    const prepared = skillPack.prepareSkillsOnly(collected.packs, {
      nonSkillKinds: collected.nonSkillKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected an Agents pack/i);
    expect(String(prepared.error)).toMatch(/Skills page/i);
  });

  it("still installs a real skill on Skills and a real tool on Tools", () => {
    const skillDir = temp();
    copyPack(SKILL_DIR, path.join(skillDir, "wrt-headlines"));
    const skillCollected = skillPack.collectSkillPacksFromDir(skillDir);
    const skillPrepared = skillPack.prepareSkillsOnly(skillCollected.packs, {
      nonSkillKinds: skillCollected.nonSkillKinds,
    });
    expect(skillPrepared.ok).toBe(true);
    const skillInstalled = capabilities.installPack(
      { workspaceRoot: temp() },
      (skillPrepared.packs || [])[0],
      "skills",
    );
    expect(skillInstalled.ok).toBe(true);
    expect(skillInstalled.tree).toBe("skills");

    const toolDir = temp();
    copyPack(TOOL_DIR, path.join(toolDir, "disk-space"));
    const toolCollected = toolPack.collectToolPacksFromDir(toolDir);
    const toolPrepared = toolPack.prepareToolsOnly(toolCollected.packs, {
      nonToolKinds: toolCollected.nonToolKinds,
    });
    expect(toolPrepared.ok).toBe(true);
    const toolInstalled = capabilities.installPack(
      { workspaceRoot: temp() },
      (toolPrepared.packs || [])[0],
      "tools",
    );
    expect(toolInstalled.ok).toBe(true);
    expect(toolInstalled.tree).toBe("tools");
  });

  it("collects a real agent folder on the Agents importer", () => {
    const dir = temp();
    copyPack(AGENT_DIR, path.join(dir, "downloads-cleanup"));
    const collected = agentPack.collectAgentPacksFromDir(dir);
    expect(collected.packs.length).toBeGreaterThanOrEqual(1);
    const prepared = agentPack.prepareAgentsOnly(collected.packs, {
      nonAgentKinds: collected.nonAgentKinds,
    });
    expect(prepared.ok).toBe(true);
  });

  it("refuses a real skill pack on the Modules importer and names Skills", () => {
    const dir = temp();
    copyPack(SKILL_DIR, path.join(dir, "wrt-headlines"));
    const collected = modulePack.collectModulePacksFromDir(dir);
    expect(collected.nonModuleKinds).toContain("skills");
    const prepared = modulePack.prepareModulesOnly(collected.packs, {
      nonModuleKinds: collected.nonModuleKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected a Skills pack/i);
    expect(String(prepared.error)).toMatch(/Modules page only accepts module packs/i);

    const raw = {
      ...readJson(path.join(SKILL_DIR, "skill.json")),
      code: fs.readFileSync(path.join(SKILL_DIR, "skill.mjs"), "utf8"),
    };
    const written = capabilities.installPack({ workspaceRoot: temp() }, raw, "modules");
    expect(written.ok).toBe(false);
    expect(String(written.error)).toMatch(/Detected a Skills pack/i);
  });

  it("refuses a real module folder on the Skills importer and names Modules", () => {
    const dir = temp();
    copyPack(MODULE_DIR, path.join(dir, "repo-import"));
    const collected = skillPack.collectSkillPacksFromDir(dir);
    const prepared = skillPack.prepareSkillsOnly(collected.packs, {
      nonSkillKinds: collected.nonSkillKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected a Modules pack/i);
    expect(String(prepared.error)).toMatch(/Skills page only accepts skill packs/i);

    const raw = {
      ...readJson(path.join(MODULE_DIR, "manifest.json")),
      code: fs.readFileSync(path.join(MODULE_DIR, "main.py"), "utf8"),
    };
    const written = capabilities.installPack({ workspaceRoot: temp() }, raw, "skills");
    expect(written.ok).toBe(false);
    expect(String(written.error)).toMatch(/Detected a Modules pack/i);
  });

  it("collects a real module folder on the Modules importer", () => {
    const dir = temp();
    copyPack(MODULE_DIR, path.join(dir, "repo-import"));
    const collected = modulePack.collectModulePacksFromDir(dir);
    expect(collected.packs.length).toBeGreaterThanOrEqual(1);
    const prepared = modulePack.prepareModulesOnly(collected.packs, {
      nonModuleKinds: collected.nonModuleKinds,
    });
    expect(prepared.ok).toBe(true);
  });

  it("refuses a real tool pack on the Modules importer and names Tools", () => {
    const dir = temp();
    copyPack(TOOL_DIR, path.join(dir, "disk-space"));
    const collected = modulePack.collectModulePacksFromDir(dir);
    expect(collected.nonModuleKinds).toContain("tools");
    const prepared = modulePack.prepareModulesOnly(collected.packs, {
      nonModuleKinds: collected.nonModuleKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected a Tools pack/i);
    expect(String(prepared.error)).toMatch(/Modules page only accepts module packs/i);

    const raw = {
      ...readJson(path.join(TOOL_DIR, "tool.json")),
      code: fs.readFileSync(path.join(TOOL_DIR, "index.cjs"), "utf8"),
    };
    const written = capabilities.installPack({ workspaceRoot: temp() }, raw, "modules");
    expect(written.ok).toBe(false);
    expect(String(written.error)).toMatch(/Detected a Tools pack/i);
  });

  it("refuses a real agent pack on the Modules importer and names Agents", () => {
    const dir = temp();
    copyPack(AGENT_DIR, path.join(dir, "downloads-cleanup"));
    const collected = modulePack.collectModulePacksFromDir(dir);
    const prepared = modulePack.prepareModulesOnly(collected.packs, {
      nonModuleKinds: collected.nonModuleKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected an Agents pack/i);

    const raw = {
      ...readJson(path.join(AGENT_DIR, "manifest.json")),
      code: fs.readFileSync(path.join(AGENT_DIR, "index.cjs"), "utf8"),
    };
    const written = capabilities.installPack({ workspaceRoot: temp() }, raw, "modules");
    expect(written.ok).toBe(false);
    expect(String(written.error)).toMatch(/Detected an Agents pack/i);
  });

  it("refuses a real module pack on the Tools and Agents importers", () => {
    const dir = temp();
    copyPack(MODULE_DIR, path.join(dir, "repo-import"));
    const toolCollected = toolPack.collectToolPacksFromDir(dir);
    const toolPrepared = toolPack.prepareToolsOnly(toolCollected.packs, {
      nonToolKinds: toolCollected.nonToolKinds,
    });
    expect(toolPrepared.ok).toBe(false);
    expect(String(toolPrepared.error)).toMatch(/Detected a Modules pack/i);

    const agentCollected = agentPack.collectAgentPacksFromDir(dir);
    const agentPrepared = agentPack.prepareAgentsOnly(agentCollected.packs, {
      nonAgentKinds: agentCollected.nonAgentKinds,
    });
    expect(agentPrepared.ok).toBe(false);
    expect(String(agentPrepared.error)).toMatch(/Detected a Modules pack/i);
  });

  it("refuses a real skill/tool/agent/module pack on the Plugins importer", () => {
    const dir = temp();
    copyPack(SKILL_DIR, path.join(dir, "wrt-headlines"));
    const collected = pluginPack.collectPluginPacksFromDir(dir);
    expect(collected.nonPluginKinds).toContain("skills");
    const prepared = pluginPack.preparePluginsOnly(collected.packs, {
      nonPluginKinds: collected.nonPluginKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected a Skills pack/i);
    expect(String(prepared.error)).toMatch(/Plugins page only accepts plugin packs/i);

    const toolDir = temp();
    copyPack(TOOL_DIR, path.join(toolDir, "disk-space"));
    const toolCollected = pluginPack.collectPluginPacksFromDir(toolDir);
    const toolPrepared = pluginPack.preparePluginsOnly(toolCollected.packs, {
      nonPluginKinds: toolCollected.nonPluginKinds,
    });
    expect(toolPrepared.ok).toBe(false);
    expect(String(toolPrepared.error)).toMatch(/Detected a Tools pack/i);

    const agentDir = temp();
    copyPack(AGENT_DIR, path.join(agentDir, "downloads-cleanup"));
    const agentCollected = pluginPack.collectPluginPacksFromDir(agentDir);
    const agentPrepared = pluginPack.preparePluginsOnly(agentCollected.packs, {
      nonPluginKinds: agentCollected.nonPluginKinds,
    });
    expect(agentPrepared.ok).toBe(false);
    expect(String(agentPrepared.error)).toMatch(/Detected an Agents pack/i);

    const moduleDir = temp();
    copyPack(MODULE_DIR, path.join(moduleDir, "repo-import"));
    const moduleCollected = pluginPack.collectPluginPacksFromDir(moduleDir);
    const modulePrepared = pluginPack.preparePluginsOnly(moduleCollected.packs, {
      nonPluginKinds: moduleCollected.nonPluginKinds,
    });
    expect(modulePrepared.ok).toBe(false);
    expect(String(modulePrepared.error)).toMatch(/Detected a Modules pack/i);
  });

  it("refuses a real plugin pack on Skills/Tools/Agents/Modules importers", () => {
    const dir = temp();
    copyPack(PLUGIN_DIR, path.join(dir, "turn-complete-log"));
    const skillCollected = skillPack.collectSkillPacksFromDir(dir);
    const skillPrepared = skillPack.prepareSkillsOnly(skillCollected.packs, {
      nonSkillKinds: skillCollected.nonSkillKinds,
    });
    expect(skillPrepared.ok).toBe(false);
    expect(String(skillPrepared.error)).toMatch(/Detected a Plugins pack/i);

    const toolCollected = toolPack.collectToolPacksFromDir(dir);
    const toolPrepared = toolPack.prepareToolsOnly(toolCollected.packs, {
      nonToolKinds: toolCollected.nonToolKinds,
    });
    expect(toolPrepared.ok).toBe(false);
    expect(String(toolPrepared.error)).toMatch(/Detected a Plugins pack/i);

    const agentCollected = agentPack.collectAgentPacksFromDir(dir);
    const agentPrepared = agentPack.prepareAgentsOnly(agentCollected.packs, {
      nonAgentKinds: agentCollected.nonAgentKinds,
    });
    expect(agentPrepared.ok).toBe(false);
    expect(String(agentPrepared.error)).toMatch(/Detected a Plugins pack/i);

    const moduleCollected = modulePack.collectModulePacksFromDir(dir);
    const modulePrepared = modulePack.prepareModulesOnly(moduleCollected.packs, {
      nonModuleKinds: moduleCollected.nonModuleKinds,
    });
    expect(modulePrepared.ok).toBe(false);
    expect(String(modulePrepared.error)).toMatch(/Detected a Plugins pack/i);

    const raw = {
      ...readJson(path.join(PLUGIN_DIR, "plugin.json")),
      filename: "plugin.json",
      code: fs.readFileSync(path.join(PLUGIN_DIR, "index.cjs"), "utf8"),
    };
    const written = capabilities.installPack({ workspaceRoot: temp() }, raw, "skills");
    expect(written.ok).toBe(false);
    expect(String(written.error)).toMatch(/Detected a Plugins pack/i);
  });

  it("collects a real plugin folder on the Plugins importer", () => {
    const dir = temp();
    copyPack(PLUGIN_DIR, path.join(dir, "turn-complete-log"));
    const collected = pluginPack.collectPluginPacksFromDir(dir);
    expect(collected.packs.length).toBeGreaterThanOrEqual(1);
    const prepared = pluginPack.preparePluginsOnly(collected.packs, {
      nonPluginKinds: collected.nonPluginKinds,
    });
    expect(prepared.ok).toBe(true);
  });

  it("refuses a real skill pack on the Workflows importer and a workflow pack on Plugins", () => {
    const dir = temp();
    copyPack(SKILL_DIR, path.join(dir, "wrt-headlines"));
    const collected = workflowPack.collectWorkflowPacksFromDir(dir);
    expect(collected.nonWorkflowKinds).toContain("skills");
    const prepared = workflowPack.prepareWorkflowsOnly(collected.packs, {
      nonWorkflowKinds: collected.nonWorkflowKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected a Skills pack/i);

    const flowDir = temp();
    copyPack(WORKFLOW_DIR, path.join(flowDir, "morning-briefing"));
    const pluginCollected = pluginPack.collectPluginPacksFromDir(flowDir);
    const pluginPrepared = pluginPack.preparePluginsOnly(pluginCollected.packs, {
      nonPluginKinds: pluginCollected.nonPluginKinds,
    });
    expect(pluginPrepared.ok).toBe(false);
    expect(String(pluginPrepared.error)).toMatch(/Detected a Workflows pack/i);

    const raw = {
      ...readJson(path.join(WORKFLOW_DIR, "workflow.json")),
      filename: "workflow.json",
    };
    const written = capabilities.installPack({ workspaceRoot: temp() }, raw, "plugins");
    expect(written.ok).toBe(false);
    expect(String(written.error)).toMatch(/Detected a Workflows pack/i);
  });
});

describe("Hub detectKind filename + manifest content", () => {
  it("classifies skill.json / tool.json / agent.json without a FRIDAY path prefix", () => {
    expect(detectKind(["pack/skill.json", "pack/skill.mjs"])).toBe("skill");
    expect(detectKind(["pack/tool.json", "pack/index.cjs"])).toBe("tool");
    expect(detectKind(["pack/agent.json"])).toBe("agent");
    expect(detectKind(["pack/module.json", "pack/main.py"])).toBe("module");
    expect(detectKind(["pack/plugin.json", "pack/index.cjs"])).toBe("plugin");
    expect(detectKind(["pack/workflow.json"])).toBe("workflow");
    expect(detectKind(["src/index.ts", "manifest.json"])).toBe("module");
  });

  it("classifies a live tool.json body as a tool", () => {
    const manifest = readJson(path.join(TOOL_DIR, "tool.json"));
    expect(detectKindFromManifest(manifest)).toBe("tool");
    expect(detectKind(["readme.md"], { manifest })).toBe("tool");
  });

  it("classifies a live module manifest as a module", () => {
    const manifest = readJson(path.join(MODULE_DIR, "manifest.json"));
    expect(detectKindFromManifest(manifest)).toBe("module");
    expect(detectKind(["readme.md"], { manifest })).toBe("module");
  });
});
