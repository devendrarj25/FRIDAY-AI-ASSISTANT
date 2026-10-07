// FRIDAY · skill-pack healer and skills-only collector.
//
// The Skills page accepts only skill-shaped content (skill.json, skill.mjs,
// or JSON with tree/kind "skills"). Incomplete packs are healed into the same
// custom-skill runtime shape installPack() already writes. Non-skill trees
// (plugins, tools, agents, modules, workflows, models) are refused here so
// they stay on their own pages. This module does not write the workspace —
// installPack() in capabilities.cjs remains the single writer.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const packShape = require("./pack-shape.cjs");

const NON_SKILL = new Set(["plugins", "tools", "agents", "modules", "workflows", "models"]);
const TREE_ALIASES = {
  agent: "agents",
  "ai-agent": "agents",
  assistant: "agents",
  skill: "skills",
  ability: "skills",
  plugin: "plugins",
  "plug-in": "plugins",
  addon: "plugins",
  "add-on": "plugins",
  workflow: "workflows",
  automation: "workflows",
  flow: "workflows",
  tool: "tools",
  module: "modules",
  model: "models",
};

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

const STUB_RUN = `// FRIDAY · healed skill stub
// Written because the imported pack had no loadable run(). Replace this with
// real skill logic; the sandbox still has to pass before the skill is enabled.
export async function run(input = {}) {
  return {
    ok: true,
    healed: true,
    input,
    note: "Healed stub — FRIDAY installed a loadable run() so you can test and replace it.",
  };
}
export default run;
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

function hasRun(code) {
  const src = String(code || "");
  return /function\s+run\s*\(|const\s+run\s*=|exports\.run\s*=|export\s+\{[^}]*\brun\b/.test(src);
}

function looksLikeSkill(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return false;
  if (packShape.crossSectionMismatch(pack, "skills")) return false;
  const tree = declaredTree(pack);
  if (tree && tree !== "skills") return false;
  if (tree === "skills") return true;
  if (String(pack.manifestName || "").toLowerCase() === "skill") return true;
  const id = slugify(pack.id || pack.slug || pack.name);
  if (!id) return false;
  if (Array.isArray(pack.inputs) || pack.code || pack.summary || pack.category) return true;
  if (hasRun(pack.code)) return true;
  return false;
}

function wrapRun(code) {
  let src = String(code || "").trim();
  if (!hasRun(src)) return { code: STUB_RUN, healed: true, reason: "missing run()" };
  if (!/export\s+(async\s+)?function\s+run|export\s+default|export\s+\{[^}]*\brun\b/.test(src)) {
    src = `${src}\nexport { run };\nexport default run;\n`;
    return { code: src, healed: true, reason: "added ESM export for run()" };
  }
  return { code: src, healed: false, reason: null };
}

/** Fill the custom-skill runtime fields. Never enables the pack. */
function healSkillPack(pack) {
  if (!looksLikeSkill(pack)) {
    const tree = declaredTree(pack);
    const label = tree && tree !== "skills" ? tree : "this file";
    return {
      ok: false,
      error: `Skills page only accepts skill packs. ${label} belongs on its own page.`,
    };
  }
  const slug = slugify(pack.id || pack.slug || pack.name);
  if (!slug) return { ok: false, error: "The pack needs an id." };
  const wrapped = wrapRun(pack.code);
  const summary = String(pack.summary || pack.description || pack.name || slug).trim();
  const description = String(pack.description || pack.summary || pack.name || slug).trim();
  const healed = {
    tree: "skills",
    segment: "custom",
    slug,
    id: slug,
    name: String(pack.name || slug),
    summary,
    description,
    category: String(pack.category || "custom"),
    capabilities: Array.isArray(pack.capabilities)
      ? pack.capabilities
      : Array.isArray(pack.permissions)
        ? pack.permissions
        : [],
    permissions: Array.isArray(pack.permissions) ? pack.permissions : [],
    risk: ["safe", "write", "exec"].includes(pack.risk) ? pack.risk : "safe",
    inputs: Array.isArray(pack.inputs) ? pack.inputs : [],
    author: String(pack.author || "imported"),
    enabled: false,
    code: wrapped.code,
    selfTest: pack.selfTest || { input: {} },
    files: Array.isArray(pack.files) ? pack.files : [],
    healed: Boolean(wrapped.healed || !pack.summary || !pack.description),
    healedReason: wrapped.reason,
  };
  return { ok: true, pack: healed };
}

function flattenPayload(payload) {
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === "object");
  if (payload && Array.isArray(payload.packs))
    return payload.packs.filter((item) => item && typeof item === "object");
  if (payload && typeof payload === "object") return [payload];
  return [];
}

/**
 * Skills-page gate: keep only skill-shaped packs, heal them, refuse when the
 * payload is entirely another tree.
 */
function prepareSkillsOnly(payload, extra = {}) {
  const items = flattenPayload(payload);
  const nonSkillKinds = new Set(extra.nonSkillKinds || []);
  const packs = [];
  let skipped = 0;
  for (const item of items) {
    const mismatch = packShape.crossSectionMismatch(item, "skills");
    if (mismatch) {
      skipped += 1;
      nonSkillKinds.add(mismatch.tree);
      continue;
    }
    if (!looksLikeSkill(item)) {
      skipped += 1;
      const tree = declaredTree(item) || packShape.detectPackShape(item).tree;
      if (tree) nonSkillKinds.add(tree);
      continue;
    }
    const healed = healSkillPack(item);
    if (!healed.ok) {
      skipped += 1;
      continue;
    }
    packs.push(healed.pack);
  }
  if (!packs.length) {
    const mismatch = packShape.kindListMismatch(nonSkillKinds, "skills");
    if (mismatch) {
      return { ok: false, error: packShape.refuseError("skills", mismatch), skipped };
    }
    const named = [...nonSkillKinds].filter((k) => k !== "skills");
    const other = named.length ? named.join(", ") : extra.otherHint || "non-skill files";
    return {
      ok: false,
      error: `Skills page only accepts skill packs (skill.json / skill.mjs, or JSON with tree "skills"). ${other} belong on their own pages.`,
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
  for (const name of ["skill.mjs", "skill.js", "index.mjs", "index.js"]) {
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

/** Walk a folder (or extracted zip) and return skill packs plus other kinds seen. */
function collectSkillPacksFromDir(dir) {
  const packs = [];
  const nonSkillKinds = new Set();
  const seen = new Set();
  if (!dir || !fs.existsSync(dir)) return { packs, nonSkillKinds: [] };

  const files = walkFiles(dir);
  for (const file of files) {
    const kind = KIND_FILES[file.name.toLowerCase()];
    if (kind && kind !== "skills") nonSkillKinds.add(kind);
    if (file.name.toLowerCase() === "manifest.json") {
      const data = readJson(file.full) || {};
      const folder = path.dirname(file.full);
      const shape = packShape.detectPackShape({
        ...data,
        filename: file.name,
        code: data.code || siblingCode(folder) || readText(path.join(folder, "index.cjs")),
      });
      const tree = declaredTree(data) || shape.tree;
      if (tree && tree !== "skills") nonSkillKinds.add(tree);
    }
  }

  for (const file of files) {
    if (file.name.toLowerCase() !== "skill.json") continue;
    const data = readJson(file.full) || {};
    const folder = path.dirname(file.full);
    const code = siblingCode(folder);
    const pack = {
      ...data,
      filename: file.name,
      code: data.code || code,
      files: extraFiles(folder, new Set(["skill.json", "skill.mjs", "skill.js"])),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "skills") {
      nonSkillKinds.add(shape.tree);
      continue;
    }
    const slug = slugify(pack.id || pack.slug || pack.name || path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({ ...pack, tree: data.tree || "skills", manifestName: "skill" });
  }

  // Folders that only have skill.mjs (no manifest yet).
  for (const file of files) {
    if (!/^skill\.(mjs|js)$/i.test(file.name)) continue;
    const folder = path.dirname(file.full);
    if (fs.existsSync(path.join(folder, "skill.json"))) continue;
    const slug = slugify(path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      tree: "skills",
      id: slug,
      name: slug,
      code: readText(file.full),
      category: "custom",
    });
  }

  // Loose skill-shaped JSON at the root (marketplace pack format).
  for (const file of files) {
    if (!/\.json$/i.test(file.name)) continue;
    if (KIND_FILES[file.name.toLowerCase()] && file.name.toLowerCase() !== "skill.json") continue;
    if (file.name.toLowerCase() === "skill.json") continue;
    const data = readJson(file.full);
    if (!data) continue;
    const folder = path.dirname(file.full);
    const pack = {
      ...data,
      filename: file.name,
      code: data.code || siblingCode(folder),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "skills") {
      nonSkillKinds.add(shape.tree);
      continue;
    }
    if (!looksLikeSkill(pack)) continue;
    const slug = slugify(data.id || data.slug || data.name || file.name.replace(/\.json$/i, ""));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({ ...pack, tree: data.tree || "skills" });
  }

  return { packs, nonSkillKinds: [...nonSkillKinds] };
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 300_000 }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        output: String(stdout || stderr || ""),
        error: err ? String(err.message || err) : "",
      }),
    );
  });
}

function parseGitUrl(raw) {
  const url = String(raw || "").trim();
  if (!url || url.length > 500 || /[\s;|&`$]/.test(url)) return null;
  if (!/^(https?:\/\/|git@)/i.test(url)) return null;
  const github = /github\.com[:/]([^/]+)\/([^/#?\s]+)/i.exec(url);
  const branch = /\/(?:tree|blob)\/([^/]+)/.exec(url)?.[1] || "";
  if (github) {
    const owner = github[1];
    const repo = github[2].replace(/\.git$/i, "").replace(/\/.*$/, "");
    if (!owner || !repo) return null;
    return {
      url: `https://github.com/${owner}/${repo}.git`,
      https: `https://github.com/${owner}/${repo}`,
      owner,
      repo,
      branch: branch || "",
    };
  }
  return {
    url,
    https: url.replace(/\.git$/i, ""),
    owner: "",
    repo: slugify(url).slice(0, 40),
    branch: "",
  };
}

/**
 * Clone a git URL into <workspace>/updates, or download a GitHub zip as fallback.
 * `downloadArchive` is importer.downloadArchive — passed in so tests can stub it.
 */
async function stageGitClone(root, rawUrl, downloadArchive) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const parsed = parseGitUrl(rawUrl);
  if (!parsed) return { ok: false, error: "Paste an https git URL or a GitHub repository URL." };
  const dest = path.join(root, "updates", `skill-git-${Date.now().toString(36)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (parsed.branch) args.push("--branch", parsed.branch, "--single-branch");
  args.push(parsed.url, dest);
  const cloned = await run("git", args);
  if (cloned.ok && fs.existsSync(dest)) return { ok: true, dir: dest, via: "git" };

  if (!parsed.owner || typeof downloadArchive !== "function") {
    return {
      ok: false,
      error:
        cloned.error ||
        cloned.output ||
        "git clone failed. On GitHub, check the URL and that git is installed.",
    };
  }
  const branches = parsed.branch ? [parsed.branch] : ["main", "master"];
  let last = cloned;
  for (const branch of branches) {
    const zip = `${parsed.https}/archive/refs/heads/${branch}.zip`;
    const dl = await downloadArchive({ root, url: zip, name: `${parsed.repo}-${branch}.zip` });
    if (!dl?.ok || !dl.file) {
      last = dl || last;
      continue;
    }
    return { ok: true, file: dl.file, via: "github-zip", branch };
  }
  return {
    ok: false,
    error: last?.error || last?.output || "Could not clone or download that repository.",
  };
}

/**
 * Attach sibling skill.mjs bodies onto GitHub JSON packs that have no `code`
 * yet. One file maps to at most one pack (folder slug === pack id/slug/name).
 * A payload of exactly one pack may take the only sibling file. Never assign
 * one file to every pack that is still missing code.
 */
function attachSiblingSkillCode(packs, files) {
  const list = Array.isArray(packs) ? packs : [];
  const sources = Array.isArray(files) ? files : [];
  for (const file of sources) {
    const code = String(file?.code || "");
    if (!code) continue;
    const filePath = String(file.path || file.name || "").replace(/\\/g, "/");
    const folder = filePath.replace(/\/skill\.json$/i, "");
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
  looksLikeSkill,
  healSkillPack,
  prepareSkillsOnly,
  collectSkillPacksFromDir,
  flattenPayload,
  parseGitUrl,
  stageGitClone,
  attachSiblingSkillCode,
  STUB_RUN,
};
