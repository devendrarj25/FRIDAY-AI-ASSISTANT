// Plugin runtime for the workspace `plugins/` folder.
//
// A plugin is a folder with a manifest (id, name, version, entry, permissions,
// hooks) and a CommonJS entry module exporting `register(ctx)` and optionally
// `deactivate()`. Loading is lazy: nothing is required until the plugin is
// enabled, and hot reload drops the plugin's own require cache subtree so a
// developer can iterate without restarting FRIDAY.
const fs = require("fs");
const path = require("path");
const { resolveFolder } = require("./workspace.cjs");

const MANIFEST_NAMES = ["manifest.json", "plugin.json"];

// id -> { manifest, module, tools:Map, commands:Map, disposers:[] }
const loaded = new Map();

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

function pluginsDir(root) {
  if (!root) return null;
  return resolveFolder(root, "plugins") || path.join(root, "plugins");
}

function isRoots(value) {
  return Boolean(
    value && typeof value === "object" && (value.appRoot || value.workspaceRoot || value.root),
  );
}

function normalizeRoots(rootOrRoots) {
  if (isRoots(rootOrRoots)) {
    return {
      appRoot: rootOrRoots.appRoot || null,
      workspaceRoot: rootOrRoots.workspaceRoot || rootOrRoots.root || null,
    };
  }
  return { appRoot: null, workspaceRoot: rootOrRoots || null };
}

