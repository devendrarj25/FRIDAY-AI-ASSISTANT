// FRIDAY · capability discovery (manifest-driven).
//
// One canonical discovery pass over every capability tree — agents, skills,
// tools, modules, plugins, workflows, models — in BOTH the application folder
// and the selected workspace root. A capability is either:
//
//   <tree>/<segment>/<name>/manifest.json     (folder capability)
//   <tree>/manifests/<name>.json              (flat manifest)
//
// Drop a folder + manifest in the right place and it shows up at the next boot
// (or immediately, because the tree folders are watched) — no UI code changes,
// no registry edits. Enabled state lives in <workspace>/config/capabilities.json
// so a toggle survives a restart.
const fs = require("fs");
const path = require("path");

/**
 * Real path containment. A string prefix test would accept a sibling folder
 * whose name merely starts with the workspace name, so the relative path
 * between the two is checked instead.
 */
function contains(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Capability trees come from the ONE structure contract shared with
// core/discovery.ts, friday-paths and workspace verification — one definition,
// no second registry that could disagree about segments or manifest names.
const TREES = require("./friday-contract.cjs").TREES;
const packShape = require("./pack-shape.cjs");

const RISKS = new Set(["safe", "write", "exec"]);
const STATE_FILE = path.join("config", "capabilities.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function overridesFile(workspaceRoot) {
  return path.join(workspaceRoot, STATE_FILE);
}

function readOverrides(workspaceRoot) {
  if (!workspaceRoot) return {};
  return readJson(overridesFile(workspaceRoot)) || {};
}

/**
 * Real install state for one discovered capability.
 *
 * "Installed" is never just "the folder exists": the manifest must parse, the
 * entry file it declares must be on disk, and every capability it depends on
 * (manifest `requires: ["tree/segment/name", …]`) must itself be present.
 */
function entryExists(target, entry, roots) {
  if (!entry) return true;
  if (fs.existsSync(path.join(target, entry))) return true;
  const file = String(entry).split("#")[0];
  if (!file) return false;
  return (roots || []).some((root) => root && fs.existsSync(path.join(root, file)));
}

function health(tree, segment, target, manifest, manifestFile, roots) {
  const problems = [];
  if (!manifest) problems.push("no manifest");
  const entry = manifest && manifest.entry ? String(manifest.entry) : null;
  const isFolder = manifestFile !== target;
  if (entry && isFolder && !entryExists(target, entry, roots))
    problems.push(`missing entry ${entry}`);
  const requires = Array.isArray(manifest && manifest.requires)
    ? manifest.requires.map(String)
    : [];
  const missingDeps = requires.filter(
    (dep) => !roots.some((root) => root && fs.existsSync(path.join(root, ...dep.split("/")))),
  );
  for (const dep of missingDeps) problems.push(`missing dependency ${dep}`);
  return {
    requires,
    missingDependencies: missingDeps,
    problems,
    healthy: problems.length === 0,
  };
}

function packSkills(m) {
  const nested = m && m.manifest && Array.isArray(m.manifest.skills) ? m.manifest.skills : [];
  const top = Array.isArray(m && m.skills) ? m.skills : nested;
  return top.map(String).filter(Boolean);
}

function packWorkflows(m) {
  const nested = m && m.manifest && Array.isArray(m.manifest.workflows) ? m.manifest.workflows : [];
  const top = Array.isArray(m && m.workflows) ? m.workflows : nested;
  return top.map(String).filter(Boolean);
}

function packRole(m) {
  if (m && m.role) return String(m.role);
  if (m && m.manifest && m.manifest.role) return String(m.manifest.role);
  return "";
}

function packSteps(m) {
  const nested = m && m.manifest && Array.isArray(m.manifest.steps) ? m.manifest.steps : [];
  const top = Array.isArray(m && m.steps) ? m.steps : nested;
  return top.map((item, index) => {
    if (typeof item === "string") {
      const label = String(item).trim() || `step-${index + 1}`;
      return { id: `s${index + 1}`, label, kind: "note", ref: label, risk: "safe" };
    }
    const rec = item && typeof item === "object" ? item : {};
    const kind = String(rec.kind || "note");
    const risk = String(rec.risk || "safe");
    const label = String(rec.label || rec.name || rec.ref || `step-${index + 1}`);
    return {
      id: String(rec.id || `s${index + 1}`),
      label,
      kind: kind || "note",
      ref: String(rec.ref || rec.id || label),
      risk: risk === "write" || risk === "exec" ? risk : "safe",
    };
  });
}

function packSchedule(m) {
  if (m && m.schedule) return String(m.schedule);
  if (m && m.trigger) return String(m.trigger);
  if (m && m.manifest && m.manifest.schedule) return String(m.manifest.schedule);
  if (m && m.manifest && m.manifest.trigger) return String(m.manifest.trigger);
  return "";
}

function normalize(tree, segment, id, target, manifestFile, manifest, origin, roots = []) {
  const m = manifest || {};
  const risk = String(m.risk || "safe");
  const state = health(tree, segment, target, manifest, manifestFile, roots);
  return {
    id,
    tree,
    segment,
    origin, // "app" (shipped) or "workspace" (user-installed)
    name: String(m.name || path.basename(target, path.extname(target))),
    version: m.version == null ? null : String(m.version),
    summary: String(m.summary || m.description || ""),
    description: String(m.description || m.summary || ""),
    category: String(m.category || segment),
    path: target,
    manifestFile,
    entry: m.entry == null ? null : String(m.entry),
    role: packRole(m),
    skills: packSkills(m),
    workflows: packWorkflows(m),
    permissions: Array.isArray(m.permissions)
      ? m.permissions.map(String)
      : Array.isArray(m.capabilities)
        ? m.capabilities.map(String)
        : [],
    hooks: Array.isArray(m.hooks) ? m.hooks.map(String) : [],
    steps: packSteps(m),
    schedule: packSchedule(m),
    inputs: Array.isArray(m.inputs) ? m.inputs.map(String) : [],
    approvalPrompt: m.approvalPrompt == null ? "" : String(m.approvalPrompt),
    uiPage: m.ui && typeof m.ui === "object" && !Array.isArray(m.ui) ? String(m.ui.page || "") : "",
    uiIcon: m.ui && typeof m.ui === "object" && !Array.isArray(m.ui) ? String(m.ui.icon || "") : "",
    keywords: Array.isArray(m.keywords) ? m.keywords.map(String).slice(0, 24) : [],
    risk: RISKS.has(risk) ? risk : "safe",
    enabled: m.enabled !== false,
    configured: Boolean(manifest),
    requires: state.requires,
    missingDependencies: state.missingDependencies,
    problems: state.problems,
    healthy: state.healthy,
    // detected + registered + dependency-checked + health-checked
    installed: Boolean(manifest) && state.healthy,
    updatedAt: (() => {
      try {
        return fs.statSync(target).mtimeMs;
      } catch {
        return 0;
      }
    })(),
  };
}

function readManifestIn(target, names) {
  for (const candidate of names) {
    const file = path.join(target, candidate);
    const parsed = fs.existsSync(file) ? readJson(file) : null;
    if (parsed) return { manifestFile: file, manifest: parsed };
  }
  return { manifestFile: null, manifest: null };
}

const SKIP_SCAN = new Set(["node_modules", ".git", "__pycache__"]);

function scanSegment(root, origin, tree, segment, names, roots = [root]) {
  const dir = path.join(root, tree, segment);
  const out = [];

  const walk = (base, relParts) => {
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_SCAN.has(entry.name)) continue;
      const target = path.join(base, entry.name);
      const rel = [...relParts, entry.name];
      const { manifestFile, manifest } = readManifestIn(target, names);
      if (manifest) {
        out.push(
          normalize(
            tree,
            segment,
            `${tree}/${segment}/${rel.join("/")}`,
            target,
            manifestFile,
            manifest,
            origin,
            roots,
          ),
        );
        continue;
      }
      let children = [];
      try {
        children = fs.readdirSync(target, { withFileTypes: true });
      } catch {
        children = [];
      }
      const subdirs = children.filter((child) => child.isDirectory() && !SKIP_SCAN.has(child.name));
      if (subdirs.length) {
        walk(target, rel);
        continue;
      }
      if (
        !fs.existsSync(path.join(target, "index.ts")) &&
        !fs.existsSync(path.join(target, "index.js"))
      ) {
        continue;
      }
      out.push(
        normalize(
          tree,
          segment,
          `${tree}/${segment}/${rel.join("/")}`,
          target,
          null,
          null,
          origin,
          roots,
        ),
      );
    }
  };

  walk(dir, []);
  return out;
}

