// FRIDAY · plugin-pack healer and plugins-only collector.
//
// The Plugins page accepts only plugin-shaped content (plugin.json, or
// manifest.json with a hooks array and CJS entry). Incomplete packs are healed
// into the same plugins-tree shape installPack() already writes. Non-plugin
// trees (skills, tools, agents, modules, workflows, models) are refused here
// so they stay on their own pages. This module does not write the workspace
// — installPack() in capabilities.cjs remains the single writer. Git clone
// reuses skill-pack.stageGitClone.
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

const PLUGIN_SEGMENTS = new Set(["installed", "marketplace", "disabled", "sandbox", "updates"]);

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

const DEFAULT_PLUGIN_CODE = `module.exports = {
  register() {},
  "on-turn-complete": async function (payload, ctx) {
    ctx.fs.writeFile(
      "last-hook.json",
      JSON.stringify({ at: Date.now(), hook: "on-turn-complete", dryRun: true, payload }, null, 2),
    );
    return { ok: true, dryRun: true };
  },
  selfTest() {
    return { ok: true, loaded: true };
  },
};
`;

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
    "plug-in": "plugins",
    addon: "plugins",
    tool: "tools",
    agent: "agents",
    "ai-agent": "agents",
    assistant: "agents",
    module: "modules",
    extension: "modules",
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

function looksLikePlugin(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return false;
  if (packShape.crossSectionMismatch(pack, "plugins")) return false;
  const tree = declaredTree(pack);
  if (tree && tree !== "plugins") return false;
  if (tree === "plugins") return true;
  const manifestName = String(pack.manifestName || pack.filename || "")
    .toLowerCase()
    .split(/[/\\]/)
    .pop();
  if (manifestName === "plugin.json" || manifestName === "plugin") return true;
  if (
    manifestName === "skill.json" ||
    manifestName === "tool.json" ||
    manifestName === "agent.json"
  )
    return false;
  if (packShape.detectPackShape(pack).tree === "plugins") return true;
  return Array.isArray(pack.hooks) || Array.isArray(nestedManifest(pack).hooks);
}

function pickSegment(pack) {
  const raw = String(pack.segment || pack.category || "")
    .trim()
    .toLowerCase();
  return PLUGIN_SEGMENTS.has(raw) ? raw : "installed";
}

function pickEntry(pack) {
  const extra = nestedManifest(pack);
  const raw = String(pack.entry || extra.entry || "").trim();
  if (raw) return raw.replace(/^[\\/]+/, "");
  return "index.cjs";
}

function pickHooks(pack) {
  const extra = nestedManifest(pack);
  const raw = Array.isArray(pack.hooks)
    ? pack.hooks
    : Array.isArray(extra.hooks)
      ? extra.hooks
      : [];
  const hooks = raw.map(String).filter(Boolean);
  return hooks.length ? hooks : ["on-turn-complete"];
}

function healPluginPack(pack) {
  if (!pack || typeof pack !== "object") return { ok: false, error: "not a pack object" };
  const extra = nestedManifest(pack);
  const slug = slugify(pack.slug || pack.id || pack.name || extra.name);
  if (!slug) return { ok: false, error: "The pack needs an id." };
  const name = String(pack.name || extra.name || slug).trim() || slug;
  const description = String(
    pack.description || pack.summary || extra.description || extra.summary || "",
  ).trim();
  const missingDescription = !description;
  let code = String(pack.code || extra.code || "");
  const missingCode = !code.trim();
  if (missingCode) code = DEFAULT_PLUGIN_CODE;
  const hooks = pickHooks(pack);
  const healed = {
    tree: "plugins",
    segment: pickSegment(pack),
    slug,
    id: slug,
    name,
    description: description || `FRIDAY plugin ${name} (healed import).`,
    category: String(pack.category || extra.category || "installed"),
    version: String(pack.version || extra.version || "1.0.0"),
    author: String(pack.author || extra.author || "friday-marketplace"),
    permissions: Array.isArray(pack.permissions)
      ? pack.permissions.map(String)
      : Array.isArray(extra.permissions)
        ? extra.permissions.map(String)
        : [],
    hooks,
    entry: pickEntry(pack),
    enabled: false,
    code,
    selfTest: pack.selfTest || extra.selfTest || { export: "selfTest", input: {} },
    files: Array.isArray(pack.files) ? pack.files : [],
    healed: Boolean(missingDescription || missingCode || !pack.tree || !pack.entry),
  };
  return { ok: true, pack: healed };
}

