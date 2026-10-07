// FRIDAY · one content-shape detector for capability imports.
//
// Skills / Tools / Agents / Modules zip, folder, git, file, and GitHub
// imports all call this before installPack() writes a manifest. The page the
// owner is on is a hint, not a license to reshape a pack into the wrong tree.
// Hub detectKind() still classifies from path prefixes; this module is the
// write-time authority for real pack content (entry + approvalPrompt,
// plan()/run(), skill.json, module entry + permissions).
"use strict";

const CROSS = new Set(["skills", "tools", "agents", "modules", "plugins", "workflows"]);

const PAGE = {
  skills: "Skills",
  tools: "Tools",
  agents: "Agents",
  modules: "Modules",
  plugins: "Plugins",
  workflows: "Workflows",
};

const TREE_ALIASES = {
  agent: "agents",
  "ai-agent": "agents",
  assistant: "agents",
  skill: "skills",
  ability: "skills",
  tool: "tools",
  command: "tools",
  module: "modules",
  extension: "modules",
  plugin: "plugins",
  "plug-in": "plugins",
  addon: "plugins",
  "add-on": "plugins",
  workflow: "workflows",
  automation: "workflows",
  flow: "workflows",
  model: "models",
};

const KIND_FILES = {
  "plugin.json": "plugins",
  "module.json": "modules",
  "agent.json": "agents",
  "tool.json": "tools",
  "workflow.json": "workflows",
  "skill.json": "skills",
  "skill.mjs": "skills",
  "skill.js": "skills",
};

const AGENT_ONLY_CATEGORIES = new Set([
  "maintenance",
  "monitoring",
  "research",
  "reminders",
  "backup",
  "office",
  "home",
]);

const TOOL_SEGMENTS = new Set([
  "system",
  "filesystem",
  "applications",
  "browser",
  "network",
  "automation",
  "developer",
  "devices",
  "data",
  "documents",
  "text",
  "media",
  "time",
  "math",
  "health",
  "custom",
]);

function canonicalTree(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (!key) return null;
  if (
    key === "skills" ||
    key === "plugins" ||
    key === "tools" ||
    key === "agents" ||
    key === "modules" ||
    key === "workflows" ||
    key === "models"
  )
    return key;
  return TREE_ALIASES[key] || null;
}

function declaredTree(pack) {
  const p = pack || {};
  return (
    canonicalTree(p.tree) ||
    canonicalTree(p.kind) ||
    canonicalTree(p.type) ||
    canonicalTree(p.manifestName) ||
    null
  );
}

function basenameOf(pack) {
  const raw = String(pack.filename || pack.file || pack.manifestFile || pack.manifestName || "")
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/");
  if (!raw) return "";
  const base = raw.split("/").pop() || "";
  if (base === "skill" || base === "tool" || base === "agent" || base === "agents") {
    return `${base}.json`;
  }
  return base;
}

function fileKind(pack) {
  const name = basenameOf(pack);
  if (KIND_FILES[name]) return KIND_FILES[name];
  if (name === "manifest.json") return null;
  return null;
}

function nested(pack) {
  return pack && pack.manifest && typeof pack.manifest === "object" ? pack.manifest : {};
}

function hasAgentFields(pack) {
  const extra = nested(pack);
  return Boolean(
    pack.goal ||
    extra.goal ||
    pack.persona ||
    extra.persona ||
    pack.role ||
    extra.role ||
    (Array.isArray(pack.agents) && pack.agents.length) ||
    (Array.isArray(extra.agents) && extra.agents.length),
  );
}

