/**
 * FRIDAY · ONE canonical structure contract.
 *
 * This file is the single source of truth for
 *   * the FRIDAY_ROOT folder contract (canonical names, legacy aliases,
 *     required sub-folders), and
 *   * the capability trees (which trees exist, which segments they have and
 *     which manifest filenames count).
 *
 * `electron/friday-paths.cjs` (path resolver), `electron/workspace.cjs`
 * (verify/repair), `electron/capabilities.cjs` (discovery), `core/discovery.ts`
 * and `scripts/init-runtime.cjs` all read this contract instead of declaring
 * their own copy, so a folder can never be "required" by one subsystem and
 * unknown to another. Arrange `SOURCE_LAYOUT.trees.capabilities.folders` is
 * generated from `TREES` (`capabilityLayoutFolders`).
 */
const path = require("node:path");

/** The source checkout this file lives in (build/diagnostics only). */
const CHECKOUT_ROOT = path.resolve(__dirname, "..");

/**
 * Canonical folder registry.
 *   aliases  — historical / alternative locations, relative to the root. An
 *              existing alias always wins so no user data is orphaned.
 *   children — required sub-folders of the canonical folder.
 */
const FOLDERS = {
  // THE PROGRAM FOLDER. Setup installs FRIDAY.exe and its resources into
  // "<root>/App" ($INSTDIR), a sibling of every data folder below. It is part
  // of the single scannable root — FRIDAY reads it to debug and repair itself
  // — but it is NEVER a data store: a normal uninstall and every in-place
  // upgrade replace it wholesale, so nothing persistent may be created here.
  app: { aliases: ["App"], children: [] },
  core: {
    aliases: ["Core"],
    children: ["config", "services", "orchestrator", "event_bus", "security"],
  },
  frontend: { aliases: ["Frontend", "ui", "src"], children: [] },
  backend: { aliases: ["Backend", "kernel", "server"], children: ["api", "services", "workers"] },
  ai: { aliases: ["AI", "Ai"], children: ["providers", "router", "agents", "prompts", "tools"] },
  // Legacy model stores FRIDAY has historically used, listed before the
  // case-only variant so a real second store (data/models, cache/models) is
  // migrated first; on case-insensitive volumes a case-only folder already IS
  // the canonical one.
  models: {
    aliases: ["data/models", "cache/models", "Models"],
    children: ["local", "cloud", "embeddings", "vision", "speech", "image"],
  },
  providers: {
    aliases: ["Providers"],
    children: [
      "ollama",
      "lmstudio",
      "llamacpp",
      "openai",
      "anthropic",
      "gemini",
      "deepseek",
      "mistral",
      "groq",
      "openrouter",
    ],
  },
  agents: {
    aliases: ["Agents"],
    children: [
      "developer",
      "coding",
      "research",
      "automation",
      "system",
      "vision",
      "voice",
      "installer",
      "updater",
      "custom",
    ],
  },
  // REGISTRY_HOMES writable slots (import-classify.cjs) — same names TREES
  // already uses, listed here so FOLDERS/NAMES/ensureStructure own them.
  skills: { aliases: ["Skills"], children: ["custom"] },
  plugins: { aliases: ["Plugins"], children: ["installed"] },
  modules: { aliases: ["Modules"], children: ["custom"] },
  workflows: { aliases: ["Workflows"], children: ["saved"] },
  tools: { aliases: ["Tools"], children: ["developer", "automation", "system", "custom"] },
  memory: {
    aliases: ["Memory"],
    children: ["conversations", "long_term", "projects", "preferences"],
  },
  knowledge: { aliases: ["Knowledge"], children: ["documents", "embeddings", "indexes"] },
  // Owner Library: uploaded / generated / modified files under FRIDAY_ROOT.
  // One index + items folder — not a second cloud drive or Import & Build.
  library: { aliases: ["Library"], children: ["items"] },
  database: { aliases: ["Database", "db"], children: ["migrations"] },
  data: { aliases: ["Data"], children: [] },
  state: { aliases: ["data/state"], children: [] },
  preferences: { aliases: ["Preferences"], children: [] },
  tasks: { aliases: ["data/tasks"], children: [] },
  voices: { aliases: ["resources/voices"], children: [] },
  browser: { aliases: ["config/browser"], children: [] },
  sandbox: { aliases: ["Sandbox"], children: [] },
  workspace: { aliases: [], children: [] },
  projects: { aliases: ["Projects"], children: [] },
  downloads: { aliases: ["Downloads"], children: [] },
  installer: { aliases: ["Installer"], children: ["installers", "manifests", "logs"] },
  updates: { aliases: ["Updates"], children: ["pending", "backups", "manifests"] },
  runtime: { aliases: ["app/runtime"], children: [] },
  logs: { aliases: ["Logs"], children: [] },
  cache: { aliases: ["Cache"], children: [] },
  temporary: { aliases: ["Temp", "temp", "tmp"], children: [] },
  testing: { aliases: ["Testing", "tests"], children: [] },
  experimental: { aliases: ["Experimental"], children: [] },
  backups: { aliases: ["Backups"], children: [] },
  assets: { aliases: ["Assets"], children: ["icons", "logo", "themes", "sounds"] },
  config: { aliases: ["Config"], children: [] },
  security: { aliases: ["Security"], children: ["credentials"] },

  docs: { aliases: ["Docs", "documentation"], children: [] },
};

