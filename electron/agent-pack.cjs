// FRIDAY · agent-pack healer and agents-only collector.
//
// The Agents page accepts only agent-shaped content (manifest.json with
// agents/goal/persona/role, agent.json, or JSON with tree/kind "agents").
// Incomplete packs are healed into the same agents-tree shape installPack()
// already writes. Non-agent trees (skills, tools, plugins, modules,
// workflows, models) are refused here so they stay on their own pages. This
// module does not write the workspace — installPack() in capabilities.cjs
// remains the single writer. Git clone reuses skill-pack.stageGitClone.
const fs = require("fs");
const path = require("path");
const skillPack = require("./skill-pack.cjs");
const packShape = require("./pack-shape.cjs");

const KIND_FILES = {
  "plugin.json": "plugins",
  "module.json": "modules",
  "agent.json": "agents",
  "tool.json": "tools",
  "workflow.json": "workflows",
  "skill.json": "skills",
};

const AGENT_SEGMENTS = new Set(["system", "core", "custom", "installed"]);

const IGNORED = new Set([
  "node_modules",
  ".git",
  ".venv",
  "__pycache__",
  ".cache",
  "__MACOSX",
  "dist",
  "release",
]);

const slugify = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

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
  return null;
}

function declaredTree(pack) {
  const p = pack || {};
  const aliases = {
    skill: "skills",
    plugin: "plugins",
    tool: "tools",
    agent: "agents",
    "ai-agent": "agents",
    assistant: "agents",
    module: "modules",
    workflow: "workflows",
    model: "models",
  };
  const raw = String(p.tree || p.kind || p.type || p.manifestName || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (!raw) return null;
  if (canonicalTree(raw)) return canonicalTree(raw);
  return aliases[raw] || null;
}

function nestedManifest(pack) {
  const extra = pack && pack.manifest && typeof pack.manifest === "object" ? pack.manifest : {};
  return extra;
}

function looksLikeAgent(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return false;
  if (packShape.crossSectionMismatch(pack, "agents")) return false;
  const tree = declaredTree(pack);
  if (tree && tree !== "agents") return false;
  if (tree === "agents") return true;
  const manifestName = String(pack.manifestName || "").toLowerCase();
  if (manifestName === "agent" || manifestName === "agents") return true;
  if (manifestName === "skill" || manifestName === "tool" || manifestName === "plugin")
    return false;
  if (packShape.detectPackShape(pack).tree === "agents") return true;
  const extra = nestedManifest(pack);
  if (Array.isArray(pack.agents) || Array.isArray(extra.agents)) return true;
  if (pack.goal || extra.goal) return true;
  if (pack.persona || extra.persona) return true;
  if (pack.role || extra.role) return true;
  return false;
}

function pickSegment(pack) {
  const raw = String(pack.segment || pack.category || "")
    .trim()
    .toLowerCase();
  return AGENT_SEGMENTS.has(raw) ? raw : "installed";
}

/** Fill the agents-tree fields. Never enables the pack. */
function healAgentPack(pack) {
  if (!looksLikeAgent(pack)) {
    const tree = declaredTree(pack);
    const label = tree && tree !== "agents" ? tree : "this file";
    return {
      ok: false,
      error: `Agents page only accepts agent packs. ${label} belongs on its own page.`,
    };
  }
  const extra = nestedManifest(pack);
  const slug = slugify(pack.id || pack.slug || pack.name);
  if (!slug) return { ok: false, error: "The pack needs an id." };
  const name = String(pack.name || slug);
  const description = String(pack.description || pack.summary || pack.name || slug).trim();
  const role = String(pack.role || extra.role || slug).trim() || slug;
  const goal = String(pack.goal || extra.goal || "").trim();
  const persona = String(pack.persona || extra.persona || "").trim();
  const skills = Array.isArray(pack.skills)
    ? pack.skills.map(String)
    : Array.isArray(extra.skills)
      ? extra.skills.map(String)
      : [];
  const agents = Array.isArray(pack.agents)
    ? pack.agents
    : Array.isArray(extra.agents)
      ? extra.agents
      : undefined;
  const segment = pickSegment(pack);
  const missingRole = !(pack.role || extra.role);
  const missingDescription = !String(pack.description || pack.summary || "").trim();
  const manifest = {
    role,
    skills,
    ...(goal ? { goal } : {}),
    ...(persona ? { persona } : {}),
    ...(agents ? { agents } : {}),
  };
  const healed = {
    tree: "agents",
    segment,
    slug,
    id: slug,
    name,
    description,
    category: String(pack.category || "agent"),
    permissions: Array.isArray(pack.permissions) ? pack.permissions.map(String) : [],
    risk: ["safe", "write", "exec"].includes(pack.risk) ? pack.risk : "safe",
    author: String(pack.author || "imported"),
    enabled: false,
    role,
    ...(goal ? { goal } : {}),
    ...(persona ? { persona } : {}),
    ...(agents ? { agents } : {}),
    ...(skills.length ? { skills } : {}),
    tags: Array.isArray(pack.tags) ? pack.tags.map(String) : [],
    manifest,
    files: Array.isArray(pack.files) ? pack.files : [],
    ...(pack.selfTest ? { selfTest: pack.selfTest } : {}),
    healed: Boolean(missingRole || missingDescription || !pack.tree),
  };
  return { ok: true, pack: healed };
}

function flattenPayload(payload) {
  return skillPack.flattenPayload(payload);
}

function prepareAgentsOnly(payload, extra = {}) {
  const items = flattenPayload(payload);
  const nonAgentKinds = new Set(
    extra.nonAgentKinds || extra.nonSkillKinds || extra.nonToolKinds || [],
  );
  const packs = [];
  let skipped = 0;
  for (const item of items) {
    const mismatch = packShape.crossSectionMismatch(item, "agents");
    if (mismatch) {
      skipped += 1;
      nonAgentKinds.add(mismatch.tree);
      continue;
    }
    if (!looksLikeAgent(item)) {
      skipped += 1;
      const tree = declaredTree(item) || packShape.detectPackShape(item).tree;
      if (tree) nonAgentKinds.add(tree);
      continue;
    }
    const healed = healAgentPack(item);
    if (!healed.ok) {
      skipped += 1;
      continue;
    }
    packs.push(healed.pack);
  }
  if (!packs.length) {
    const mismatch = packShape.kindListMismatch(nonAgentKinds, "agents");
    if (mismatch) {
      return { ok: false, error: packShape.refuseError("agents", mismatch), skipped };
    }
    const named = [...nonAgentKinds].filter((k) => k !== "agents");
    const other = named.length ? named.join(", ") : extra.otherHint || "non-agent files";
    return {
      ok: false,
      error: `Agents page only accepts agent packs (manifest.json with agents/goal/persona/role, or JSON with tree "agents"). ${other} belong on their own pages.`,
      skipped,
    };
  }
  return { ok: true, packs, skipped, healed: packs.filter((p) => p.healed).length };
}

function walkFiles(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile())
      out.push({
        name: entry.name,
        full,
        rel: path.relative(base, full).replace(/\\/g, "/"),
      });
  }
  return out;
}

