// FRIDAY workspace discovery, mapping, verification, repair and scanning.
//
// Rules enforced here:
//   * the folder the user picked IS the workspace (never FRIDAY/FRIDAY)
//   * existing folders are mapped, never duplicated
//   * nothing is overwritten; missing pieces are only created on repair
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- layout ---
// Canonical FRIDAY workspace layout — read from the ONE structure contract
// shared with friday-paths (resolver) and capabilities (discovery), so verify,
// repair and path resolution can never disagree about what a root contains.
const contract = require("./friday-contract.cjs");
const paths = require("./friday-paths.cjs");

const LAYOUT = Object.fromEntries(
  contract.NAMES.map((name) => [name, contract.FOLDERS[name].children]),
);

const TOP_FOLDERS = Object.keys(LAYOUT);

/** Every folder in the canonical layout, as workspace-relative paths. */
const REQUIRED_FOLDERS = contract.requiredFolders();

// Older FRIDAY workspaces (and this project's phase-1 layout) used these
// names. They are mapped onto the canonical layout instead of being recreated.
const LEGACY_ALIASES = contract.legacyAliases();

// Folders whose contents hot-reload while the app runs.
const WATCHED_FOLDERS = [
  "config",
  "app/config",
  "core/config",
  "plugins",
  "modules",
  "skills",
  "agents",
  "workflows",
  "ai/prompts",
  "assets/themes",
];

// Root-level files the workspace should own. Created only when absent.
const ROOT_FILES = ["friday.json", "workspace.json", "version.json", "manifest.json"];

const CONFIG_FILES = [
  "config/friday.json",
  "config/providers.json",
  "config/models.json",
  "config/permissions.json",
  "config/paths.json",
];

const SCHEMA_VERSION = 1;

// ------------------------------------------------------------- utilities ---
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

const writeJsonIfAbsent = (p, value) => {
  if (fs.existsSync(p)) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
  return true;
};

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Resolve one canonical relative path against a real workspace, honouring
 * case differences and legacy folder names. Returns null when nothing exists.
 */
function resolveFolder(root, relative) {
  const segments = relative.split("/");
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    const wanted = segments[i];
    const candidates = i === 0 ? [wanted, ...(LEGACY_ALIASES[wanted] || [])] : [wanted];
    const entries = listDirs(current);
    const hit = candidates
      .map((c) => entries.find((e) => e.toLowerCase() === c.toLowerCase()))
      .find((name) => {
        if (!name) return false;
        if (i !== 0) return true;
        return !paths.isProtectedSourceDir(path.join(current, name), wanted);
      });
    if (!hit) return null;
    current = path.join(current, hit);
  }
  return current;
}

/** Absolute path for a canonical relative path — resolved, or the canonical one. */
const at = (root, relative) => resolveFolder(root, relative) || path.join(root, relative);

// ------------------------------------------------------------- verifying ---
function verifyWorkspace(root) {
  if (!root || !isDir(root)) {
    return {
      root,
      exists: false,
      valid: false,
      present: [],
      missing: REQUIRED_FOLDERS,
      mapped: {},
      rootFiles: {},
    };
  }
  const present = [];
  const missing = [];
  const mapped = {};
  for (const relative of REQUIRED_FOLDERS) {
    const resolved = resolveFolder(root, relative);
    if (resolved) {
      present.push(relative);
      const canonical = path.join(root, relative);
      if (path.resolve(resolved) !== path.resolve(canonical)) mapped[relative] = resolved;
    } else {
      missing.push(relative);
    }
  }
  const rootFiles = {};
  for (const file of [...ROOT_FILES, "README.md", ".gitignore"]) {
    rootFiles[file] = fs.existsSync(path.join(root, file));
  }
  return {
    root,
    exists: true,
    present,
    missing,
    mapped,
    rootFiles,
    valid: missing.length === 0 && ROOT_FILES.every((f) => rootFiles[f]),
  };
}

// ------------------------------------------------------------- repairing ---
/** Create missing folders and root files. Never deletes or overwrites. */
function repairWorkspace(root, options = {}) {
  const createdFolders = [];
  const createdFiles = [];
  const { missing } = verifyWorkspace(root);

  for (const relative of missing) {
    try {
      const segments = relative.split("/").filter(Boolean);
      if (!segments.length) continue;
      const parentRel = segments.slice(0, -1).join("/");
      const parent = parentRel
        ? resolveFolder(root, parentRel) || path.join(root, ...parentRel.split("/"))
        : root;
      fs.mkdirSync(path.join(parent, segments[segments.length - 1]), { recursive: true });
      createdFolders.push(relative);
    } catch {
      /* reported by the follow-up verify */
    }
  }

  if (options.files !== false) createdFiles.push(...ensureRootFiles(root, options).created);

  return { createdFolders, createdFiles, ...verifyWorkspace(root) };
}

