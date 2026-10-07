// FRIDAY · workflow-pack healer and workflows-only collector.
//
// The Workflows page accepts only workflow-shaped content (workflow.json, or
// a manifest with steps/nodes/schedule). Incomplete packs are healed into the
// same workflows-tree shape installPack() already writes. Non-workflow trees
// (skills, tools, agents, modules, plugins, models) are refused here so they
// stay on their own pages. This module does not write the workspace —
// installPack() in capabilities.cjs remains the single writer. Git clone
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

const WORKFLOW_SEGMENTS = new Set(["active", "saved", "templates", "schedules", "history"]);
const STEP_KINDS = new Set(["skill", "tool", "agent", "module", "connector", "note"]);
const RISKS = new Set(["safe", "write", "exec"]);

const SKIP_JSON = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "tsconfig.json",
  "jsconfig.json",
  "friday-version.json",
  "capabilities.json",
  "components.json",
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

const DEFAULT_STEPS = [
  {
    id: "inspect",
    label: "Inspect local filenames",
    kind: "note",
    ref: "inspect",
    risk: "safe",
  },
  {
    id: "summarise",
    label: "Summarise findings locally",
    kind: "note",
    ref: "summarise",
    risk: "safe",
  },
  {
    id: "record",
    label: "Keep the plan in a local note — no publish",
    kind: "note",
    ref: "record",
    risk: "safe",
  },
];

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
    automation: "workflows",
    flow: "workflows",
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

function looksLikeWorkflow(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) return false;
  if (packShape.crossSectionMismatch(pack, "workflows")) return false;
  const tree = declaredTree(pack);
  if (tree && tree !== "workflows") return false;
  if (tree === "workflows") return true;
  const manifestName = String(pack.manifestName || pack.filename || "")
    .toLowerCase()
    .split(/[/\\]/)
    .pop();
  if (manifestName === "workflow.json" || manifestName === "workflow") return true;
  if (
    manifestName === "skill.json" ||
    manifestName === "tool.json" ||
    manifestName === "agent.json" ||
    manifestName === "plugin.json" ||
    manifestName === "module.json"
  )
    return false;
  if (packShape.detectPackShape(pack).tree === "workflows") return true;
  const extra = nestedManifest(pack);
  return (
    Array.isArray(pack.steps) ||
    Array.isArray(pack.nodes) ||
    Boolean(pack.schedule) ||
    Array.isArray(extra.steps) ||
    Array.isArray(extra.nodes) ||
    Boolean(extra.schedule) ||
    Boolean(extra.trigger)
  );
}

function pickSegment(pack) {
  const raw = String(pack.segment || "")
    .trim()
    .toLowerCase();
  return WORKFLOW_SEGMENTS.has(raw) ? raw : "saved";
}

function normalizeSteps(raw) {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_STEPS.map((step) => ({ ...step }));
  return raw.map((item, index) => {
    if (typeof item === "string") {
      const label = String(item).trim() || `step-${index + 1}`;
      return {
        id: `s${index + 1}`,
        label,
        kind: "note",
        ref: label,
        risk: "safe",
      };
    }
    const rec = item && typeof item === "object" ? item : {};
    const kind = STEP_KINDS.has(String(rec.kind || "")) ? String(rec.kind) : "note";
    const risk = RISKS.has(String(rec.risk || "")) ? String(rec.risk) : "safe";
    const label = String(rec.label || rec.name || rec.ref || `step-${index + 1}`).trim();
    return {
      id: String(rec.id || `s${index + 1}`).trim() || `s${index + 1}`,
      label,
      kind,
      ref: String(rec.ref || rec.id || label).trim(),
      risk,
    };
  });
}

function pickSteps(pack) {
  const extra = nestedManifest(pack);
  if (Array.isArray(pack.steps) && pack.steps.length) return normalizeSteps(pack.steps);
  if (Array.isArray(extra.steps) && extra.steps.length) return normalizeSteps(extra.steps);
  if (Array.isArray(pack.nodes) && pack.nodes.length) return normalizeSteps(pack.nodes);
  if (Array.isArray(extra.nodes) && extra.nodes.length) return normalizeSteps(extra.nodes);
  return DEFAULT_STEPS.map((step) => ({ ...step }));
}

function pickSchedule(pack) {
  const extra = nestedManifest(pack);
  return (
    String(pack.schedule || extra.schedule || extra.trigger || "on demand").trim() || "on demand"
  );
}

function healWorkflowPack(pack) {
  if (!pack || typeof pack !== "object") return { ok: false, error: "not a pack object" };
  const extra = nestedManifest(pack);
  const slug = slugify(pack.slug || pack.id || pack.name || extra.name);
  if (!slug) return { ok: false, error: "The pack needs an id." };
  const name = String(pack.name || extra.name || slug).trim() || slug;
  const description = String(
    pack.description || pack.summary || extra.description || extra.summary || "",
  ).trim();
  const missingDescription = !description;
  const rawSteps = Array.isArray(pack.steps)
    ? pack.steps
    : Array.isArray(extra.steps)
      ? extra.steps
      : Array.isArray(pack.nodes)
        ? pack.nodes
        : [];
  const missingSteps = !rawSteps.length;
  const steps = pickSteps(pack);
  const healed = {
    tree: "workflows",
    segment: pickSegment(pack),
    slug,
    id: slug,
    name,
    description: description || `FRIDAY workflow ${name} (healed import).`,
    category: String(pack.category || extra.category || "saved"),
    version: String(pack.version || extra.version || "1.0.0"),
    author: String(pack.author || extra.author || "friday-marketplace"),
    permissions: Array.isArray(pack.permissions)
      ? pack.permissions.map(String)
      : Array.isArray(extra.permissions)
        ? extra.permissions.map(String)
        : [],
    risk: RISKS.has(String(pack.risk || extra.risk || ""))
      ? String(pack.risk || extra.risk)
      : "safe",
    schedule: pickSchedule(pack),
    steps,
    inputs: Array.isArray(pack.inputs)
      ? pack.inputs.map(String)
      : Array.isArray(extra.inputs)
        ? extra.inputs.map(String)
        : [],
    enabled: false,
    files: Array.isArray(pack.files) ? pack.files : [],
    healed: Boolean(missingDescription || missingSteps || !pack.tree),
  };
  return { ok: true, pack: healed };
}