const NAMES = Object.keys(FOLDERS);

/**
 * The canonical folder that holds the installed program files. One root,
 * two roles: `<root>/app` is the application, everything else beside it is
 * data. Installer (installer/build/installer.nsh), path service and the
 * workspace scanner all read this one constant.
 */
const PROGRAM_FOLDER = "app";

/** Is this root-relative path the program folder (or inside it)? */
const isProgramPath = (relative) =>
  /^app([\\/]|$)/i.test(String(relative || "").replace(/^[\\/]+/, ""));

/** Path candidates for one canonical folder, canonical name first. */
const candidates = (name) => {
  const entry = FOLDERS[name];
  if (!entry) return null;
  return [name, ...entry.aliases];
};

/**
 * Legacy aliases.
 *
 * With a folder name, return every historical path for that specific canonical
 * folder so migration tests and repair code exercise real second-store paths
 * such as `data/models` before case-only spellings like `Models`.
 *
 * Without a folder name, return the workspace resolver map. That map must stay
 * first-segment-only because it is used while resolving nested required folders.
 */
const legacyAliases = (name = null) => {
  if (name) return [...(FOLDERS[name]?.aliases || [])];
  const out = {};
  for (const name of NAMES) out[name] = FOLDERS[name].aliases.filter((a) => !a.includes("/"));
  return out;
};

/** Capability trees — the one definition used by every discovery pass. */
const TREES = {
  agents: {
    segments: ["system", "core", "custom", "installed"],
    names: ["manifest.json", "agent.json"],
  },
  skills: {
    segments: ["core", "system", "custom", "installed", "experimental"],
    names: ["manifest.json", "skill.json"],
  },
  tools: {
    segments: [
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
    ],
    names: ["manifest.json", "tool.json"],
  },
  modules: {
    segments: ["ai", "system", "automation", "communication", "developer", "ui", "custom"],
    names: ["manifest.json", "module.json"],
  },
  plugins: {
    segments: ["installed", "marketplace", "disabled", "sandbox", "updates"],
    names: ["manifest.json", "plugin.json"],
  },
  workflows: {
    segments: ["active", "saved", "templates", "schedules", "history"],
    names: ["manifest.json", "workflow.json"],
  },
  models: {
    segments: ["local", "cloud", "downloaded", "configs"],
    names: ["manifest.json", "model.json"],
  },
};

/**
 * Capability folders for the source checkout AND the selected FRIDAY folder.
 * Generated from TREES so arrange / ensureStructure / verify cannot drift.
 */
function capabilityLayoutFolders() {
  const out = [];
  for (const [tree, config] of Object.entries(TREES)) {
    for (const segment of config.segments) out.push(`${tree}/${segment}`);
    out.push(`${tree}/manifests`);
  }
  return [...new Set(out)].sort();
}