function pluginSlug(id) {
  const parts = String(id || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return parts[parts.length - 1] || String(id || "");
}

function idsMatch(item, wanted) {
  if (!wanted) return true;
  const w = String(wanted);
  if (!item) return false;
  if (item.id === w || item.path === w) return true;
  const slug = pluginSlug(w);
  if (!slug) return false;
  if (pluginSlug(item.id) === slug) return true;
  if (item.path && path.basename(item.path) === slug) return true;
  return false;
}

/**
 * Hook scratch files always live under the selected workspace so Test selected
 * (appRoot pack) and Enable (workspace copy) share one folder, and so a
 * packaged install tree is never written.
 */
function dataDirFor(pluginDir, pluginId, workspaceRoot) {
  const slug = pluginSlug(pluginId || pluginDir);
  if (workspaceRoot && slug) return path.join(workspaceRoot, "plugins", "data", slug);
  return path.join(pluginDir, "data");
}

function manifestPath(dir) {
  for (const name of MANIFEST_NAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function describeOne(dir) {
  const file = manifestPath(dir);
  const manifest = file ? readJson(file) : null;
  const id = manifest?.id || path.basename(dir);
  const live = loaded.get(id);
  const described = {
    id,
    name: manifest?.name || path.basename(dir),
    version: manifest?.version || null,
    description: manifest?.description || "",
    entry: manifest?.entry || "index.cjs",
    permissions: manifest?.permissions || [],
    hooks: manifest?.hooks || [],
    enabled: manifest?.enabled !== false,
    loaded: Boolean(live),
    tools: live ? [...live.tools.keys()] : [],
    commands: live ? [...live.commands.keys()] : [],
    error: live?.error || null,
    path: dir,
    manifestFile: file,
  };
  return withUpdateFields(described);
}

// Folders that only organise plugins (installed/, disabled/, marketplace/,
// manifests/, updates/, sandbox/, data/ …) are containers, not plugins. A
// folder is a plugin only when it carries a manifest; anything else is
// descended into. Without this the organisational folders were loaded as
// plugins and every one of them failed at boot.
const SKIP_DIRS = new Set(["node_modules", "data", "__pycache__"]);
const MAX_DEPTH = 3;

/** Every folder under plugins/ that really carries a plugin manifest. */
function discover(dir, depth = 0) {
  if (depth > MAX_DEPTH || !fs.existsSync(dir)) return [];
  if (depth > 0 && manifestPath(dir)) return [dir];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    found.push(...discover(path.join(dir, entry.name), depth + 1));
  }
  return found;
}

function list(rootOrRoots) {
  const roots = normalizeRoots(rootOrRoots);
  if (roots.appRoot) {
    const capabilities = require("./capabilities.cjs");
    const report = capabilities.list(roots);
    return (report.items || [])
      .filter((item) => item.tree === "plugins")
      .map((item) => {
        const live = loaded.get(item.id) || loaded.get(pluginSlug(item.id));
        const described = {
          id: item.id,
          name: item.name,
          version: item.version || null,
          description: item.description || item.summary || "",
          entry: item.entry || "index.cjs",
          permissions: Array.isArray(item.permissions) ? item.permissions : [],
          hooks: declaredHooks(item),
          enabled: Boolean(item.enabled),
          loaded: Boolean(live),
          tools: live ? [...live.tools.keys()] : [],
          commands: live ? [...live.commands.keys()] : [],
          error: live?.error || null,
          path: item.path,
          manifestFile: item.manifestFile || null,
          origin: item.origin || "app",
        };
        return withUpdateFields(described);
      });
  }
  const root = roots.workspaceRoot;
  const dir = pluginsDir(root);
  if (!dir || !fs.existsSync(dir)) return [];
  const seen = new Set();
  return discover(dir)
    .map((folder) => describeOne(folder))
    .filter((plugin) => {
      if (seen.has(plugin.id)) return false; // one canonical entry per id
      seen.add(plugin.id);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findInRoot(root, id) {
  if (!root || !id) return null;
  const dir = pluginsDir(root);
  if (!dir || !fs.existsSync(dir)) return null;
  const slug = pluginSlug(id);
  for (const candidate of [
    path.join(dir, String(id)),
    path.join(dir, slug),
    path.join(dir, "installed", slug),
  ]) {
    if (manifestPath(candidate)) return candidate;
  }
  for (const candidate of discover(dir)) {
    const file = manifestPath(candidate);
    if (!file) continue;
    const manifest = readJson(file);
    if (manifest?.id === id || manifest?.id === slug || path.basename(candidate) === slug) {
      return candidate;
    }
  }
  return null;
}

function findDir(rootOrRoots, id) {
  const roots = normalizeRoots(rootOrRoots);
  const wanted = String(id || "");
  if (!wanted) return null;
  for (const root of [roots.workspaceRoot, roots.appRoot]) {
    const found = findInRoot(root, wanted);
    if (found) return found;
  }
  return null;
}

function catalogEnabled(rootOrRoots, id, fallback) {
  const roots = normalizeRoots(rootOrRoots);
  if (!roots.appRoot && !roots.workspaceRoot) return fallback;
  try {
    const capabilities = require("./capabilities.cjs");
    const listed = (capabilities.list(roots).items || []).filter((item) => item.tree === "plugins");
    const match = listed.find((item) => idsMatch(item, id));
    if (match) return Boolean(match.enabled);
  } catch {
    /* discovery is best-effort; fall back to the manifest flag */
  }
  return fallback;
}

/**
 * Enabling a shipped catalog plugin copies it into the workspace so sandbox
 * require() and data/ writes never touch a read-only install folder.
 */
function ensureWorkspaceCopy(rootOrRoots, id) {
  const roots = normalizeRoots(rootOrRoots);
  if (!roots.workspaceRoot) return null;
  const existing = findInRoot(roots.workspaceRoot, id);
  if (existing) return existing;
  const fromApp = roots.appRoot ? findInRoot(roots.appRoot, id) : null;
  if (!fromApp) return null;
  const dest = path.join(roots.workspaceRoot, "plugins", "installed", pluginSlug(id));
  const rel = path.relative(path.resolve(roots.workspaceRoot), path.resolve(dest));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(fromApp, dest, { recursive: true });
  return dest;
}

/** Drop the plugin folder's modules from the require cache (hot reload). */
function clearRequireCache(dir) {
  const prefix = path.resolve(dir) + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key];
  }
}

/**
 * Scoped context handed to every plugin. A plugin only ever sees its own
 * folder, its own config slice and the shared services it declared.
 */
function buildContext(id, dir, manifest, services, entryState) {
  const workspaceRoot =
    typeof services?.workspaceRoot === "function" ? services.workspaceRoot() : null;
  const dataDir = dataDirFor(dir, id, workspaceRoot);
  return {
    id,
    manifest,
    paths: {
      plugin: dir,
      data: dataDir,
      workspace: services.workspaceRoot() || null,
    },
    log: (...args) => services.log(`[plugin:${id}] ${args.join(" ")}`),
    bus: {
      emit: (event, payload) => services.emit(`plugin:${id}:${event}`, payload),
      on: (event, handler) => {
        const off = services.on(event, handler);
        entryState.disposers.push(off);
        return off;
      },
    },
    memory: {
      add: (text, meta = {}) =>
        services.kernel("memory.add", {
          text,
          kind: meta.kind || `plugin:${id}`,
          title: meta.title || id,
        }),
      search: (query, k = 8) => services.kernel("memory.search", { query, k }),
    },
    tools: {
      register: (name, handler, meta = {}) => {
        entryState.tools.set(name, { handler, meta });
      },
    },
    ipc: {
      register: (name, handler) => {
        entryState.commands.set(name, handler);
      },
    },
    config: {
      read: () => readJson(path.join(dir, "config.json")) || {},
      write: (value) => writeJson(path.join(dir, "config.json"), value),
    },
    fs: {
      // Sandboxed to the plugin's own data folder.
      readFile: (name) => fs.readFileSync(path.join(dataDir, path.basename(name)), "utf8"),
      writeFile: (name, body) => {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, path.basename(name)), String(body), "utf8");
      },
    },
  };
}

/* ------------------------------------------------------- sandboxed runtime */
// A plugin is third-party code. By default it never runs inside the Electron
// main process: it runs in the SAME isolated child sandbox.runIsolated() that
// Skills already use — own throwaway folder, hard timeout, no network unless
// the manifest asks for it. Main-process trust is only granted when the
// manifest explicitly asks for it AND the owner approves it through the
// governance gate (services.approveHostAccess).

const HOST_PERMISSIONS = new Set(["electron", "main-process", "host", "node"]);

/** Does this manifest ask for Electron/main-process trust? */
function wantsHostAccess(manifest) {
  const permissions = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  return permissions.some((permission) => HOST_PERMISSIONS.has(String(permission).toLowerCase()));
}

function readManifestFile(dir) {
  const file = manifestPath(dir);
  return file ? readJson(file) : null;
}

/** owner/name, including a pasted github.com URL. Blank when there is no source. */
function githubRepoFrom(value) {
  if (!value) return "";
  if (typeof value === "object") {
    return githubRepoFrom(value.url || value.github || value.repo || "");
  }
  const raw = String(value).trim();
  const match =
    /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i.exec(raw) ||
    /^([\w.-]+)\/([\w.-]+)$/.exec(raw) ||
    null;
  if (!match) return "";
  return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
}

function declaredGithubSource(plugin) {
  const manifest =
    (plugin && plugin.manifestFile && readJson(plugin.manifestFile)) ||
    (plugin && plugin.path && readManifestFile(plugin.path)) ||
    {};
  return (
    githubRepoFrom(manifest.github) ||
    githubRepoFrom(manifest.repository) ||
    githubRepoFrom(manifest.source) ||
    githubRepoFrom(manifest.homepage) ||
    ""
  );
}

function comparePluginVersions(a, b) {
  const parse = (value) =>
    String(value || "")
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((part) => {
        const n = parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const left = parse(a);
  const right = parse(b);
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const d = (left[i] || 0) - (right[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Last successful GitHub lookup per plugin id. Never pre-filled with the
// installed version — a miss stays blank.
const latestById = new Map();

function withUpdateFields(plugin) {
  const github = declaredGithubSource(plugin);
  const cached = latestById.get(plugin.id);
  const latest =
    github && cached && cached.github === github && cached.latest ? String(cached.latest) : null;
  return {
    ...plugin,
    github: github || null,
    latest,
    updateAvailable: Boolean(
      latest && plugin.version && comparePluginVersions(latest, plugin.version) > 0,
    ),
  };
}

async function lookupGithubLatest(workspaceRoot, repo, lookup) {
  if (typeof lookup === "function") {
    try {
      const found = await lookup(repo);
      return found ? String(found).replace(/^v/i, "") : null;
    } catch {
      return null;
    }
  }
  if (!workspaceRoot || !repo) return null;
  try {
    const connectors = require("./connectors.cjs");
    const result = await connectors.callConnector(workspaceRoot, "github", "latest-release", {
      repo,
    });
    const version = result?.ok && result.data ? String(result.data.version || "") : "";
    return version.replace(/^v/i, "") || null;
  } catch {
    return null;
  }
}

/**
 * Compare each installed plugin against its declared GitHub source via the
 * connector's read-only latest-release action. Plugins with no source stay
 * blank — never a fake "up to date".
 */
async function checkUpdates(rootOrRoots, options = {}) {
  const roots = normalizeRoots(rootOrRoots);
  const listed = list(roots);
  const pluginsOut = [];
  for (const plugin of listed) {
    const github = plugin.github;
    if (!github) {
      latestById.delete(plugin.id);
      pluginsOut.push(withUpdateFields(plugin));
      continue;
    }
    const latest = await lookupGithubLatest(roots.workspaceRoot, github, options.lookup);
    if (latest) latestById.set(plugin.id, { github, latest });
    else latestById.delete(plugin.id);
    pluginsOut.push(withUpdateFields(plugin));
  }
  return {
    ok: true,
    plugins: pluginsOut,
    updates: pluginsOut.filter((row) => row.updateAvailable),
  };
}

function containsPath(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const WALK_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  ".output",
  "coverage",
  "__pycache__",
  ".venv",
  ".friday-dev",
  "htmlcov",
  "release",
  ".cursor",
]);

/** Inspect-only host snapshot. No env values, no homedir listing. */
function osSnapshot() {
  const os = require("os");
  let hostname = "";
  try {
    hostname = os.hostname();
  } catch {
    hostname = "";
  }
  let envKeys = [];
  try {
    envKeys = Object.keys(process.env || {}).sort();
  } catch {
    envKeys = [];
  }
  let homedir = "";
  try {
    homedir = os.homedir();
  } catch {
    homedir = "";
  }
  return {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    hostname,
    uptime: os.uptime(),
    freemem: os.freemem(),
    totalmem: os.totalmem(),
    cpus: (os.cpus() || []).length,
    loadavg: os.loadavg(),
    homedir,
    tmpdir: os.tmpdir(),
    node: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    envKeyCount: envKeys.length,
    envKeys: envKeys.slice(0, 80),
  };
}

function walkWorkspace(root, rel, options) {
  const depth = Math.min(4, Math.max(0, Number(options?.depth ?? 2)));
  const max = Math.min(400, Math.max(1, Number(options?.max ?? 200)));
  const start = path.resolve(root, String(rel || "."));
  if (!containsPath(root, start)) throw new Error("path escapes workspace");
  const out = [];
  const visit = (dir, level) => {
    if (out.length >= max) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      if (WALK_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, "/");
      let size = 0;
      let mtimeMs = 0;
      let symlink = false;
      try {
        const info = fs.lstatSync(full);
        size = info.size;
        mtimeMs = info.mtimeMs;
        symlink = info.isSymbolicLink();
      } catch {
        /* skip unreadable */
      }
      out.push({
        name: entry.name,
        relative,
        directory: entry.isDirectory(),
        size,
        mtimeMs,
        symlink,
      });
      if (entry.isDirectory() && !symlink && level < depth) visit(full, level + 1);
    }
  };
  visit(start, 0);
  return out;
}

/**
 * Child-process harness. It requires the plugin entry, hands `register()` a
 * context restricted to the plugin's own folder, and reports what the plugin
 * registered — or, for an invoke, the command's real return value. A declared
 * lifecycle hook is called on the same isolated entry (export name matches
 * the hook, kebab-case or camelCase).
 */
function harness(entryFile, dir, id, command, args, extra = {}) {
  const hook = extra.hook || null;
  const hookPayload = extra.payload && typeof extra.payload === "object" ? extra.payload : {};
  const workspaceRoot = extra.workspaceRoot || null;
  const permissions = Array.isArray(extra.permissions) ? extra.permissions.map(String) : [];
  return `import { createRequire } from "node:module";
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, statSync, lstatSync } from "node:fs";
import path from "node:path";
import os from "node:os";
const require = createRequire(${JSON.stringify(entryFile)});
const dir = ${JSON.stringify(dir)};
const dataDir = ${JSON.stringify(extra.dataDir || "")} || path.join(dir, "data");
const workspaceRoot = ${JSON.stringify(workspaceRoot)};
const permissions = ${JSON.stringify(permissions)};
const tools = new Map();
const commands = new Map();
const events = [];
const denied = (what) => () => {
  throw new Error(
    "plugin ${id} tried to use " + what + " — that needs main-process access, which must be approved by the owner (manifest permission \\"electron\\")",
  );
};
function readManifest() {
  for (const name of ["plugin.json", "manifest.json"]) {
    try {
      return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    } catch { /* try the next declared name */ }
  }
  return {};
}
function jail(rel) {
  if (!workspaceRoot) throw new Error("no workspace is selected");
  const raw = path.resolve(workspaceRoot, String(rel || "."));
  const relative = path.relative(path.resolve(workspaceRoot), raw);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path escapes workspace");
  return raw;
}
const ctx = {
  id: ${JSON.stringify(id)},
  manifest: readManifest(),
  paths: { plugin: dir, data: dataDir, workspace: workspaceRoot },
  log: (...a) => console.log("[plugin:${id}]", ...a),
  bus: { emit: (event, payload) => events.push({ event, payload }), on: () => () => {} },
  memory: { add: denied("memory.add"), search: denied("memory.search") },
  tools: { register: (name, handler, meta = {}) => tools.set(name, { handler, meta }) },
  ipc: { register: (name, handler) => commands.set(name, handler) },
  config: {
    read: () => { try { return JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")); } catch { return {}; } },
    write: (value) => writeFileSync(path.join(dir, "config.json"), JSON.stringify(value, null, 2)),
  },
  fs: {
    readFile: (name) => readFileSync(path.join(dataDir, path.basename(name)), "utf8"),
    writeFile: (name, body) => { mkdirSync(dataDir, { recursive: true }); writeFileSync(path.join(dataDir, path.basename(name)), String(body), "utf8"); },
  },
  workspace: {
    list: (rel = ".") => {
      if (!permissions.includes("fs.read")) throw new Error("plugin ${id} has no fs.read permission");
      const target = jail(rel);
      return readdirSync(target, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      }));
    },
    exists: (rel) => {
      if (!permissions.includes("fs.read")) throw new Error("plugin ${id} has no fs.read permission");
      try { return existsSync(jail(rel)); } catch { return false; }
    },
    stat: (rel) => {
      if (!permissions.includes("fs.read")) throw new Error("plugin ${id} has no fs.read permission");
      const info = statSync(jail(rel));
      return { size: info.size, mtimeMs: info.mtimeMs, directory: info.isDirectory() };
    },
    readFile: (rel, maxBytes) => {
      if (!permissions.includes("fs.read")) throw new Error("plugin ${id} has no fs.read permission");
      const target = jail(rel);
      const cap = Math.min(262144, Math.max(1, Number(maxBytes) || 65536));
      const buf = readFileSync(target);
      const slice = buf.subarray(0, cap);
      return { bytes: slice.length, truncated: buf.length > cap, text: slice.toString("utf8") };
    },
    walk: (rel, opts) => {
      if (!permissions.includes("fs.read")) throw new Error("plugin ${id} has no fs.read permission");
      const skip = new Set(["node_modules",".git","dist",".output","coverage","__pycache__",".venv",".friday-dev","htmlcov","release",".cursor"]);
      const depth = Math.min(4, Math.max(0, Number((opts && opts.depth) ?? 2)));
      const max = Math.min(400, Math.max(1, Number((opts && opts.max) ?? 200)));
      const root = jail(".");
      const start = jail(rel || ".");
      const out = [];
      const visit = (dir, level) => {
        if (out.length >= max) return;
        let entries = [];
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (out.length >= max) return;
          if (skip.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          const relative = path.relative(root, full).replace(/\\\\/g, "/");
          let size = 0, mtimeMs = 0, symlink = false;
          try {
            const info = lstatSync(full);
            size = info.size;
            mtimeMs = info.mtimeMs;
            symlink = info.isSymbolicLink();
          } catch { /* skip */ }
          out.push({ name: entry.name, relative, directory: entry.isDirectory(), size, mtimeMs, symlink });
          if (entry.isDirectory() && !symlink && level < depth) visit(full, level + 1);
        }
      };
      visit(start, 0);
      return out;
    },
  },
};
function osSnap() {
  let hostname = ""; try { hostname = os.hostname(); } catch { hostname = ""; }
  let envKeys = []; try { envKeys = Object.keys(process.env || {}).sort(); } catch { envKeys = []; }
  let homedir = ""; try { homedir = os.homedir(); } catch { homedir = ""; }
  return {
    platform: os.platform(), arch: os.arch(), release: os.release(), hostname,
    uptime: os.uptime(), freemem: os.freemem(), totalmem: os.totalmem(),
    cpus: (os.cpus() || []).length, loadavg: os.loadavg(), homedir, tmpdir: os.tmpdir(),
    node: process.version, pid: process.pid, cwd: process.cwd(),
    envKeyCount: envKeys.length, envKeys: envKeys.slice(0, 80),
  };
}
ctx.os = osSnap();
function pickHook(mod, hookName) {
  if (!mod || typeof mod !== "object" || !hookName) return null;
  if (typeof mod[hookName] === "function") return mod[hookName];
  const camel = String(hookName).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (typeof mod[camel] === "function") return mod[camel];
  return null;
}
let payload = { ok: false, error: "plugin harness did not run" };
try {
  const mod = require(${JSON.stringify(entryFile)});
  if (typeof mod.register === "function") await mod.register(ctx);
  const command = ${JSON.stringify(command || null)};
  const hook = ${JSON.stringify(hook)};
  if (hook) {
    const fn = pickHook(mod, hook);
    if (!fn) throw new Error('Plugin "${id}" has no hook "' + hook + '".');
    const value = await fn(${JSON.stringify(hookPayload)}, ctx);
    payload = { ok: true, result: value ?? null, events, hook };
  } else if (command) {
    const handler = commands.get(command) || tools.get(command)?.handler;
    if (!handler) throw new Error('Plugin "${id}" has no command "' + command + '".');
    const value = await handler(${JSON.stringify(args ?? {})});
    payload = { ok: true, result: value ?? null, events };
  } else {
    payload = { ok: true, tools: [...tools.keys()], commands: [...commands.keys()], events };
  }
} catch (error) {
  payload = { ok: false, error: String((error && error.message) || error) };
}
writeFileSync("result.json", JSON.stringify(payload));
console.log("plugin harness finished");
`;
}

/** One isolated run of a plugin (load-only, load + one command, or one hook). */
async function runSandboxed(dir, manifest, id, services, command, args, extra = {}) {
  const sandbox = require("./sandbox.cjs");
  const entryFile = path.join(dir, manifest.entry || "index.cjs");
  const root =
    extra.workspaceRoot ||
    (typeof services?.workspaceRoot === "function" ? services.workspaceRoot() : null) ||
    path.resolve(dir, "..", "..");
  const allowNetwork =
    Array.isArray(manifest.permissions) && manifest.permissions.includes("network");
  const run = await sandbox.runIsolated({
    root,
    extraBinds: [dir],
    code: harness(entryFile, dir, id, command, args, {
      hook: extra.hook || null,
      payload: extra.payload || {},
      workspaceRoot: root,
      dataDir: extra.dataDir || dataDirFor(dir, id, extra.workspaceRoot || root),
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
    }),
    language: "node",
    timeoutMs: Number(manifest.timeoutMs) || 30000,
    allowNetwork,
  });
  const payload = run.result || null;
  if (payload && payload.ok === false)
    return { ok: false, error: payload.error, output: run.output };
  if (!payload)
    return {
      ok: false,
      error: String(run.output || "the plugin sandbox produced no result").slice(-800),
      output: run.output,
    };
  for (const entry of payload.events || []) {
    try {
      services?.emit?.(`plugin:${id}:${entry.event}`, entry.payload);
    } catch {
      /* a listener must never break the plugin host */
    }
  }
  return { ok: true, ...payload, output: run.output };
}

async function load(root, id, services) {
  const dir = findDir(root, id);
  if (!dir) return { ok: false, error: `Plugin "${id}" was not found.` };
  const file = manifestPath(dir);
  const manifest = file ? readJson(file) : null;
  if (!manifest) return { ok: false, error: `Plugin "${id}" has no readable manifest.` };
  const enabled = catalogEnabled(root, id, manifest.enabled !== false);
  if (!enabled) return { ok: false, error: `Plugin "${id}" is disabled.` };

  const entryFile = path.join(dir, manifest.entry || "index.cjs");
  if (!fs.existsSync(entryFile)) {
    return {
      ok: false,
      error: `Plugin "${id}" entry is missing (${manifest.entry || "index.cjs"}).`,
    };
  }

  await unload(id);
  const state = {
    manifest,
    tools: new Map(),
    commands: new Map(),
    disposers: [],
    error: null,
    trusted: false,
  };

  // Main-process trust is opt-in AND owner-approved — never the default.
  let trusted = false;
  if (wantsHostAccess(manifest) && typeof services?.approveHostAccess === "function") {
    try {
      trusted = Boolean(
        await services.approveHostAccess({
          id,
          name: manifest.name || id,
          permissions: manifest.permissions || [],
          path: dir,
        }),
      );
    } catch {
      trusted = false;
    }
  }

  if (trusted) {
    state.trusted = true;
    try {
      clearRequireCache(dir);
      // Approved by the owner through the governance gate: this plugin really
      // does run with Electron main-process access.
      const mod = require(entryFile);
      state.module = mod;
      if (typeof mod.register === "function") {
        await mod.register(buildContext(id, dir, manifest, services, state));
      }
      loaded.set(id, state);
      services.log(
        `[plugin:${id}] loaded v${manifest.version || "0"} (owner-approved host access)`,
      );
      return { ok: true, plugin: describeOne(dir), trusted: true };
    } catch (error) {
      state.error = String(error?.message || error);
      loaded.set(id, state);
      services.log(`[plugin:${id}] failed to load: ${state.error}`);
      return { ok: false, error: state.error };
    }
  }

  const run = await runSandboxed(dir, manifest, id, services, null, null);
  if (!run.ok) {
    state.error = run.error;
    loaded.set(id, state);
    services?.log?.(`[plugin:${id}] failed to load: ${state.error}`);
    return { ok: false, error: state.error, sandboxed: true };
  }
  // Registered names are real; each invocation re-runs the plugin in its own
  // isolated child, so no plugin code ever lives in the main process.
  for (const name of run.commands || [])
    state.commands.set(name, (args) => runSandboxed(dir, manifest, id, services, name, args));
  for (const name of run.tools || [])
    state.tools.set(name, {
      meta: { sandboxed: true },
      handler: (args) => runSandboxed(dir, manifest, id, services, name, args),
    });
  loaded.set(id, state);
  services?.log?.(`[plugin:${id}] loaded v${manifest.version || "0"} (sandboxed)`);
  return { ok: true, plugin: describeOne(dir), sandboxed: true };
}

async function unload(id) {
  const state = loaded.get(id);
  if (!state) return { ok: true };
  for (const dispose of state.disposers) {
    try {
      dispose();
    } catch {
      /* a broken disposer must not block unloading */
    }
  }
  try {
    if (typeof state.module?.deactivate === "function") await state.module.deactivate();
  } catch {
    /* deactivate failures are logged by the caller */
  }
  loaded.delete(id);
  return { ok: true };
}

function setEnabled(rootOrRoots, id, enabled) {
  const roots = normalizeRoots(rootOrRoots);
  const wanted = String(id || "");
  if (enabled && roots.workspaceRoot && roots.appRoot) ensureWorkspaceCopy(roots, wanted);
  let capOk = false;
  if (roots.workspaceRoot) {
    try {
      const capabilities = require("./capabilities.cjs");
      const listed = (capabilities.list(roots).items || []).filter(
        (item) => item.tree === "plugins",
      );
      const match = listed.find((item) => idsMatch(item, wanted));
      const capId =
        (match && match.id) ||
        (wanted.includes("/") ? wanted : `plugins/installed/${pluginSlug(wanted)}`);
      const cap = capabilities.setEnabled(
        { workspaceRoot: roots.workspaceRoot },
        capId,
        Boolean(enabled),
      );
      capOk = Boolean(cap.ok);
    } catch {
      capOk = false;
    }
  }
  const workspaceDir = roots.workspaceRoot ? findInRoot(roots.workspaceRoot, wanted) : null;
  if (workspaceDir) {
    const file = manifestPath(workspaceDir) || path.join(workspaceDir, "manifest.json");
    const manifest = readJson(file) || {
      id: pluginSlug(wanted),
      name: pluginSlug(wanted),
      version: "0.0.0",
    };
    manifest.enabled = Boolean(enabled);
    writeJson(file, manifest);
    if (!enabled) void unload(manifest.id || pluginSlug(wanted));
    return { ok: true, plugin: describeOne(workspaceDir) };
  }
  if (capOk) return { ok: true, id: wanted, enabled: Boolean(enabled) };
  return { ok: false, error: `Plugin "${id}" was not found.` };
}

function remove(rootOrRoots, id) {
  const roots = normalizeRoots(rootOrRoots);
  const wanted = String(id || "");
  const dir = roots.workspaceRoot
    ? findInRoot(roots.workspaceRoot, wanted)
    : findDir(rootOrRoots, wanted);
  if (!dir) return { ok: false, error: `Plugin "${id}" was not found.` };
  if (
    roots.appRoot &&
    containsPath(roots.appRoot, dir) &&
    !(roots.workspaceRoot && containsPath(roots.workspaceRoot, dir))
  ) {
    return {
      ok: false,
      error: "Shipped plugins stay in the catalog. Disable them instead of removing.",
    };
  }
  void unload(pluginSlug(wanted));
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, removed: id };
}

/** Install from a folder already on disk (copy) — no network access here. */
function install(root, sourceDir) {
  const dir = pluginsDir(root);
  if (!dir) return { ok: false, error: "No FRIDAY workspace is selected." };
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return { ok: false, error: "The selected plugin folder does not exist." };
  }
  const file = manifestPath(sourceDir);
  const manifest = file ? readJson(file) : null;
  if (!manifest?.id) return { ok: false, error: "The folder has no plugin manifest with an id." };
  const target = path.join(dir, manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(sourceDir, target, { recursive: true });
  return { ok: true, plugin: describeOne(target) };
}

async function invoke(root, id, command, args, services) {
  let state = loaded.get(id);
  if (!state) {
    const result = await load(root, id, services);
    if (!result.ok) return result;
    state = loaded.get(id);
  }
  const handler = state?.commands.get(command) || state?.tools.get(command)?.handler;
  if (!handler) return { ok: false, error: `Plugin "${id}" has no command "${command}".` };
  try {
    const value = await handler(args || {});
    // A sandboxed handler already answers with the isolated run's envelope;
    // a trusted (owner-approved) handler returns its raw value.
    if (!state.trusted && value && typeof value === "object" && "ok" in value) {
      return value.ok
        ? { ok: true, result: value.result ?? null, sandboxed: true }
        : { ok: false, error: value.error, sandboxed: true };
    }
    return { ok: true, result: value };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/** Every tool contributed by loaded plugins, for the Brain's tool registry. */
function tools() {
  const out = [];
  for (const [id, state] of loaded) {
    for (const [name, tool] of state.tools) {
      out.push({ plugin: id, name, ...tool.meta });
    }
  }
  return out;
}

/** Load every enabled plugin once, at boot or after a workspace change. */
async function loadEnabled(rootOrRoots, services) {
  const roots = normalizeRoots(rootOrRoots);
  const results = [];
  const seen = new Set();
  const packs = roots.appRoot
    ? (require("./capabilities.cjs").list(roots).items || []).filter(
        (item) => item.tree === "plugins" && item.enabled,
      )
    : list(roots.workspaceRoot).filter((plugin) => plugin.enabled);
  for (const plugin of packs) {
    const key = plugin.path || plugin.id;
    const slug = pluginSlug(plugin.id || plugin.path);
    if (seen.has(key) || seen.has(plugin.id) || (slug && seen.has(slug))) continue;
    seen.add(key);
    seen.add(plugin.id);
    if (slug) seen.add(slug);
    results.push({
      id: plugin.id,
      ...(await load(roots.appRoot ? roots : roots.workspaceRoot, plugin.id, services)),
    });
  }
  return results;
}

/* ------------------------------------------------------- hook registry */
// Real lifecycle moments FRIDAY already has. Do not invent hooks for events
// the app does not fire. Dispatch reuses this plugin host (sandbox by default,
// owner-approved host require() when granted) — not a second event bus.

const HOOKS = [
  "on-app-start",
  "on-app-quit",
  "on-turn-start",
  "on-turn-complete",
  "on-error",
  "on-idle",
  "on-skill-run",
  "on-file-change",
];
const HOOK_SET = new Set(HOOKS);

function canonicalHook(name) {
  const raw = String(name || "")
    .trim()
    .replace(/[_\s]+/g, "-");
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (HOOK_SET.has(lower)) return lower;
  const fromCamel = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
  return HOOK_SET.has(fromCamel) ? fromCamel : null;
}

function hookCamel(hook) {
  return String(hook).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function declaredHooks(source) {
  const raw = Array.isArray(source?.hooks) ? source.hooks : [];
  return [...new Set(raw.map(canonicalHook).filter(Boolean))];
}

function inferHookRisk(item) {
  const explicit = String((item && item.risk) || "safe");
  if (explicit === "write" || explicit === "exec") return explicit;
  const perms = Array.isArray(item && item.permissions) ? item.permissions.map(String) : [];
  if (
    perms.some((perm) =>
      /shell\.|process\.|exec|\.cmd|electron|main-process|^host$|^node$/i.test(perm),
    )
  )
    return "exec";
  if (perms.some((perm) => /fs\.write|network|workspace\.write/i.test(perm))) return "write";
  return "safe";
}

function workspacePluginItems(workspaceRoot) {
  if (!workspaceRoot) return [];
  return list(workspaceRoot).map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    path: plugin.path,
    entry: plugin.entry,
    enabled: plugin.enabled,
    hooks: declaredHooks(plugin),
    permissions: Array.isArray(plugin.permissions) ? plugin.permissions : [],
    risk: inferHookRisk(plugin),
    origin: "workspace",
  }));
}

function catalogPluginItems(roots) {
  const capabilities = require("./capabilities.cjs");
  const report = capabilities.list(roots);
  return (report.items || [])
    .filter((item) => item.tree === "plugins")
    .map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      entry: item.entry || "index.cjs",
      enabled: Boolean(item.enabled),
      hooks: declaredHooks(item),
      permissions: Array.isArray(item.permissions) ? item.permissions : [],
      risk: inferHookRisk(item),
      origin: item.origin || "app",
    }));
}