function flattenPayload(payload) {
  return skillPack.flattenPayload(payload);
}

function prepareWorkflowsOnly(payload, extra = {}) {
  const items = flattenPayload(payload);
  const nonWorkflowKinds = new Set(
    extra.nonWorkflowKinds ||
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
    const mismatch = packShape.crossSectionMismatch(item, "workflows");
    if (mismatch) {
      skipped += 1;
      nonWorkflowKinds.add(mismatch.tree);
      continue;
    }
    if (!looksLikeWorkflow(item)) {
      skipped += 1;
      const tree = declaredTree(item) || packShape.detectPackShape(item).tree;
      if (tree) nonWorkflowKinds.add(tree);
      continue;
    }
    const healed = healWorkflowPack(item);
    if (!healed.ok) {
      skipped += 1;
      continue;
    }
    packs.push(healed.pack);
  }
  if (!packs.length) {
    const mismatch = packShape.kindListMismatch(nonWorkflowKinds, "workflows");
    if (mismatch) {
      return { ok: false, error: packShape.refuseError("workflows", mismatch), skipped };
    }
    const named = [...nonWorkflowKinds].filter((k) => k !== "workflows");
    const other = named.length ? named.join(", ") : extra.otherHint || "non-workflow files";
    return {
      ok: false,
      error: `Workflows page only accepts workflow packs (workflow.json, or a manifest with steps/nodes/schedule). ${other} belong on their own pages.`,
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

function extraFiles(dir, skipNames) {
  const skip = new Set(skipNames);
  const files = [];
  for (const entry of walkFiles(dir)) {
    if (skip.has(entry.name)) continue;
    if (!/\.(md|txt|json)$/i.test(entry.name)) continue;
    const content = readText(entry.full);
    if (!content) continue;
    files.push({ path: entry.rel || entry.name, content });
  }
  return files;
}

function collectWorkflowPacksFromDir(dir) {
  const packs = [];
  const nonWorkflowKinds = new Set();
  const seen = new Set();
  if (!dir || !fs.existsSync(dir)) return { packs, nonWorkflowKinds: [] };

  const files = walkFiles(dir);
  for (const file of files) {
    const kind = KIND_FILES[file.name.toLowerCase()];
    if (kind && kind !== "workflows") nonWorkflowKinds.add(kind);
    if (file.name.toLowerCase() === "manifest.json") {
      const data = readJson(file.full) || {};
      const shape = packShape.detectPackShape({
        ...data,
        filename: file.name,
      });
      const tree = declaredTree(data) || shape.tree;
      if (tree && tree !== "workflows") nonWorkflowKinds.add(tree);
    }
  }

  for (const file of files) {
    if (file.name.toLowerCase() !== "workflow.json") continue;
    const data = readJson(file.full) || {};
    const folder = path.dirname(file.full);
    const pack = {
      ...data,
      filename: file.name,
      files: extraFiles(folder, new Set(["workflow.json", "manifest.json"])),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "workflows") {
      nonWorkflowKinds.add(shape.tree);
      continue;
    }
    const slug = slugify(pack.id || pack.slug || pack.name || path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      ...pack,
      tree: data.tree || "workflows",
      manifestName: "workflow",
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
      files: extraFiles(folder, new Set(["manifest.json", "workflow.json"])),
    };
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "workflows") {
      nonWorkflowKinds.add(shape.tree);
      continue;
    }
    if (!looksLikeWorkflow(pack)) continue;
    const slug = slugify(data.id || data.slug || data.name || path.basename(folder));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      ...pack,
      tree: data.tree || "workflows",
      id: slug,
      name: data.name || slug,
    });
  }

  for (const file of files) {
    if (!/\.json$/i.test(file.name)) continue;
    const lower = file.name.toLowerCase();
    if (lower === "workflow.json" || lower === "manifest.json") continue;
    if (SKIP_JSON.has(lower)) continue;
    if (KIND_FILES[lower] && KIND_FILES[lower] !== "workflows") continue;
    const data = readJson(file.full);
    if (!data) continue;
    const folder = path.dirname(file.full);
    const pack = {
      ...data,
      filename: file.name,
      files: extraFiles(folder, new Set([file.name, "workflow.json", "manifest.json"])),
    };
    if (!looksLikeWorkflow(pack)) continue;
    const shape = packShape.detectPackShape(pack);
    if (shape.tree && shape.tree !== "workflows") {
      nonWorkflowKinds.add(shape.tree);
      continue;
    }
    const slug = slugify(
      data.id || data.slug || data.name || path.basename(folder, path.extname(file.name)),
    );
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    packs.push({
      ...pack,
      tree: data.tree || "workflows",
      manifestName: "workflow",
      id: slug,
      name: data.name || slug,
    });
  }

  return { packs, nonWorkflowKinds: [...nonWorkflowKinds] };
}

module.exports = {
  looksLikeWorkflow,
  healWorkflowPack,
  prepareWorkflowsOnly,
  collectWorkflowPacksFromDir,
  normalizeSteps,
  DEFAULT_STEPS,
};