/** Every folder in the contract, as root-relative POSIX paths. */
function requiredFolders() {
  return [
    ...new Set([
      ...NAMES.flatMap((name) => [
        name,
        ...FOLDERS[name].children.map((child) => `${name}/${child}`),
      ]),
      ...capabilityLayoutFolders(),
    ]),
  ];
}
const SOURCE_LAYOUT = {
  version: 2,
  owner: "Devendra Singh Meena (devendrarj25)",
  trees: {
    code: {
      folders: [
        "src/routes",
        "src/components/friday",
        "src/components/ui",
        "src/hooks",
        "src/lib/friday",
        "src/lib/friday/brain",
        "src/lib/friday/self",
        "src/renderer",
        "core",
        "electron",
        "kernel",
        "scripts",
        "builder",
        "installer",
        "updater",
        "testing",
        "system",
      ],
    },
    capabilities: {
      folders: capabilityLayoutFolders(),
    },
    data: {
      folders: [
        "backup/config",
        "backup/database",
        "backup/memory",
        "backup/plugins",
        "backup/releases",
        "brain-data/instructions",
        "brain-data/knowledge",
        "brain-data/learned-context",
        "brain-data/personality",
        "brain-data/preferences",
        "brain-data/goals",
        "brain-data/reflections",
        "brain-data/skills-learned",
        "config/ai",
        "config/memory",
        "config/paths",
        "config/permissions",
        "config/plugins",
        "config/system",
        "config/user",
        "config/network",
        "config/security",
        "config/updates",
        "config/voice",
        "conversations/active",
        "conversations/attachments",
        "conversations/exports",
        "conversations/history",
        "conversations/sessions",
        "conversations/summaries",
        "conversations/pinned",
        "database/backups",
        "database/indexes",
        "database/migrations",
        "database/exports",
        "debug/crash-dumps",
        "debug/diagnostics",
        "debug/errors",
        "debug/performance",
        "debug/reports",
        "debug/traces",
        "memory/archived",
        "memory/embeddings",
        "memory/episodic",
        "memory/indexes",
        "memory/permanent",
        "memory/semantic",
        "memory/temporary",
        "memory/working",
        "memory/summaries",
        "releases/current",
        "releases/installers",
        "releases/manifests",
        "releases/previous",
        "releases/notes",
        "resources/animations",
        "resources/assets",
        "resources/fonts",
        "resources/icons",
        "resources/logo",
        "resources/sounds",
        "resources/themes",
        "resources/wake",
        "temporary/cache",
        "temporary/downloads",
        "temporary/generated",
        "temporary/processing",
        "temporary/sessions",
        "temporary/uploads",
      ],
    },
  },
  transient: {
    emptyDirs: [
      "debug/reports",
      "debug/diagnostics",
      "debug/errors",
      "debug/crash-dumps",
      "debug/performance",
      "debug/traces",
      "temporary/cache",
      "temporary/generated",
      "temporary/processing",
    ],
    removeGlobs: ["**/__pycache__", "**/*.pyc", ".tmp-doctor-db"],
  },
  forbidden: {
    paths: ["src/main", "src/preload", "src/pages", "src/App.tsx"],
    canonical: {
      "src/main": "electron/main.cjs",
      "src/preload": "electron/preload.cjs",
      "src/pages": "src/routes",
      "src/App.tsx": "src/renderer/App.tsx",
    },
  },
};

/**
 * The FRIDAY root as seen by a process that is not the Electron main process
 * (scripts, core/* modules, tests). The main process owns selection and
 * exports it as FRIDAY_ROOT; nothing here invents a folder.
 */
function rootFromEnv() {
  const value = process.env["FRIDAY_ROOT"] || process.env["FRIDAY_WORKSPACE_ROOT"] || "";
  return value ? path.resolve(value) : null;
}

/**
 * Real path containment. A string prefix would accept a sibling whose name
 * merely starts with the root name.
 */
function contains(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve a user-supplied path inside a FRIDAY root. Relative paths join the
 * root; absolute paths are accepted only when they stay inside it.
 */
function resolveInside(root, inputPath) {
  if (!root)
    return {
      ok: false,
      error: "No FRIDAY folder is selected — choose the FRIDAY folder first.",
    };
  const raw = String(inputPath || ".").trim() || ".";
  const target = path.resolve(root, raw);
  if (!contains(root, target))
    return { ok: false, error: "That path is outside the selected FRIDAY folder." };
  return {
    ok: true,
    path: target,
    relative: path.relative(root, target).replace(/\\/g, "/") || ".",
  };
}

/**
 * The root every *persistent* write must resolve against. There is no
 * working-directory fallback on purpose: writing FRIDAY data next to whatever
 * folder a process happened to start in is what created duplicate stores.
 */
function requireRoot() {
  const root = rootFromEnv();
  if (!root)
    throw new Error(
      "No FRIDAY root selected (FRIDAY_ROOT is not set). Persistent FRIDAY data must live inside the selected FRIDAY folder.",
    );
  return root;
}

/**
 * Read-only scan root. Discovery may inspect the source checkout while
 * developing; this is diagnostics/discovery only and is never used to decide
 * where persistent data is written.
 */
function resolveScanRoot() {
  return rootFromEnv() || CHECKOUT_ROOT;
}

module.exports = {
  FOLDERS,
  NAMES,
  PROGRAM_FOLDER,
  isProgramPath,
  TREES,
  capabilityLayoutFolders,
  SOURCE_LAYOUT,
  CHECKOUT_ROOT,
  candidates,
  requiredFolders,
  legacyAliases,
  rootFromEnv,
  requireRoot,
  resolveScanRoot,
  contains,
  resolveInside,
};
