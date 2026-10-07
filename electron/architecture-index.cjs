// FRIDAY · architecture index.
//
// FRIDAY keeps a real map of its own project: every source file, which area it
// belongs to, its hash, and which other files it depends on. The map is what
// lets the impact engine decide whether a change can be hot-reloaded, needs a
// restart, or forces a rebuild — instead of guessing from the filename.
//
// The index is persisted to <root>/database/architecture-index.json so the next
// boot diffs against it rather than re-walking a large workspace.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { classify, walk } = require("./importer.cjs");

const SCHEMA = 2;
const INDEX_FILE = path.join("database", "architecture-index.json");

// Only text sources are parsed for edges; everything else is tracked by hash.
const PARSED = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".py",
  ".json",
  ".yml",
  ".yaml",
]);
const CODE_EXT = [".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs"];
const MAX_PARSE_BYTES = 512 * 1024;

const norm = (p) => String(p || "").replace(/\\/g, "/");
const hash = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");

function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_PARSE_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Resolve a relative JS/TS specifier the way the bundler would. */
function resolveRelative(fromRel, spec, files) {
  const base = norm(path.posix.join(path.posix.dirname(fromRel), spec));
  const candidates = [base];
  for (const ext of CODE_EXT) candidates.push(`${base}${ext}`, `${base}/index${ext}`);
  candidates.push(`${base}.json`, `${base}.css`);
  return candidates.find((c) => files.has(c)) || null;
}

/** Resolve an "@/..." alias (Vite maps it to src/). */
function resolveAlias(spec, files) {
  const rel = `src/${spec.slice(2)}`;
  const candidates = [rel];
  for (const ext of CODE_EXT) candidates.push(`${rel}${ext}`, `${rel}/index${ext}`);
  candidates.push(`${rel}.css`, `${rel}.json`);
  return candidates.find((c) => files.has(c)) || null;
}

/** Resolve a Python import inside the kernel package. */
function resolvePython(fromRel, spec, files) {
  const dir = path.posix.dirname(fromRel);
  const asFile = `${dir}/${spec.replace(/\./g, "/")}.py`;
  if (files.has(asFile)) return asFile;
  const asPkg = `${dir}/${spec.replace(/\./g, "/")}/__init__.py`;
  return files.has(asPkg) ? asPkg : null;
}

const JS_IMPORT =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_IMPORT = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;

/**
 * Extract outgoing edges for one file.
 * Returns { deps: [relative paths], external: [package names], missing: [specs] }.
 */