/** Write the root manifest files when they do not exist yet. */
function ensureRootFiles(root, options = {}) {
  const created = [];
  const name = path.basename(root.replace(/[\\/]+$/, "")) || "FRIDAY";
  const version = options.version || "1.0.0";
  const now = new Date().toISOString();

  const add = (file, value) => {
    if (writeJsonIfAbsent(path.join(root, file), value)) created.push(file);
  };

  add("workspace.json", {
    name: "FRIDAY",
    version,
    schemaVersion: SCHEMA_VERSION,
    workspacePath: root,
    lastScan: now,
    enabledModules: [],
    enabledPlugins: [],
    enabledAgents: [],
  });
  add("friday.json", {
    name,
    assistant: "FRIDAY",
    role: "Personal AI Assistant",
    workspacePath: root,
    defaultProvider: null,
    telemetry: false,
  });
  add("version.json", { version, schemaVersion: SCHEMA_VERSION, installedAt: now });
  add("manifest.json", {
    id: "friday.workspace",
    name: "FRIDAY Workspace",
    version,
    schemaVersion: SCHEMA_VERSION,
  });

  const readme = path.join(root, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      `# FRIDAY Workspace\n\nThis folder holds all FRIDAY user data: config, plugins, modules,\nagents, skills, workflows, models, memory, knowledge, projects and logs.\n\nThe FRIDAY application is installed separately; uninstalling it keeps this\nfolder untouched unless you explicitly ask for it to be removed.\n`,
    );
    created.push("README.md");
  }
  const gitignore = path.join(root, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(
      gitignore,
      ["cache/", "temp/", "logs/", "downloads/", "updates/pending/", "models/local/", ""].join(
        "\n",
      ),
    );
    created.push(".gitignore");
  }

  // Default config files (empty but valid) so the app has something to read.
  const defaults = {
    "config/friday.json": { assistant: "FRIDAY", personality: "professional", voice: "female" },
    "config/providers.json": { providers: {} },
    "config/models.json": { models: [] },
    "config/permissions.json": { autoApproveExec: false, allowShell: false, allowNetwork: true },
    "config/paths.json": { workspacePath: root },
  };
  for (const [rel, value] of Object.entries(defaults)) {
    const target = resolveFolder(root, "config")
      ? path.join(resolveFolder(root, "config"), path.basename(rel))
      : path.join(root, rel);
    if (writeJsonIfAbsent(target, value)) created.push(rel);
  }

  return { created };
}

/** Update workspace.json in place, preserving any keys we do not own. */
function touchWorkspaceManifest(root, patch = {}) {
  const file = path.join(root, "workspace.json");
  const current = readJson(file) || {};
  const next = {
    name: "FRIDAY",
    schemaVersion: SCHEMA_VERSION,
    ...current,
    workspacePath: root,
    lastScan: new Date().toISOString(),
    ...patch,
  };
  try {
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* read-only workspace — scanning still works */
  }
  return next;
}

// -------------------------------------------------------------- scanning ---
function countEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).length;
  } catch {
    return 0;
  }
}

// Folders that are never indexed: build output, caches and vendor trees.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "target",
]);

/** Recursive file count with hard caps so a huge tree can never hang the app. */
function countFiles(dir, budget = { files: 0, dirs: 0 }, caps = { dirs: 4000, files: 250000 }) {
  if (budget.dirs > caps.dirs || budget.files > caps.files) return budget;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return budget;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      budget.dirs += 1;
      countFiles(path.join(dir, entry.name), budget, caps);
    } else {
      budget.files += 1;
    }
  }
  return budget;
}

// How each canonical top folder is treated by the indexer.
const FOLDER_KIND = {
  // "<root>/App" is the installed program itself, a sibling of the data
  // folders inside the one FRIDAY root. It is mapped (so FRIDAY can find and
  // debug its own installed files) but never content-indexed: Setup replaces
  // it on every upgrade, so nothing there is user content.
  app: "program",
  frontend: "code-root",
  backend: "code-root",
  core: "code-root",
  ai: "code-root",
  agents: "code-root",
  skills: "code-root",
  plugins: "code-root",
  modules: "code-root",
  tools: "code-root",
  workflows: "code-root",
  projects: "code-root",
  docs: "docs",
  knowledge: "docs",
  memory: "data",
  database: "data",
  config: "data",
  models: "models",
};

const NOT_INDEXED = new Set(["app", "cache", "temp", "logs", "backups", "downloads", "updates"]);

/** The program folder is mapped shallowly — it holds tens of thousands of
 * packaged files that would otherwise dominate every scan. */