function scanManifestFolder(root, origin, tree, roots = [root]) {
  const dir = path.join(root, tree, "manifests");
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".json")) continue;
    const full = path.join(dir, file);
    const manifest = readJson(full);
    if (!manifest) continue;
    const id = String(manifest.id || `${tree}/manifests/${path.basename(file, ".json")}`);
    out.push(normalize(tree, "manifests", id, full, full, manifest, origin, roots));
  }
  return out;
}

/**
 * Shipped modules that live at modules/<name>/ (repo-import convention)
 * instead of modules/<segment>/<name>/. Kernel glob is one (or two) levels
 * of manifest.json; this scan is the matching Electron discovery so the
 * Modules page lists those packs. Known segment folders are skipped — they
 * are already walked by scanSegment.
 */
function scanLooseModulePacks(root, origin, names, skipSegments, roots = [root]) {
  const dir = path.join(root, "modules");
  const skip = new Set([...(skipSegments || []), "manifests", ...SKIP_SCAN]);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || skip.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    const { manifestFile, manifest } = readManifestIn(target, names);
    if (!manifest) continue;
    const segment = String(manifest.category || entry.name);
    out.push(
      normalize(
        "modules",
        segment,
        `modules/${entry.name}`,
        target,
        manifestFile,
        manifest,
        origin,
        roots,
      ),
    );
  }
  return out;
}

