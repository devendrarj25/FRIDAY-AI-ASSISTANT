// FRIDAY · module-pack healer and modules-only collector.
//
// The Modules page accepts only module-shaped content (manifest.json with
// entry + permissions, optional ui, no plan()/run() and no tool-style
// risk+approvalPrompt pair, or module.json). Incomplete packs are healed
// into the same modules-tree shape installPack() already writes. Non-module
// trees (skills, tools, agents, plugins, workflows, models) are refused here
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

const MODULE_SEGMENTS = new Set([
  "ai",
  "system",
  "automation",
  "communication",
  "developer",
  "ui",
  "custom",
  "installed",
]);

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

const DEFAULT_MODULE_CODE = `"""FRIDAY module (healed import). Dry-run inspect of a folder via fs.read."""
MANIFEST = None


def register(manifest):
    global MANIFEST
    MANIFEST = manifest


async def run(tools, folder="."):
    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    return {"ok": True, "dryRun": True, "folder": folder, "entries": listing.get("entries", [])}


def self_test(payload=None):
    return {"ok": True, "loaded": True, "name": (MANIFEST or {}).get("name")}
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

function looksLikeModule(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return false;
  if (packShape.crossSectionMismatch(pack, "modules")) return false;
  const tree = declaredTree(pack);
  if (tree && tree !== "modules") return false;
  if (tree === "modules") return true;
  const manifestName = String(pack.manifestName || "").toLowerCase();
  if (manifestName === "module" || manifestName === "modules") return true;
  if (manifestName === "skill" || manifestName === "tool" || manifestName === "agent") return false;
  if (packShape.detectPackShape(pack).tree === "modules") return true;
  return Boolean(packShape.isModuleish(pack));
}

function pickSegment(pack) {
  const raw = String(pack.segment || pack.category || "")
    .trim()
    .toLowerCase();
  return MODULE_SEGMENTS.has(raw) ? raw : "custom";
}

function pickEntry(pack) {
  const extra = nestedManifest(pack);
  const raw = String(pack.entry || extra.entry || "").trim();
  if (raw) return raw.replace(/^[\\/]+/, "");
  const code = String(pack.code || extra.code || "");
  if (code.includes("module.exports") || /exports\.run\s*=/.test(code)) return "index.cjs";
  return "main.py";
}

function pickUi(pack) {
  const extra = nestedManifest(pack);
  const ui = pack.ui || extra.ui;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) return undefined;
  const page = String(ui.page || "").trim();
  const icon = String(ui.icon || "").trim();
  if (!page && !icon) return undefined;
  return { ...(page ? { page } : {}), ...(icon ? { icon } : {}) };
}

/** Fill the modules-tree fields. Never enables the pack. */
function healModulePack(pack) {
  if (!looksLikeModule(pack)) {
    const tree = declaredTree(pack);
    const label = tree && tree !== "modules" ? tree : "this file";
    return {
      ok: false,
      error: `Modules page only accepts module packs. ${label} belongs on its own page.`,
    };
  }
  const extra = nestedManifest(pack);
  const slug = slugify(pack.id || pack.slug || pack.name);
  if (!slug) return { ok: false, error: "The pack needs an id." };
  const name = String(pack.name || slug);
  const description = String(pack.description || pack.summary || pack.name || slug).trim();
  const entry = pickEntry(pack);
  const ui = pickUi(pack);
  const segment = pickSegment(pack);
  const permissions = Array.isArray(pack.permissions)
    ? pack.permissions.map(String)
    : Array.isArray(extra.permissions)
      ? extra.permissions.map(String)
      : [];
  const code = pack.code || extra.code || "";
  const missingDescription = !String(pack.description || pack.summary || "").trim();
  const missingCode = !String(code).trim();
  const healed = {
    tree: "modules",
    segment,
    slug,
    id: slug,
    name,
    description,
    category: String(pack.category || segment),
    permissions,
    entry,
    author: String(pack.author || "imported"),
    enabled: false,
    ...(ui ? { ui } : {}),
    code: missingCode ? DEFAULT_MODULE_CODE : String(code),
    files: Array.isArray(pack.files) ? pack.files : [],
    ...(pack.selfTest ? { selfTest: pack.selfTest } : {}),
    healed: Boolean(missingDescription || missingCode || !pack.tree || !pack.entry),
  };
  return { ok: true, pack: healed };
}

function flattenPayload(payload) {
  return skillPack.flattenPayload(payload);
}

function prepareModulesOnly(payload, extra = {}) {
  const items = flattenPayload(payload);
  const nonModuleKinds = new Set(
    extra.nonModuleKinds || extra.nonSkillKinds || extra.nonToolKinds || extra.nonAgentKinds || [],
  );
  const packs = [];
  let skipped = 0;
  for (const item of items) {
    const mismatch = packShape.crossSectionMismatch(item, "modules");
    if (mismatch) {
      skipped += 1;
      nonModuleKinds.add(mismatch.tree);
      continue;
    }
    if (!looksLikeModule(item)) {
      skipped += 1;
      const tree = declaredTree(item) || packShape.detectPackShape(item).tree;
      if (tree) nonModuleKinds.add(tree);
      continue;
    }
    const healed = healModulePack(item);
    if (!healed.ok) {
      skipped += 1;
      continue;
    }
    packs.push(healed.pack);
  }
  if (!packs.length) {
    const mismatch = packShape.kindListMismatch(nonModuleKinds, "modules");
    if (mismatch) {
      return { ok: false, error: packShape.refuseError("modules", mismatch), skipped };
    }
    const named = [...nonModuleKinds].filter((k) => k !== "modules");
    const other = named.length ? named.join(", ") : extra.otherHint || "non-module files";
    return {
      ok: false,
      error: `Modules page only accepts module packs (manifest.json with entry and permissions, optional ui, or JSON with tree "modules"). ${other} belong on their own pages.`,
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

function siblingModuleCode(dir) {
  for (const name of ["main.py", "index.cjs", "index.js", "index.mjs"]) {
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

/** Walk a folder (or extracted zip) and return module packs plus other kinds seen. */
function collectModulePacksFromDir(dir) {
  const packs = [];
  const nonModuleKinds = new Set();
  const seen = new Set();
  if (!dir || !fs.existsSync(dir)) return { packs, nonModuleKinds: [] };

  const files = walkFiles(dir);
  for (const file of files) {
    const kind = KIND_FILES[file.name.toLowerCase()];
    if (kind && kind !== "modules") nonModuleKinds.add(kind);
    if (file.name.toLowerCase() === "manifest.json") {
      const data = readJson(file.full) || {};
      const folder = path.dirname(file.full);
      const shape = packShape.detectPackShape({
        ...data,
        filename: file.name,
        code: data.code || siblingModuleCode(folder),
      });
      const tree = declaredTree(data) || shape.tree;
      if (tree && tree !== "modules") nonModuleKinds.add(tree);
    }
  }

  for (const file of files) {
    if (file.name.toLowerCase() !== "module.json") continue;
    const data = readJson(file.full) || {};
    const folder = path.dirname(file.full);
    const pack = {
      ...data,
      filename: file.name,
      code: data.code || siblingModuleCode(folder),
      files: extraFiles(
        folder,
        new Set(["module.json", "manifest.json", "main.py", "index.cjs", "index.js"]),
      ),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "modules") {
      nonModuleKinds.add(shape.tree);
      continue;
    }
    const slug = slugify(pack.id || pack.slug || pack.name || path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      ...pack,
      tree: data.tree || "modules",
      manifestName: "module",
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
      code: data.code || siblingModuleCode(folder),
      files: extraFiles(
        folder,
        new Set(["manifest.json", "module.json", "main.py", "index.cjs", "index.js"]),
      ),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "modules") {
      nonModuleKinds.add(shape.tree);
      continue;
    }
    if (!looksLikeModule(pack)) continue;
    const slug = slugify(data.id || data.slug || data.name || path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      ...pack,
      tree: data.tree || "modules",
      id: slug,
      name: data.name || slug,
    });
  }

  for (const file of files) {
    if (!/\.json$/i.test(file.name)) continue;
    const lower = file.name.toLowerCase();
    if (lower === "module.json" || lower === "manifest.json") continue;
    if (KIND_FILES[lower] && lower !== "module.json") continue;
    const data = readJson(file.full);
    if (!data) continue;
    const folder = path.dirname(file.full);
    const pack = {
      ...data,
      filename: file.name,
      code: data.code || siblingModuleCode(folder),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "modules") {
      nonModuleKinds.add(shape.tree);
      continue;
    }
    if (!looksLikeModule(pack)) continue;
    const slug = slugify(data.id || data.slug || data.name || file.name.replace(/\.json$/i, ""));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({ ...pack, tree: data.tree || "modules", id: slug, name: data.name || slug });
  }

  return { packs, nonModuleKinds: [...nonModuleKinds] };
}

module.exports = {
  looksLikeModule,
  healModulePack,
  prepareModulesOnly,
  collectModulePacksFromDir,
  DEFAULT_MODULE_CODE,
};