function extractEdges(rel, files, root) {
  const ext = path.extname(rel).toLowerCase();
  if (!PARSED.has(ext)) return { deps: [], external: [], missing: [] };
  const text = readText(path.join(root, rel));
  if (!text) return { deps: [], external: [], missing: [] };

  const deps = new Set();
  const external = new Set();
  const missing = new Set();

  if ([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs"].includes(ext)) {
    for (const match of text.matchAll(JS_IMPORT)) {
      const spec = match[1] || match[2] || match[3];
      if (!spec) continue;
      if (spec.startsWith(".")) {
        const target = resolveRelative(rel, spec, files);
        if (target) deps.add(target);
        else if (!/\.(css|svg|png|jpg|json)$/i.test(spec)) missing.add(spec);
      } else if (spec.startsWith("@/")) {
        const target = resolveAlias(spec, files);
        if (target) deps.add(target);
        else missing.add(spec);
      } else if (!spec.startsWith("node:")) {
        external.add(
          spec
            .split("/")
            .slice(0, spec.startsWith("@") ? 2 : 1)
            .join("/"),
        );
      }
    }
  } else if (ext === ".py") {
    for (const match of text.matchAll(PY_IMPORT)) {
      const spec = match[1] || match[2];
      if (!spec) continue;
      if (spec.startsWith(".")) {
        const target = resolvePython(rel, spec.replace(/^\.+/, ""), files);
        if (target) deps.add(target);
        else missing.add(spec);
      } else {
        const target = resolvePython(rel, spec, files);
        if (target) deps.add(target);
        else external.add(spec.split(".")[0]);
      }
    }
  } else if (rel === "package.json") {
    const pkg = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    })();
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      external.add(name);
    }
  } else if (rel === "electron-builder.yml") {
    for (const match of text.matchAll(/(?:^|\s)-\s*["']?([\w./-]+\/\*\*?[\w./*-]*)["']?/g)) {
      external.add(`builder:${match[1]}`);
    }
  }

  return { deps: [...deps], external: [...external], missing: [...missing] };
}

/** Entry points that force a rebuild whenever anything reachable from them changes. */
const ENTRY_POINTS = [
  "electron/main.cjs",
  "electron/preload.cjs",
  "src/renderer/main.tsx",
  "src/router.tsx",
  "src/server.ts",
  "src/start.ts",
  "kernel/main.py",
  "package.json",
  "electron-builder.yml",
  "vite.config.ts",
];

/**
 * Walk the workspace and produce the full index.
 * Runs off the UI thread (see electron/scan-worker.cjs).
 */
function buildIndex(root) {
  if (!root || !fs.existsSync(root)) throw new Error("No FRIDAY workspace is selected.");
  const found = walk(root);
  const files = new Map();

  for (const entry of found) {
    const rel = norm(entry.path);
    const { area, hot } = classify(rel);
    let mtime = 0;
    let digest = null;
    try {
      const stat = fs.statSync(entry.full);
      mtime = stat.mtimeMs;
      if (stat.size <= MAX_PARSE_BYTES) digest = hash(fs.readFileSync(entry.full));
    } catch {
      /* vanished mid-walk */
    }
    files.set(rel, { area, hot, size: entry.size, mtime, hash: digest });
  }

  const names = new Set(files.keys());
  const edges = {};
  const reverse = {};
  const broken = [];
  const externals = new Set();

  for (const rel of names) {
    const { deps, external, missing } = extractEdges(rel, names, root);
    if (deps.length) edges[rel] = deps;
    for (const dep of deps) (reverse[dep] ??= []).push(rel);
    for (const pkg of external) externals.add(pkg);
    for (const spec of missing) broken.push({ file: rel, specifier: spec });
  }

  return {
    schema: SCHEMA,
    root,
    at: Date.now(),
    totals: { files: files.size, edges: Object.keys(edges).length, broken: broken.length },
    files: Object.fromEntries(files),
    edges,
    reverse,
    broken,
    externals: [...externals].sort(),
    entryPoints: ENTRY_POINTS.filter((e) => names.has(e)),
  };
}

function indexPath(root) {
  return path.join(root, INDEX_FILE);
}

function loadIndex(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(root), "utf8"));
    if (parsed?.schema !== SCHEMA || parsed.root !== root) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveIndex(index) {
  try {
    const file = indexPath(index.root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(index));
    return file;
  } catch {
    return null;
  }
}

/**
 * Re-read only the paths that changed and patch the index in place.
 * Returns { index, changes: [{ path, state, area, hot }] }.
 */
function updateIndex(index, relatives) {
  const root = index.root;
  const changes = [];
  const names = new Set(Object.keys(index.files));
  for (const raw of relatives) {
    const rel = norm(raw).replace(/^\/+/, "");
    if (!rel) continue;
    const full = path.join(root, rel);
    const before = index.files[rel];
    if (!fs.existsSync(full)) {
      if (before) {
        delete index.files[rel];
        delete index.edges[rel];
        changes.push({ path: rel, state: "deleted", area: before.area, hot: before.hot });
      }
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const digest = stat.size <= MAX_PARSE_BYTES ? hash(fs.readFileSync(full)) : null;
    if (before && before.hash && digest && before.hash === digest) continue;
    const { area, hot } = classify(rel);
    index.files[rel] = { area, hot, size: stat.size, mtime: stat.mtimeMs, hash: digest };
    names.add(rel);
    const { deps } = extractEdges(rel, names, root);
    if (deps.length) index.edges[rel] = deps;
    else delete index.edges[rel];
    changes.push({ path: rel, state: before ? "changed" : "added", area, hot });
  }

  if (changes.length) {
    // Reverse map is cheap to rebuild from the (already in-memory) edge table.
    const reverse = {};
    for (const [from, deps] of Object.entries(index.edges)) {
      for (const dep of deps) (reverse[dep] ??= []).push(from);
    }
    index.reverse = reverse;
    index.at = Date.now();
    index.totals = {
      files: Object.keys(index.files).length,
      edges: Object.keys(index.edges).length,
      broken: (index.broken || []).length,
    };
  }
  return { index, changes };
}

module.exports = {
  SCHEMA,
  ENTRY_POINTS,
  buildIndex,
  loadIndex,
  saveIndex,
  updateIndex,
  extractEdges,
  indexPath,
};