/** Full scan of one root. */
function scanRoot(root, origin, roots = [root]) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  for (const [tree, config] of Object.entries(TREES)) {
    for (const segment of config.segments)
      out.push(...scanSegment(root, origin, tree, segment, config.names, roots));
    out.push(...scanManifestFolder(root, origin, tree, roots));
    if (tree === "modules")
      out.push(...scanLooseModulePacks(root, origin, config.names, config.segments, roots));
  }
  return out;
}

/**
 * Merged view of shipped + user-installed capabilities with persisted toggles.
 * Workspace entries win over app entries with the same id (user override).
 */
function list({ appRoot, workspaceRoot }) {
  const overrides = readOverrides(workspaceRoot);
  const merged = new Map();
  // Dependencies may be satisfied by either root (shipped or user-installed).
  const roots = [appRoot, workspaceRoot].filter(Boolean);
  // ONE deterministic precedence rule: packaged built-ins load first, a
  // user-installed copy with the same id always replaces it, and the replaced
  // built-in is recorded on the winner so the UI can show what it shadows.
  for (const entry of scanRoot(appRoot, "app", roots))
    merged.set(entry.id, { ...entry, shadows: null });
  for (const entry of scanRoot(workspaceRoot, "workspace", roots)) {
    const builtIn = merged.get(entry.id);
    merged.set(entry.id, {
      ...entry,
      shadows: builtIn
        ? { origin: builtIn.origin, path: builtIn.path, version: builtIn.version }
        : null,
    });
  }
  const items = [...merged.values()].map((entry) =>
    overrides[entry.id] === undefined ? entry : { ...entry, enabled: Boolean(overrides[entry.id]) },
  );
  items.sort((a, b) => a.id.localeCompare(b.id));
  const counts = {};
  for (const item of items) {
    counts[item.tree] = counts[item.tree] || { total: 0, enabled: 0 };
    counts[item.tree].total += 1;
    if (item.enabled) counts[item.tree].enabled += 1;
  }
  return {
    items,
    counts,
    scannedAt: Date.now(),
    appRoot: appRoot || null,
    workspaceRoot: workspaceRoot || null,
  };
}

function setEnabled({ workspaceRoot }, id, enabled) {
  if (!workspaceRoot) return { ok: false, error: "no workspace root selected" };
  const overrides = readOverrides(workspaceRoot);
  overrides[id] = Boolean(enabled);
  const ok = writeJson(overridesFile(workspaceRoot), overrides);
  return {
    ok,
    id,
    enabled: Boolean(enabled),
    error: ok ? undefined : "could not write config/capabilities.json",
  };
}