/** Enabled (or allowDisabled) plugins that declare this hook, catalog first. */
function pluginsForHook(rootOrRoots, hook, allowDisabled, pluginId) {
  const roots = normalizeRoots(rootOrRoots);
  const wanted = canonicalHook(hook);
  if (!wanted) return [];
  const seen = new Set();
  const out = [];
  const push = (item) => {
    if (!item) return;
    const slug = pluginSlug(item.id || item.path);
    if (seen.has(item.id) || (item.path && seen.has(item.path)) || (slug && seen.has(slug))) return;
    if (pluginId && !idsMatch(item, pluginId)) return;
    seen.add(item.id);
    if (item.path) seen.add(item.path);
    if (slug) seen.add(slug);
    // Mark the catalog row even when it is disabled so a workspace copy with a
    // different id (manifest slug vs plugins/installed/<slug>) cannot fire after
    // the owner turned the pack off in capabilities.json.
    if (!allowDisabled && !item.enabled) return;
    if (!declaredHooks(item).includes(wanted)) return;
    out.push({ ...item, hook: wanted });
  };
  for (const item of catalogPluginItems(roots)) push(item);
  for (const item of workspacePluginItems(roots.workspaceRoot)) push(item);
  return out;
}

function entryFileOf(item) {
  if (!item || !item.path) return null;
  const declared = item.entry ? path.join(item.path, item.entry) : null;
  if (declared && fs.existsSync(declared)) return declared;
  for (const name of ["index.cjs", "index.js"]) {
    const file = path.join(item.path, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function pickHookFn(mod, hook) {
  if (!mod || typeof mod !== "object") return null;
  if (typeof mod[hook] === "function") return mod[hook];
  const camel = hookCamel(hook);
  if (typeof mod[camel] === "function") return mod[camel];
  return null;
}

function buildHookContext(item, services) {
  const dir = item.path;
  const id = item.id;
  const dummy = { tools: new Map(), commands: new Map(), disposers: [] };
  const ctx = buildContext(id, dir, readManifestFile(dir) || { id }, services || {}, dummy);
  const workspaceRoot =
    typeof services?.workspaceRoot === "function" ? services.workspaceRoot() : null;
  ctx.os = osSnapshot();
  ctx.workspace = {
    list: (rel = ".") => {
      if (!(item.permissions || []).includes("fs.read")) {
        throw new Error(`plugin ${id} has no fs.read permission`);
      }
      const target = path.resolve(workspaceRoot || dir, String(rel || "."));
      if (workspaceRoot && !containsPath(workspaceRoot, target)) {
        throw new Error("path escapes workspace");
      }
      return fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      }));
    },
    exists: (rel) => {
      if (!(item.permissions || []).includes("fs.read")) {
        throw new Error(`plugin ${id} has no fs.read permission`);
      }
      try {
        const target = path.resolve(workspaceRoot || dir, String(rel || "."));
        if (workspaceRoot && !containsPath(workspaceRoot, target)) return false;
        return fs.existsSync(target);
      } catch {
        return false;
      }
    },
    stat: (rel) => {
      if (!(item.permissions || []).includes("fs.read")) {
        throw new Error(`plugin ${id} has no fs.read permission`);
      }
      const target = path.resolve(workspaceRoot || dir, String(rel || "."));
      if (workspaceRoot && !containsPath(workspaceRoot, target)) {
        throw new Error("path escapes workspace");
      }
      const info = fs.statSync(target);
      return { size: info.size, mtimeMs: info.mtimeMs, directory: info.isDirectory() };
    },
    readFile: (rel, maxBytes) => {
      if (!(item.permissions || []).includes("fs.read")) {
        throw new Error(`plugin ${id} has no fs.read permission`);
      }
      const target = path.resolve(workspaceRoot || dir, String(rel || "."));
      if (workspaceRoot && !containsPath(workspaceRoot, target)) {
        throw new Error("path escapes workspace");
      }
      const cap = Math.min(262144, Math.max(1, Number(maxBytes) || 65536));
      const buf = fs.readFileSync(target);
      const slice = buf.subarray(0, cap);
      return { bytes: slice.length, truncated: buf.length > cap, text: slice.toString("utf8") };
    },
    walk: (rel, opts) => {
      if (!(item.permissions || []).includes("fs.read")) {
        throw new Error(`plugin ${id} has no fs.read permission`);
      }
      if (!workspaceRoot) throw new Error("no workspace is selected");
      return walkWorkspace(workspaceRoot, rel || ".", opts || {});
    },
  };
  return ctx;
}

