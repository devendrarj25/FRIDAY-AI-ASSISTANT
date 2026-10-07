// FRIDAY · tool-pack healer and tools-only collector.
//
// The Tools page accepts only tool-shaped content (tool.json, index.cjs,
// or JSON with tree/kind "tools"). Incomplete packs are healed into the same
// shipped-tool runtime shape (tool.json + index.cjs run()). Non-tool trees
// are refused here so they stay on their own pages. This module does not
// write the workspace — installPack() in capabilities.cjs remains the single
// writer. Git clone reuses skill-pack.stageGitClone (one clone helper).
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

const STUB_RUN = `// FRIDAY · healed tool stub
// Written because the imported pack had no loadable run(). Replace this with
// real tool logic; the sandbox still has to pass before the tool is enabled.
async function run(input = {}) {
  return {
    ok: true,
    healed: true,
    input,
    note: "Healed stub — FRIDAY installed a loadable run() so you can test and replace it.",
  };
}
module.exports = { run };
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

function hasRun(code) {
  const src = String(code || "");
  return /function\s+run\s*\(|const\s+run\s*=|exports\.run\s*=|export\s+\{[^}]*\brun\b/.test(src);
}

function looksLikeTool(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return false;
  if (packShape.crossSectionMismatch(pack, "tools")) return false;
  const tree = declaredTree(pack);
  if (tree && tree !== "tools") return false;
  if (tree === "tools") return true;
  if (String(pack.manifestName || "").toLowerCase() === "tool") return true;
  if (String(pack.manifestName || "").toLowerCase() === "skill") return false;
  const id = slugify(pack.id || pack.slug || pack.name);
  if (!id) return false;
  if (pack.entry === "index.cjs" || pack.entry === "index.js") return true;
  const category = String(pack.category || pack.segment || "").toLowerCase();
  if (TOOL_SEGMENTS.has(category)) return true;
  if (Array.isArray(pack.inputs) && (pack.approvalPrompt || pack.permissions || pack.risk))
    return true;
  // looksLikeSkill treats any pack with `code` or `inputs` as a skill. On this
  // page, CJS run() / module.exports is the shipped-tool shape — keep it.
  const src = String(pack.code || "");
  if (hasRun(src) && /module\.exports|exports\.run/.test(src)) return true;
  if (hasRun(src) && !/export\s+(async\s+)?function\s+run|export\s+\{[^}]*\brun\b/.test(src))
    return true;
  return false;
}

function toCjs(code) {
  let src = String(code || "").trim();
  if (!src) return src;
  src = src.replace(/export\s+default\s+run\s*;?/g, "");
  src = src.replace(/export\s*\{[^}]*\brun\b[^}]*\}\s*;?/g, "");
  src = src.replace(/export\s+async\s+function\s+run/g, "async function run");
  src = src.replace(/export\s+function\s+run/g, "function run");
  return src.trim();
}

function wrapRun(code) {
  const original = String(code || "").trim();
  if (!hasRun(original)) return { code: STUB_RUN, healed: true, reason: "missing run()" };
  let src = toCjs(original);
  const converted = src !== original;
  if (!/module\.exports|exports\.run/.test(src)) {
    src = `${src}\nmodule.exports = { run };\n`;
    return {
      code: src,
      healed: true,
      reason: converted ? "converted ESM run() to CJS" : "added CJS export for run()",
    };
  }
  if (converted) return { code: src, healed: true, reason: "converted ESM run() to CJS" };
  return { code: src, healed: false, reason: null };
}

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

/** Fill shipped-tool fields. Never enables the pack. */
function healToolPack(pack) {
  if (!looksLikeTool(pack)) {
    const tree = declaredTree(pack);
    const label = tree && tree !== "tools" ? tree : "this file";
    return {
      ok: false,
      error: `Tools page only accepts tool packs. ${label} belongs on its own page.`,
    };
  }
  const slug = slugify(pack.id || pack.slug || pack.name);
  if (!slug) return { ok: false, error: "The pack needs an id." };
  const wrapped = wrapRun(pack.code);
  const description = String(pack.description || pack.summary || pack.name || slug).trim();
  const categoryRaw = String(pack.category || pack.segment || "custom")
    .trim()
    .toLowerCase();
  const category = TOOL_SEGMENTS.has(categoryRaw) ? categoryRaw : "custom";
  const name = String(pack.name || slug);
  const healed = {
    tree: "tools",
    segment: category,
    slug,
    id: slug,
    name,
    version: String(pack.version || "1.0.0"),
    description,
    category,
    entry: "index.cjs",
    inputs: Array.isArray(pack.inputs) ? pack.inputs.map(String) : [],
    permissions: Array.isArray(pack.permissions) ? pack.permissions.map(String) : [],
    risk: ["safe", "write", "exec"].includes(pack.risk) ? pack.risk : "safe",
    enabled: false,
    approvalPrompt: String(
      pack.approvalPrompt || `FRIDAY wants to run the tool “${name}”. Allow this?`,
    ).trim(),
    author: String(pack.author || "imported"),
    code: wrapped.code,
    selfTest: pack.selfTest || { input: {} },
    files: Array.isArray(pack.files) ? pack.files : [],
    keywords: Array.isArray(pack.keywords) ? pack.keywords.map(String).slice(0, 24) : [],
    healed: Boolean(wrapped.healed || !pack.description || !pack.approvalPrompt),
    healedReason: wrapped.reason,
  };
  return { ok: true, pack: healed };
}

function flattenPayload(payload) {
  return skillPack.flattenPayload(payload);
}

function prepareToolsOnly(payload, extra = {}) {
  const items = flattenPayload(payload);
  const nonToolKinds = new Set(extra.nonToolKinds || extra.nonSkillKinds || []);
  const packs = [];
  let skipped = 0;
  for (const item of items) {
    const mismatch = packShape.crossSectionMismatch(item, "tools");
    if (mismatch) {
      skipped += 1;
      nonToolKinds.add(mismatch.tree);
      continue;
    }
    if (!looksLikeTool(item)) {
      skipped += 1;
      const tree = declaredTree(item) || packShape.detectPackShape(item).tree;
      if (tree) nonToolKinds.add(tree);
      continue;
    }
    const healed = healToolPack(item);
    if (!healed.ok) {
      skipped += 1;
      continue;
    }
    packs.push(healed.pack);
  }
  if (!packs.length) {
    const mismatch = packShape.kindListMismatch(nonToolKinds, "tools");
    if (mismatch) {
      return { ok: false, error: packShape.refuseError("tools", mismatch), skipped };
    }
    const named = [...nonToolKinds].filter((k) => k !== "tools");
    const other = named.length ? named.join(", ") : extra.otherHint || "non-tool files";
    return {
      ok: false,
      error: `Tools page only accepts tool packs (tool.json / index.cjs, or JSON with tree "tools"). ${other} belong on their own pages.`,
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

function siblingCode(dir) {
  for (const name of ["index.cjs", "index.js", "tool.cjs", "tool.js"]) {
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

/** Walk a folder (or extracted zip) and return tool packs plus other kinds seen. */
function collectToolPacksFromDir(dir) {
  const packs = [];
  const nonToolKinds = new Set();
  const seen = new Set();
  if (!dir || !fs.existsSync(dir)) return { packs, nonToolKinds: [] };

  const files = walkFiles(dir);
  for (const file of files) {
    const kind = KIND_FILES[file.name.toLowerCase()];
    if (kind && kind !== "tools") nonToolKinds.add(kind);
    if (file.name.toLowerCase() === "manifest.json") {
      const data = readJson(file.full) || {};
      const folder = path.dirname(file.full);
      const shape = packShape.detectPackShape({
        ...data,
        filename: file.name,
        code: data.code || siblingCode(folder) || readText(path.join(folder, "index.cjs")),
      });
      const tree = declaredTree(data) || shape.tree;
      if (tree && tree !== "tools") nonToolKinds.add(tree);
    }
  }

  for (const file of files) {
    if (file.name.toLowerCase() !== "tool.json") continue;
    const data = readJson(file.full) || {};
    const folder = path.dirname(file.full);
    const code = siblingCode(folder);
    const pack = {
      ...data,
      filename: file.name,
      code: data.code || code,
      files: extraFiles(folder, new Set(["tool.json", "index.cjs", "index.js"])),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "tools") {
      nonToolKinds.add(shape.tree);
      continue;
    }
    const slug = slugify(pack.id || pack.slug || pack.name || path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      ...pack,
      tree: data.tree || "tools",
      manifestName: "tool",
      id: slug,
      name: pack.name || slug,
    });
  }

  for (const file of files) {
    if (!/^index\.(cjs|js)$/i.test(file.name)) continue;
    const folder = path.dirname(file.full);
    if (fs.existsSync(path.join(folder, "tool.json"))) continue;
    const otherKind = Object.keys(KIND_FILES).some(
      (name) => name !== "tool.json" && fs.existsSync(path.join(folder, name)),
    );
    if (otherKind) continue;
    const slug = slugify(path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      tree: "tools",
      id: slug,
      name: slug,
      code: readText(file.full),
      category: "custom",
    });
  }

  for (const file of files) {
    if (!/\.json$/i.test(file.name)) continue;
    if (KIND_FILES[file.name.toLowerCase()] && file.name.toLowerCase() !== "tool.json") continue;
    if (file.name.toLowerCase() === "tool.json") continue;
    const data = readJson(file.full);
    if (!data) continue;
    const folder = path.dirname(file.full);
    const pack = {
      ...data,
      filename: file.name,
      code: data.code || siblingCode(folder),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "tools") {
      nonToolKinds.add(shape.tree);
      continue;
    }
    if (!looksLikeTool(pack)) continue;
    const slug = slugify(data.id || data.slug || data.name || file.name.replace(/\.json$/i, ""));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({ ...pack, tree: data.tree || "tools", id: slug, name: data.name || slug });
  }

  return { packs, nonToolKinds: [...nonToolKinds] };
}

function attachSiblingToolCode(packs, files) {
  const list = Array.isArray(packs) ? packs : [];
  const sources = Array.isArray(files) ? files : [];
  for (const file of sources) {
    const code = String(file?.code || "");
    if (!code) continue;
    const filePath = String(file.path || file.name || "").replace(/\\/g, "/");
    const folder = filePath.replace(/\/tool\.json$/i, "").replace(/\/index\.cjs$/i, "");
    const base = folder.split("/").filter(Boolean).pop() || "";
    const matches = [];
    for (const pack of list) {
      if (!pack || typeof pack !== "object" || pack.code) continue;
      if (list.length === 1) {
        matches.push(pack);
        break;
      }
      const slug = slugify(pack.id || pack.slug || pack.name);
      if (!slug) continue;
      if (base === slug || folder === slug || folder.endsWith(`/${slug}`)) matches.push(pack);
    }
    if (matches.length === 1) matches[0].code = code;
  }
  return list;
}

module.exports = {
  looksLikeTool,
  healToolPack,
  prepareToolsOnly,
  collectToolPacksFromDir,
  attachSiblingToolCode,
  STUB_RUN,
};