/**
 * Watches every capability tree folder in both roots and calls `onChange`
 * (debounced) when something is added, changed or removed. One watcher per
 * folder — never two for the same path.
 */
function watch({ appRoot, workspaceRoot }, onChange) {
  const watchers = new Map();
  let timer = null;
  const fire = (info) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        onChange(info);
      } catch {
        /* a listener must never break discovery */
      }
    }, 300);
  };

  for (const root of [appRoot, workspaceRoot]) {
    if (!root || !fs.existsSync(root)) continue;
    for (const tree of Object.keys(TREES)) {
      const dir = path.join(root, tree);
      if (!fs.existsSync(dir) || watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { recursive: true }, (_event, file) =>
          fire({ tree, file: file ? String(file) : null, root }),
        );
        watcher.on("error", () => {});
        watchers.set(dir, watcher);
      } catch {
        /* watching is best-effort; discovery still works on demand */
      }
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const watcher of watchers.values()) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    }
    watchers.clear();
  };
}

/* --------------------------------------------------------------- install */
// A "pack" is one installable capability: a manifest plus the files it needs.
// Installing writes real folders into the selected workspace, so discovery,
// the skill runtime and the plugin loader all pick it up immediately.

const DEFAULT_SEGMENT = {
  agents: "installed",
  skills: "custom",
  tools: "custom",
  modules: "custom",
  plugins: "installed",
  workflows: "saved",
  models: "configs",
};

const slugify = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Historical / singular / display spellings a pack author may write. Routing
// must never depend on the exact word used: "Agent", "agent", "ai-agent" and
// "agents" all mean the SAME first-class tree in friday-contract.cjs.
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

const canonicalTree = (value) => {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (TREES[key]) return key;
  return TREE_ALIASES[key] || null;
};

/**
 * The single routing decision: which capability tree does this pack belong to?
 *
 * Order of authority — an explicit declaration always wins, then the pack's
 * real content shape (pack-shape.cjs), then the page / import source the owner
 * used. Skills / Tools / Agents imports refuse a content/page mismatch in
 * installPack() instead of rewriting the pack into the page's tree.
 */
function resolveTree(pack, hint) {
  const p = pack || {};
  const declared =
    canonicalTree(p.tree) ||
    canonicalTree(p.kind) ||
    canonicalTree(p.type) ||
    canonicalTree(p.category && TREE_ALIASES[String(p.category).toLowerCase()] ? p.category : "");
  if (declared) return declared;

  const detected = packShape.detectPackShape(p);
  if (detected.tree) return detected.tree;

  const fromHint = canonicalTree(hint);
  if (fromHint) return fromHint;

  // Shape inference — only used when nothing was declared anywhere.
  if (canonicalTree(p.manifestName)) return canonicalTree(p.manifestName);
  if (Array.isArray(p.steps) || Array.isArray(p.nodes) || p.schedule) return "workflows";
  if (Array.isArray(p.agents) || p.goal || p.persona) return "agents";
  if (p.provider && (p.contextWindow || p.parameters)) return "models";
  if (/\.(cjs|js)$/i.test(String(p.entry || "")) && Array.isArray(p.hooks)) return "plugins";
  if (p.code || Array.isArray(p.inputs)) return "skills";
  if (p.command || p.exec || p.binary) return "tools";
  return null;
}

function packDir(workspaceRoot, tree, segment, slug) {
  return path.join(workspaceRoot, tree, segment, slug);
}