async function fireOneHook(item, hook, payload, services, roots) {
  const entryFile = entryFileOf(item);
  if (!entryFile) {
    return { ok: false, id: item.id, error: `Plugin "${item.id}" entry is missing.` };
  }
  const manifest = readManifestFile(item.path) || {
    id: item.id,
    entry: item.entry || "index.cjs",
    permissions: item.permissions || [],
  };
  const state = loaded.get(item.id) || loaded.get(path.basename(item.path));
  if (state?.trusted && state.module) {
    const fn = pickHookFn(state.module, hook);
    if (!fn) return { ok: false, id: item.id, error: `Plugin "${item.id}" has no hook "${hook}".` };
    try {
      const value = await fn(payload || {}, buildHookContext(item, services));
      return { ok: true, id: item.id, result: value ?? null, trusted: true };
    } catch (error) {
      return { ok: false, id: item.id, error: String(error?.message || error) };
    }
  }
  const workspaceRoot = roots.workspaceRoot || roots.appRoot;
  const dataDir = dataDirFor(item.path, item.id, roots.workspaceRoot);
  const run = await runSandboxed(item.path, manifest, item.id, services, null, null, {
    hook,
    payload: payload || {},
    workspaceRoot,
    dataDir,
  });
  if (!run.ok) return { ok: false, id: item.id, error: run.error, sandboxed: true };
  return { ok: true, id: item.id, result: run.result ?? null, sandboxed: true };
}