function flattenPayload(payload) {
  return skillPack.flattenPayload(payload);
}

function preparePluginsOnly(payload, extra = {}) {
  const items = flattenPayload(payload);
  const nonPluginKinds = new Set(
    extra.nonPluginKinds ||
      extra.nonSkillKinds ||
      extra.nonToolKinds ||
      extra.nonAgentKinds ||
      extra.nonModuleKinds ||
      [],
  );
  const packs = [];
  let skipped = 0;
  for (const item of items) {
    const mismatch = packShape.crossSectionMismatch(item, "plugins");
    if (mismatch) {
      skipped += 1;
      nonPluginKinds.add(mismatch.tree);
      continue;
    }
    if (!looksLikePlugin(item)) {
      skipped += 1;
      const tree = declaredTree(item) || packShape.detectPackShape(item).tree;
      if (tree) nonPluginKinds.add(tree);
      continue;
    }
    const healed = healPluginPack(item);
    if (!healed.ok) {
      skipped += 1;
      continue;
    }
    packs.push(healed.pack);
  }
  if (!packs.length) {
    const mismatch = packShape.kindListMismatch(nonPluginKinds, "plugins");
    if (mismatch) {
      return { ok: false, error: packShape.refuseError("plugins", mismatch), skipped };
    }
    const named = [...nonPluginKinds].filter((k) => k !== "plugins");
    const other = named.length ? named.join(", ") : extra.otherHint || "non-plugin files";
    return {
      ok: false,
      error: `Plugins page only accepts plugin packs (plugin.json, or a manifest with a hooks array and CJS entry). ${other} belong on their own pages.`,
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

function siblingPluginCode(dir) {
  for (const name of ["index.cjs", "index.js", "plugin.cjs"]) {
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
    if (!/\.(md|txt|json|cjs|js)$/i.test(entry.name)) continue;
    const content = readText(entry.full);
    if (!content) continue;
    files.push({ path: entry.rel || entry.name, content });
  }
  return files;
}

function collectPluginPacksFromDir(dir) {
  const packs = [];
  const nonPluginKinds = new Set();
  const seen = new Set();
  if (!dir || !fs.existsSync(dir)) return { packs, nonPluginKinds: [] };

  const files = walkFiles(dir);
  for (const file of files) {
    const kind = KIND_FILES[file.name.toLowerCase()];
    if (kind && kind !== "plugins") nonPluginKinds.add(kind);
    if (file.name.toLowerCase() === "manifest.json") {
      const data = readJson(file.full) || {};
      const folder = path.dirname(file.full);
      const shape = packShape.detectPackShape({
        ...data,
        filename: file.name,
        code: data.code || siblingPluginCode(folder),
      });
      const tree = declaredTree(data) || shape.tree;
      if (tree && tree !== "plugins") nonPluginKinds.add(tree);
    }
  }

  for (const file of files) {
    if (file.name.toLowerCase() !== "plugin.json") continue;
    const data = readJson(file.full) || {};
    const folder = path.dirname(file.full);
    const pack = {
      ...data,
      filename: file.name,
      code: data.code || siblingPluginCode(folder),
      files: extraFiles(folder, new Set(["plugin.json", "manifest.json", "index.cjs", "index.js"])),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "plugins") {
      nonPluginKinds.add(shape.tree);
      continue;
    }
    const slug = slugify(pack.id || pack.slug || pack.name || path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      ...pack,
      tree: data.tree || "plugins",
      manifestName: "plugin",
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
      code: data.code || siblingPluginCode(folder),
      files: extraFiles(folder, new Set(["manifest.json", "plugin.json", "index.cjs", "index.js"])),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "plugins") {
      nonPluginKinds.add(shape.tree);
      continue;
    }
    if (!looksLikePlugin(pack)) continue;
    const slug = slugify(data.id || data.slug || data.name || path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      ...pack,
      tree: data.tree || "plugins",
      id: slug,
      name: data.name || slug,
    });
  }

  return { packs, nonPluginKinds: [...nonPluginKinds] };
}

module.exports = {
  looksLikePlugin,
  healPluginPack,
  preparePluginsOnly,
  collectPluginPacksFromDir,
  DEFAULT_PLUGIN_CODE,
};