/** Writes one capability pack into the workspace. Returns { ok, id, path }. */
function installPack({ workspaceRoot }, pack, hint) {
  if (!workspaceRoot) return { ok: false, error: "No FRIDAY workspace is selected." };
  const gated = packShape.assertMatchesSection(pack, hint);
  if (!gated.ok) return { ok: false, error: gated.error };
  const tree = resolveTree(pack, hint);
  if (!pack || !tree)
    return {
      ok: false,
      error:
        "This pack does not say which capability tree it belongs to (agents, skills, tools, modules, plugins, workflows or models).",
    };

  const segment = TREES[tree].segments.includes(pack.segment)
    ? pack.segment
    : DEFAULT_SEGMENT[tree];
  const slug = slugify(pack.slug || pack.id || pack.name);
  if (!slug) return { ok: false, error: "The pack needs an id." };

  const dir = packDir(workspaceRoot, tree, segment, slug);
  try {
    fs.mkdirSync(dir, { recursive: true });

    if (tree === "skills") {
      // Skill manifests follow the custom-skill runtime shape so the installed
      // skill is really invocable through skills:invoke.
      const existing = readJson(path.join(dir, "skill.json"));
      const summary = String(pack.summary || pack.description || "").trim();
      const description = String(pack.description || pack.summary || "").trim();
      const capabilities = Array.isArray(pack.capabilities)
        ? pack.capabilities
        : Array.isArray(pack.permissions)
          ? pack.permissions
          : [];
      const permissions = Array.isArray(pack.permissions)
        ? pack.permissions
        : Array.isArray(pack.capabilities)
          ? pack.capabilities
          : [];
      const manifest = {
        id: slug,
        name: pack.name || slug,
        summary,
        description,
        category: pack.category || segment,
        capabilities,
        permissions,
        risk: pack.risk || "safe",
        inputs: Array.isArray(pack.inputs) ? pack.inputs : [],
        version: Number(existing?.version || 0) + 1,
        author: pack.author || "friday-marketplace",
        createdAt: Number(existing?.createdAt || Date.now()),
        updatedAt: Date.now(),
        runs: Number(existing?.runs || 0),
        failures: Number(existing?.failures || 0),
        // Installed-but-not-yet-proven. capability-verify.cjs flips this to
        // true only after the pack really ran inside the sandbox.
        enabled: false,
        verification: { status: "pending", at: Date.now() },
        ...(pack.selfTest ? { selfTest: pack.selfTest } : {}),
      };
      writeJson(path.join(dir, "skill.json"), manifest);
      if (pack.code) fs.writeFileSync(path.join(dir, "skill.mjs"), String(pack.code), "utf8");
    } else if (tree === "tools") {
      const name = pack.name || slug;
      const description = String(pack.description || pack.summary || "").trim();
      const manifest = {
        name,
        version: String(pack.version || "1.0.0"),
        description,
        category: pack.category || segment,
        entry: "index.cjs",
        inputs: Array.isArray(pack.inputs) ? pack.inputs.map(String) : [],
        permissions: Array.isArray(pack.permissions) ? pack.permissions.map(String) : [],
        risk: pack.risk || "safe",
        enabled: false,
        approvalPrompt: String(
          pack.approvalPrompt || `FRIDAY wants to run the tool “${name}”. Allow this?`,
        ).trim(),
        author: pack.author || "friday-marketplace",
        verification: { status: "pending", at: Date.now() },
        installedAt: Date.now(),
        ...(Array.isArray(pack.keywords)
          ? { keywords: pack.keywords.map(String).slice(0, 24) }
          : {}),
        ...(pack.selfTest ? { selfTest: pack.selfTest } : {}),
      };
      writeJson(path.join(dir, "tool.json"), manifest);
      if (pack.code) fs.writeFileSync(path.join(dir, "index.cjs"), String(pack.code), "utf8");
    } else if (tree === "modules") {
      const entryName = String(pack.entry || "main.py").replace(/^[\\/]+/, "") || "main.py";
      const rawUi =
        pack.ui && typeof pack.ui === "object" && !Array.isArray(pack.ui) ? pack.ui : null;
      const manifest = {
        name: pack.name || slug,
        version: String(pack.version || "1.0.0"),
        description: String(pack.description || pack.summary || "").trim(),
        category: pack.category || segment,
        permissions: Array.isArray(pack.permissions) ? pack.permissions.map(String) : [],
        entry: entryName,
        author: pack.author || "friday-marketplace",
        enabled: false,
        verification: { status: "pending", at: Date.now() },
        installedAt: Date.now(),
        ...(rawUi
          ? { ui: { page: String(rawUi.page || ""), icon: String(rawUi.icon || "") } }
          : {}),
        ...(pack.selfTest ? { selfTest: pack.selfTest } : {}),
      };
      writeJson(path.join(dir, "manifest.json"), manifest);
      if (pack.code) fs.writeFileSync(path.join(dir, entryName), String(pack.code), "utf8");
    } else if (tree === "plugins") {
      const entryName = String(pack.entry || "index.cjs").replace(/^[\\/]+/, "") || "index.cjs";
      const hooks = Array.isArray(pack.hooks) ? pack.hooks.map(String) : [];
      const manifest = {
        id: slug,
        name: pack.name || slug,
        version: String(pack.version || "1.0.0"),
        description: String(pack.description || pack.summary || "").trim(),
        category: pack.category || segment,
        permissions: Array.isArray(pack.permissions) ? pack.permissions.map(String) : [],
        hooks,
        entry: entryName,
        author: pack.author || "friday-marketplace",
        enabled: false,
        verification: { status: "pending", at: Date.now() },
        installedAt: Date.now(),
        ...(pack.selfTest ? { selfTest: pack.selfTest } : {}),
      };
      writeJson(path.join(dir, "plugin.json"), manifest);
      if (pack.code) fs.writeFileSync(path.join(dir, entryName), String(pack.code), "utf8");
    } else if (tree === "workflows") {
      const extra = pack.manifest && typeof pack.manifest === "object" ? pack.manifest : {};
      const rawSteps = Array.isArray(pack.steps)
        ? pack.steps
        : Array.isArray(extra.steps)
          ? extra.steps
          : Array.isArray(pack.nodes)
            ? pack.nodes
            : [];
      const steps = packSteps({ steps: rawSteps });
      const schedule =
        String(pack.schedule || extra.schedule || extra.trigger || "on demand").trim() ||
        "on demand";
      const manifest = {
        id: slug,
        name: pack.name || slug,
        version: String(pack.version || "1.0.0"),
        description: String(pack.description || pack.summary || "").trim(),
        category: pack.category || segment,
        permissions: Array.isArray(pack.permissions) ? pack.permissions.map(String) : [],
        risk: pack.risk || "safe",
        schedule,
        steps: steps.length
          ? steps
          : [
              {
                id: "s1",
                label: String(pack.name || slug),
                kind: "note",
                ref: slug,
                risk: "safe",
              },
            ],
        inputs: Array.isArray(pack.inputs) ? pack.inputs.map(String) : [],
        author: pack.author || "friday-marketplace",
        enabled: false,
        verification: { status: "pending", at: Date.now() },
        installedAt: Date.now(),
        ...(pack.selfTest ? { selfTest: pack.selfTest } : {}),
      };
      writeJson(path.join(dir, "workflow.json"), manifest);
    } else {
      const manifest = {
        id: `${tree}/${segment}/${slug}`,
        name: pack.name || slug,
        version: String(pack.version || "1.0.0"),
        description: pack.description || "",
        category: pack.category || segment,
        permissions: Array.isArray(pack.permissions) ? pack.permissions : [],
        risk: pack.risk || "safe",
        entry: pack.entry || (tree === "plugins" ? "index.cjs" : null),
        author: pack.author || "friday-marketplace",
        // Same contract as skills: enabled is earned by a real sandbox run.
        enabled: false,
        verification: { status: "pending", at: Date.now() },
        installedAt: Date.now(),
        ...(pack.manifest || {}),
        ...(Array.isArray(pack.skills) ? { skills: pack.skills.map(String) } : {}),
        ...(Array.isArray(pack.workflows) ? { workflows: pack.workflows.map(String) } : {}),
      };
      writeJson(path.join(dir, "manifest.json"), manifest);
      if (pack.code)
        fs.writeFileSync(path.join(dir, manifest.entry || "index.cjs"), String(pack.code), "utf8");
    }

    for (const file of Array.isArray(pack.files) ? pack.files : []) {
      if (!file || !file.path) continue;
      const target = path.join(dir, String(file.path).replace(/^[\\/]+/, ""));
      if (!contains(dir, target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(file.content ?? ""), "utf8");
    }

    fs.writeFileSync(
      path.join(dir, "README.md"),
      `# ${pack.name || slug}\n\n${pack.description || ""}\n\n- tree: ${tree}/${segment}\n- installed: ${new Date().toISOString()}\n`,
      "utf8",
    );
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }

  return {
    ok: true,
    id: `${tree}/${segment}/${slug}`,
    tree,
    segment,
    slug,
    path: dir,
    enabled: false,
    // The caller (main.cjs) must run capability-verify before this pack counts
    // as working; discovery keeps it visible but disabled until then.
    needsVerification: true,
  };
}

/** Folder of an installed pack id (`tree/segment/slug` or shipped `modules/<name>`). */
function packPath(workspaceRoot, id) {
  const parts = String(id || "").split("/");
  if (!workspaceRoot || !TREES[parts[0]]) return null;
  if (parts.length === 3) {
    const dir = packDir(workspaceRoot, parts[0], parts[1], slugify(parts[2]));
    return contains(workspaceRoot, dir) ? dir : null;
  }
  if (parts.length === 2 && parts[0] === "modules") {
    const dir = path.join(workspaceRoot, "modules", slugify(parts[1]));
    return contains(workspaceRoot, dir) ? dir : null;
  }
  return null;
}

/**
 * Records the real outcome of a sandbox smoke test on the installed pack.
 * `enabled` is written to the manifest AND the override file, so a pack that
 * failed stays installed-but-disabled with its real error attached.
 */
function markVerified({ workspaceRoot }, id, result) {
  const dir = packPath(workspaceRoot, id);
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: "Not installed in this workspace." };
  const tree = String(id).split("/")[0];
  const preferred =
    tree === "skills"
      ? "skill.json"
      : tree === "tools"
        ? "tool.json"
        : tree === "workflows"
          ? "workflow.json"
          : "manifest.json";
  const file = fs.existsSync(path.join(dir, preferred))
    ? path.join(dir, preferred)
    : path.join(dir, "manifest.json");
  const manifest = readJson(file);
  if (!manifest) return { ok: false, error: "The installed pack has no readable manifest." };
  const ok = Boolean(result?.ok);
  manifest.enabled = ok;
  manifest.verification = {
    status: ok ? "verified" : result?.status || "failed",
    at: Date.now(),
    mode: result?.mode || null,
    error: ok ? null : String(result?.error || "").slice(-1200) || null,
    guide: ok ? null : result?.guide || null,
    installedDependencies: Array.isArray(result?.installed) ? result.installed : [],
  };
  writeJson(file, manifest);
  const overrides = readOverrides(workspaceRoot);
  overrides[id] = ok;
  writeJson(overridesFile(workspaceRoot), overrides);
  return { ok: true, id, enabled: ok, verification: manifest.verification };
}