function codeExports(code) {
  const src = String(code || "");
  if (!src.trim()) return { plan: false, run: false, cjs: false, esm: false };
  const plan =
    /\bexports\.plan\s*=/.test(src) ||
    /\bmodule\.exports\.plan\s*=/.test(src) ||
    /\bfunction\s+plan\s*\(/.test(src) ||
    /module\.exports\s*=\s*\{[^}]*\bplan\b/.test(src);
  const run =
    /\bexports\.run\s*=/.test(src) ||
    /\bmodule\.exports\.run\s*=/.test(src) ||
    /\bfunction\s+run\s*\(/.test(src) ||
    /module\.exports\s*=\s*\{[^}]*\brun\b/.test(src) ||
    /export\s+(async\s+)?function\s+run\b/.test(src) ||
    /export\s+\{[^}]*\brun\b/.test(src) ||
    /export\s+const\s+run\b/.test(src);
  const cjs = /module\.exports|exports\.run\s*=|exports\.plan\s*=/.test(src);
  const esm =
    /export\s+(async\s+)?function\s+run\b/.test(src) ||
    /export\s+\{[^}]*\brun\b/.test(src) ||
    /export\s+const\s+run\b/.test(src) ||
    /export\s+default\b/.test(src);
  return { plan, run, cjs, esm };
}

function isToolish(pack) {
  const entry = String(pack.entry || "").trim();
  const approval = String(pack.approvalPrompt || "").trim();
  const risk = pack.risk != null && String(pack.risk).trim() !== "";
  return Boolean(entry) && Boolean(approval) && risk;
}

function packPermissions(pack) {
  const extra = nested(pack);
  if (Array.isArray(pack.permissions)) return pack.permissions;
  if (Array.isArray(extra.permissions)) return extra.permissions;
  return null;
}

function packUi(pack) {
  const extra = nested(pack);
  const ui = pack.ui || extra.ui;
  return ui && typeof ui === "object" && !Array.isArray(ui) ? ui : null;
}

/**
 * Module shape: entry + permissions, optional ui, no plan()/run() pair,
 * no tool-style risk + approvalPrompt pair. Python main.py is a module
 * entry; JS plan()+run() stays an agent.
 */
function isModuleish(pack) {
  const extra = nested(pack);
  const entry = String(pack.entry || extra.entry || "").trim();
  const perms = packPermissions(pack);
  const approval = String(pack.approvalPrompt || extra.approvalPrompt || "").trim();
  if (!entry || !Array.isArray(perms) || !perms.length) return false;
  if (approval) return false;
  if (hasAgentFields(pack)) return false;
  if (isToolish(pack)) return false;
  if (Array.isArray(pack.hooks) || Array.isArray(extra.hooks)) return false;
  const code = pack.code || extra.code || "";
  const { plan, run } = codeExports(code);
  if (plan && run) return false;
  return true;
}

/**
 * Detect the real capability tree from pack content. Page hint is not an input.
 * Returns { tree, reason } — tree is null when the shape is incomplete/unknown.
 */
function detectPackShape(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    return { tree: null, reason: "not a pack object" };
  }

  const extra = nested(pack);
  const code = pack.code || extra.code || "";
  const { plan, run, cjs, esm } = codeExports(code);
  const fromFile = fileKind(pack);
  const category = String(pack.category || extra.category || "")
    .trim()
    .toLowerCase();

  if (plan && run) {
    return { tree: "agents", reason: "the entry file exports both plan() and run()" };
  }
  if (hasAgentFields(pack)) {
    return {
      tree: "agents",
      reason: "the pack has agent fields (goal, persona, role, or agents)",
    };
  }
  if (fromFile === "agents") {
    return { tree: "agents", reason: "the pack is an agent.json / agent manifest" };
  }

  if (isToolish(pack) && !plan) {
    if (AGENT_ONLY_CATEGORIES.has(category) && fromFile !== "tools" && fromFile !== "skills") {
      return {
        tree: "agents",
        reason: `the pack has agent-library category "${category}" plus entry/risk/approvalPrompt`,
      };
    }
    return {
      tree: "tools",
      reason: "the pack has tool-style fields (entry, risk, and approvalPrompt)",
    };
  }

  if (fromFile === "tools") {
    return { tree: "tools", reason: "the pack is a tool.json" };
  }
  if (run && !plan && cjs) {
    return { tree: "tools", reason: "the entry is a CJS run() without plan()" };
  }

  if (fromFile === "skills") {
    return { tree: "skills", reason: "the pack is a skill.json / skill.mjs" };
  }
  if (
    Array.isArray(pack.capabilities) &&
    !String(pack.approvalPrompt || "").trim() &&
    !pack.entry
  ) {
    return {
      tree: "skills",
      reason: "the pack has a skill-style capabilities list without tool approval fields",
    };
  }
  if (run && !plan && esm && !isToolish(pack)) {
    return { tree: "skills", reason: "the entry is an ESM run() without plan()" };
  }
  if (
    (pack.summary || (Array.isArray(pack.inputs) && pack.inputs.length)) &&
    !pack.entry &&
    !String(pack.approvalPrompt || "").trim() &&
    !plan &&
    !TOOL_SEGMENTS.has(category)
  ) {
    return { tree: "skills", reason: "the pack has a skill-style summary/inputs shape" };
  }

  if (fromFile === "plugins" || Array.isArray(pack.hooks)) {
    return { tree: "plugins", reason: "the pack is a plugin (plugin.json or hooks)" };
  }
  if (
    fromFile === "workflows" ||
    Array.isArray(pack.steps) ||
    Array.isArray(pack.nodes) ||
    pack.schedule
  ) {
    return { tree: "workflows", reason: "the pack is a workflow (steps/nodes/schedule)" };
  }
  if (pack.provider && (pack.contextWindow || pack.parameters)) {
    return { tree: "models", reason: "the pack looks like a model manifest" };
  }

  if (fromFile === "modules") {
    return { tree: "modules", reason: "the pack is a module.json" };
  }
  if (isModuleish(pack)) {
    const ui = packUi(pack);
    return {
      tree: "modules",
      reason: ui
        ? "the pack has module-style fields (entry, permissions, and ui) without plan()/run() or a tool approval pair"
        : "the pack has module-style fields (entry and permissions) without plan()/run() or a tool approval pair",
    };
  }

  const declared = declaredTree(pack);
  if (declared) {
    return { tree: declared, reason: `the pack declares tree "${declared}"` };
  }
  return { tree: null, reason: "shape is incomplete or unknown" };
}

function refuseError(section, detected) {
  const want = PAGE[section] || section;
  const got = PAGE[detected.tree] || detected.tree;
  const reason = String(detected.reason || "content shape").trim();
  const noun = {
    skills: "skill",
    tools: "tool",
    agents: "agent",
    modules: "module",
    plugins: "plugin",
    workflows: "workflow",
  };
  const wantNoun = noun[section] || String(section).replace(/s$/, "");
  const article = got === "Agents" ? "an" : "a";
  return (
    `Detected ${article} ${got} pack (${reason}). ` +
    `The ${want} page only accepts ${wantNoun} packs. ` +
    `Import it on the ${got} page instead — FRIDAY will not reshape it into a ${wantNoun}.`
  );
}

function kindListMismatch(kinds, section) {
  const want = canonicalTree(section);
  if (!CROSS.has(want)) return null;
  const reasons = {
    tools: "the archive contains tool.json",
    skills: "the archive contains skill.json",
    agents: "the archive contains an agent manifest",
    modules: "the archive contains a module manifest",
    plugins: "the archive contains a plugin manifest",
    workflows: "the archive contains a workflow manifest",
  };
  for (const kind of kinds || []) {
    const tree = canonicalTree(kind);
    if (CROSS.has(tree) && tree !== want) {
      return { tree, reason: reasons[tree] || `the archive contains a ${tree} pack` };
    }
  }
  return null;
}

function crossSectionMismatch(pack, section) {
  const want = canonicalTree(section);
  if (!CROSS.has(want)) return null;
  const detected = detectPackShape(pack);
  if (detected.tree && CROSS.has(detected.tree) && detected.tree !== want) return detected;
  return null;
}

/**
 * Write-time gate used by installPack and the three prepare*Only collectors.
 * Only skills/tools/agents/modules/plugins/workflows imports are gated this way (the
 * shared CapabilityImport sources). Other trees keep their existing routing.
 */
function assertMatchesSection(pack, hint) {
  const mismatch = crossSectionMismatch(pack, hint);
  if (mismatch)
    return { ok: false, error: refuseError(canonicalTree(hint), mismatch), detected: mismatch };
  return { ok: true, detected: detectPackShape(pack) };
}

function firstMismatchIn(packs, kinds, section) {
  for (const pack of Array.isArray(packs) ? packs : []) {
    const mismatch = crossSectionMismatch(pack, section);
    if (mismatch) return mismatch;
  }
  return kindListMismatch(kinds, section);
}

module.exports = {
  CROSS,
  PAGE,
  TOOL_SEGMENTS,
  AGENT_ONLY_CATEGORIES,
  canonicalTree,
  declaredTree,
  detectPackShape,
  refuseError,
  kindListMismatch,
  crossSectionMismatch,
  assertMatchesSection,
  firstMismatchIn,
  codeExports,
  isModuleish,
  packUi,
};