/**
 * Call every enabled plugin that declared `hook`. Consequential (write/exec)
 * hooks must pass services.authorizeHook — the same tool-authority gate tools
 * and modules use. A plugin is not a bypass.
 */
async function dispatch(rootOrRoots, hook, payload, options = {}) {
  const wanted = canonicalHook(hook);
  if (!wanted) {
    return {
      ok: false,
      error: `Unknown plugin hook "${hook}".`,
      hook: String(hook || ""),
      fired: [],
    };
  }
  const roots = normalizeRoots(rootOrRoots);
  const services = options.services || {
    workspaceRoot: () => roots.workspaceRoot,
    log: () => {},
    emit: () => {},
    on: () => () => {},
    kernel: async () => null,
  };
  if (typeof services.workspaceRoot !== "function") {
    services.workspaceRoot = () => roots.workspaceRoot;
  }
  const allowDisabled = Boolean(options.allowDisabled);
  const pluginId = String(options.pluginId || options.id || "").trim();
  const targets = pluginsForHook(roots, wanted, allowDisabled, pluginId);
  if (pluginId && !targets.length) {
    return {
      ok: false,
      error: `Plugin "${pluginId}" is not installed or does not declare hook "${wanted}".`,
      hook: wanted,
      fired: [],
    };
  }
  const fired = [];
  for (const item of targets) {
    const risk = inferHookRisk(item);
    if (risk !== "safe") {
      if (
        typeof options.authorizeHook === "function" ||
        typeof services.authorizeHook === "function"
      ) {
        const authorize = options.authorizeHook || services.authorizeHook;
        let allowed = false;
        try {
          const decision = await authorize({
            id: item.id,
            name: item.name,
            hook: wanted,
            risk,
            permissions: item.permissions,
            payload: payload || {},
          });
          allowed =
            decision === true || (decision && decision.ok !== false && decision.granted !== false);
        } catch (error) {
          fired.push({
            ok: false,
            id: item.id,
            denied: true,
            risk,
            error: String(error?.message || error),
          });
          continue;
        }
        if (!allowed) {
          fired.push({
            ok: false,
            id: item.id,
            denied: true,
            risk,
            error: `Plugin hook "${wanted}" on "${item.id}" was not approved.`,
          });
          continue;
        }
      } else {
        fired.push({
          ok: false,
          id: item.id,
          denied: true,
          risk,
          error: `Plugin hook "${wanted}" on "${item.id}" needs owner approval (${risk}).`,
        });
        continue;
      }
    }
    fired.push({ ...(await fireOneHook(item, wanted, payload || {}, services, roots)), risk });
  }
  return {
    ok: fired.every((row) => row.ok || row.denied),
    hook: wanted,
    fired,
    skipped: targets.length - fired.length,
  };
}

module.exports = {
  HOOKS,
  canonicalHook,
  declaredHooks,
  inferHookRisk,
  list,
  load,
  unload,
  reload: load,
  setEnabled,
  remove,
  install,
  invoke,
  tools,
  loadEnabled,
  pluginsDir,
  dispatch,
  pluginsForHook,
  idsMatch,
  dataDirFor,
  checkUpdates,
  declaredGithubSource,
  comparePluginVersions,
};