/** Removes an installed pack (workspace only — shipped capabilities stay). */
function uninstallPack({ workspaceRoot }, id) {
  if (!workspaceRoot) return { ok: false, error: "No FRIDAY workspace is selected." };
  const parts = String(id || "").split("/");
  if (!TREES[parts[0]]) return { ok: false, error: "Unknown capability tree." };
  if (parts.length !== 3 && !(parts.length === 2 && parts[0] === "modules")) {
    return { ok: false, error: "Unknown capability id." };
  }
  const dir =
    parts.length === 3
      ? packDir(workspaceRoot, parts[0], parts[1], slugify(parts[2]))
      : path.join(workspaceRoot, "modules", slugify(parts[1]));
  if (!contains(workspaceRoot, dir))
    return { ok: false, error: "Refusing to delete outside the workspace." };
  if (!fs.existsSync(dir)) return { ok: false, error: "Not installed in this workspace." };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
  const file = overridesFile(workspaceRoot);
  const overrides = readOverrides(workspaceRoot);
  if (overrides[id] !== undefined) {
    delete overrides[id];
    writeJson(file, overrides);
  }
  return { ok: true, id };
}

/** Installs a pack described by a remote JSON document (marketplace/gist/repo). */
async function installFromUrl(roots, url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: "Enter an http(s) URL." };
  let payload = null;
  try {
    const response = await fetch(target, { redirect: "follow" });
    if (!response.ok) return { ok: false, error: `Download failed (${response.status}).` };
    payload = await response.json();
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
  const packs = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.packs)
      ? payload.packs
      : [payload];
  const results = packs.map((pack) => installPack(roots, pack));
  const failed = results.find((r) => !r.ok);
  return failed ? failed : { ok: true, installed: results.map((r) => r.id) };
}

module.exports = {
  TREES,
  list,
  setEnabled,
  watch,
  scanRoot,
  installPack,
  resolveTree,
  detectPackShape: packShape.detectPackShape,
  assertMatchesSection: packShape.assertMatchesSection,

  packPath,
  markVerified,
  uninstallPack,
  installFromUrl,
};