function readText(file, limit = 262_144) {
  try {
    if (!file || !fs.existsSync(file) || fs.statSync(file).size > limit) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function siblingAgentCode(dir) {
  for (const name of ["index.cjs", "index.js"]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return readText(file);
  }
  return "";
}

function extraFiles(dir, skipNames) {
  const skip = new Set(skipNames);
  const files = [];
  for (const entry of walkFiles(dir)) {
    if (skip.has(entry.name)) continue;
    if (!/\.(md|txt|json|mjs|js|cjs|py)$/i.test(entry.name)) continue;
    const content = readText(entry.full);
    if (!content) continue;
    files.push({ path: entry.rel || entry.name, content });
  }
  return files;
}

/** Walk a folder (or extracted zip) and return agent packs plus other kinds seen. */
function collectAgentPacksFromDir(dir) {
  const packs = [];
  const nonAgentKinds = new Set();
  const seen = new Set();
  if (!dir || !fs.existsSync(dir)) return { packs, nonAgentKinds: [] };

  const files = walkFiles(dir);
  for (const file of files) {
    const kind = KIND_FILES[file.name.toLowerCase()];
    if (kind && kind !== "agents") nonAgentKinds.add(kind);
    if (file.name.toLowerCase() === "manifest.json") {
      const data = readJson(file.full) || {};
      const folder = path.dirname(file.full);
      const shape = packShape.detectPackShape({
        ...data,
        filename: file.name,
        code: data.code || siblingAgentCode(folder),
      });
      const tree = declaredTree(data) || shape.tree;
      if (tree && tree !== "agents") nonAgentKinds.add(tree);
    }
  }

  for (const file of files) {
    if (file.name.toLowerCase() !== "agent.json") continue;
    const data = readJson(file.full) || {};
    const folder = path.dirname(file.full);
    const pack = {
      ...data,
      filename: file.name,
      code: data.code || siblingAgentCode(folder),
      files: extraFiles(folder, new Set(["agent.json", "manifest.json", "index.cjs", "index.js"])),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "agents") {
      nonAgentKinds.add(shape.tree);
      continue;
    }
    const slug = slugify(pack.id || pack.slug || pack.name || path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      ...pack,
      tree: data.tree || "agents",
      manifestName: "agent",
      id: slug,
      name: pack.name || slug,
    });
  }

  for (const file of files) {
    if (file.name.toLowerCase() !== "manifest.json") continue;
    const data = readJson(file.full);
    if (!data) continue;
    const folder = path.dirname(file.full);
    const pack = {
      ...data,
      filename: file.name,
      code: data.code || siblingAgentCode(folder),
      files: extraFiles(folder, new Set(["manifest.json", "agent.json", "index.cjs", "index.js"])),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "agents") {
      nonAgentKinds.add(shape.tree);
      continue;
    }
    if (!looksLikeAgent(pack)) continue;
    const slug = slugify(data.id || data.slug || data.name || path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      ...pack,
      tree: data.tree || "agents",
      id: slug,
      name: data.name || slug,
    });
  }

  for (const file of files) {
    if (!/\.json$/i.test(file.name)) continue;
    const lower = file.name.toLowerCase();
    if (lower === "agent.json" || lower === "manifest.json") continue;
    if (KIND_FILES[lower] && lower !== "agent.json") continue;
    const data = readJson(file.full);
    if (!data) continue;
    const folder = path.dirname(file.full);
    const pack = {
      ...data,
      filename: file.name,
      code: data.code || siblingAgentCode(folder),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "agents") {
      nonAgentKinds.add(shape.tree);
      continue;
    }
    if (!looksLikeAgent(pack)) continue;
    const slug = slugify(data.id || data.slug || data.name || file.name.replace(/\.json$/i, ""));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({ ...pack, tree: data.tree || "agents", id: slug, name: data.name || slug });
  }

  return { packs, nonAgentKinds: [...nonAgentKinds] };
}

module.exports = {
  looksLikeAgent,
  healAgentPack,
  prepareAgentsOnly,
  collectAgentPacksFromDir,
};