const PROGRAM_CAPS = { dirs: 200, files: 5000 };

/**
 * Per-folder map of the workspace: what exists, what kind it is, how many
 * files it holds and whether the indexer picks it up. This is what the
 * Folders screen shows — no estimates, no mock data.
 */
function scanFolders(root) {
  const folders = [];
  let files = 0;
  let dirs = 0;
  for (const top of TOP_FOLDERS) {
    const resolved = resolveFolder(root, top);
    if (!resolved) continue;
    const budget =
      top === contract.PROGRAM_FOLDER
        ? countFiles(resolved, { files: 0, dirs: 0 }, PROGRAM_CAPS)
        : countFiles(resolved);
    files += budget.files;
    dirs += budget.dirs + 1;
    folders.push({
      name: top,
      path: resolved,
      kind: FOLDER_KIND[top] || "other",
      files: budget.files,
      subfolders: budget.dirs,
      indexed: !NOT_INDEXED.has(top),
    });
  }
  return { folders, totals: { files, folders: dirs } };
}

function listManifests(dir, manifestNames) {
  const out = [];
  if (!dir || !isDir(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = path.join(dir, entry.name);
    let manifest = null;
    let file = null;
    for (const name of manifestNames) {
      const candidate = path.join(base, name);
      const parsed = readJson(candidate);
      if (parsed) {
        manifest = parsed;
        file = candidate;
        break;
      }
    }
    out.push({
      id: entry.name,
      path: base,
      name: manifest?.name || entry.name,
      version: manifest?.version || null,
      enabled: manifest?.enabled !== false,
      updateUrl: manifest?.updateUrl || null,
      manifestFile: file,
      mtime: file ? fs.statSync(file).mtimeMs : null,
    });
  }
  return out;
}

/** Full startup scan of an existing workspace. Read-only apart from lastScan. */
function scanWorkspace(root) {
  const verified = verifyWorkspace(root);
  if (!verified.exists) return { ...verified, scannedAt: Date.now() };

  const dir = (rel) => resolveFolder(root, rel);

  let settings = {};
  const settingsFiles = [];
  for (const rel of CONFIG_FILES) {
    const file = path.join(at(root, "config"), path.basename(rel));
    const parsed = readJson(file);
    if (parsed) {
      settings = { ...settings, ...parsed };
      settingsFiles.push(file);
    }
  }

  const manifest = readJson(path.join(root, "workspace.json"));
  const dbDir = dir("database") || dir("memory");
  const databases = dbDir
    ? fs
        .readdirSync(dbDir)
        .filter((f) => /\.(db|sqlite3?|duckdb)$/i.test(f))
        .map((f) => ({ name: f, path: path.join(dbDir, f) }))
    : [];

  const { folders, totals } = scanFolders(root);
  const plugins = listManifests(dir("plugins"), ["manifest.json", "plugin.json"]);
  const modules = listManifests(dir("modules"), ["manifest.json", "module.json"]);
  const agents = listManifests(dir("agents"), ["manifest.json", "agent.json"]);

  const scan = {
    ...verified,
    scannedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    folders,
    totals,
    workspaceManifest: manifest,
    settingsFile: settingsFiles[0] || null,
    settingsFiles,
    settings,
    databases,
    plugins,
    modules,
    agents,
    skills: listManifests(dir("skills"), ["manifest.json", "skill.json"]),
    workflows: listManifests(dir("workflows"), ["manifest.json", "workflow.json"]),
    tools: listManifests(dir("tools"), ["manifest.json", "tool.json"]),
    providers: listDirs(dir("providers") || ""),
    counts: {
      models: countEntries(at(root, "models/local")) + countEntries(at(root, "models/cloud")),
      knowledge: countEntries(at(root, "knowledge/documents")),
      projects: countEntries(at(root, "projects")),
      logs: countEntries(at(root, "logs")),
      backups: countEntries(at(root, "backups")),
      downloads: countEntries(at(root, "downloads")),
    },
  };

  if (manifest) {
    touchWorkspaceManifest(root, {
      enabledModules: modules.filter((m) => m.enabled).map((m) => m.id),
      enabledPlugins: plugins.filter((p) => p.enabled).map((p) => p.id),
      enabledAgents: agents.filter((a) => a.enabled).map((a) => a.id),
    });
  }

  return scan;
}

module.exports = {
  LAYOUT,
  TOP_FOLDERS,
  REQUIRED_FOLDERS,
  WATCHED_FOLDERS,
  ROOT_FILES,
  SCHEMA_VERSION,
  resolveFolder,
  verifyWorkspace,
  repairWorkspace,
  ensureRootFiles,
  touchWorkspaceManifest,
  scanWorkspace,
  scanFolders,
};
