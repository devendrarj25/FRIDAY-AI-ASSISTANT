/**
 * FRIDAY · read-only source access (main process only).
 *
 * The self-maintenance stack already knows WHICH files exist (architecture
 * index) and WHAT changed (impact engine). What it never had is a way for
 * FRIDAY herself to actually READ a file of her own project when she is
 * diagnosing something or preparing an approved fix.
 *
 * This module closes exactly that gap and nothing more:
 *   - every path is resolved and forced to stay inside the project root
 *   - the same ignore list as the importer walk is honoured
 *   - files are size-capped and returned as text only
 *   - there is NO write path here on purpose. Writing her own source keeps
 *     going through self-maintenance apply() + governance approval.
 */
const fs = require("fs");
const path = require("path");

const { walk } = require("./importer.cjs");

const MAX_READ_BYTES = 512 * 1024;
const MAX_SEARCH_FILES = 4000;
const MAX_MATCHES = 200;

/** Runtime / generated trees are not FRIDAY's source. Searching them first
 *  crowded out `src/` once a local `.friday-dev` or Vite `.output` existed. */
const SKIP_SEARCH_PREFIXES = [".friday-dev/", ".output/", ".cursor/", "coverage/", "htmlcov/"];

/** Extensions worth returning as text for reading/searching. */
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".py",
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".md",
  ".txt",
  ".css",
  ".html",
  ".sql",
  ".sh",
  ".ps1",
  ".cmd",
  ".bat",
  ".nsh",
  ".toml",
  ".ini",
  ".env.example",
  ".gitignore",
]);

const norm = (p) => String(p || "").replace(/\\/g, "/");

const isText = (rel) => TEXT_EXT.has(path.extname(rel).toLowerCase());

/**
 * Resolve a relative project path safely. Returns null when the path escapes
 * the root (`..`, absolute paths, symlink games).
 */
function safeResolve(root, relative) {
  if (!root) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, String(relative || ""));
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return { full: target, rel: norm(rel) };
}

/** One file of FRIDAY's own project, as text. */
function readSource(root, relative) {
  const resolved = safeResolve(root, relative);
  if (!resolved) return { ok: false, error: "Path is outside the FRIDAY project root." };
  let stat;
  try {
    stat = fs.statSync(resolved.full);
  } catch {
    return { ok: false, error: `Not found: ${resolved.rel}` };
  }
  if (stat.isDirectory()) return { ok: false, error: `${resolved.rel} is a folder.` };
  if (!isText(resolved.rel)) return { ok: false, error: `${resolved.rel} is not a text file.` };
  if (stat.size > MAX_READ_BYTES) {
    return {
      ok: false,
      error: `${resolved.rel} is ${Math.round(stat.size / 1024)} KB — too large to read in one go.`,
    };
  }
  let text;
  try {
    text = fs.readFileSync(resolved.full, "utf8");
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return {
    ok: true,
    path: resolved.rel,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    lines: text.split("\n").length,
    text,
  };
}

/** Directory listing inside the project root. */
function listSources(root, relative = "") {
  const resolved = relative
    ? safeResolve(root, relative)
    : { full: path.resolve(root || ""), rel: "" };
  if (!resolved) return { ok: false, error: "Path is outside the FRIDAY project root." };
  let entries;
  try {
    entries = fs.readdirSync(resolved.full, { withFileTypes: true });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return {
    ok: true,
    path: resolved.rel,
    entries: entries
      .filter((e) => !e.name.startsWith(".") || e.name === ".github")
      .map((e) => ({
        name: e.name,
        path: norm(path.posix.join(resolved.rel, e.name)),
        kind: e.isDirectory() ? "dir" : "file",
        readable: e.isDirectory() ? true : isText(e.name),
      }))
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
      ),
  };
}

/**
 * Plain-substring search across the project's text files. Deliberately simple
 * and bounded — this is FRIDAY looking something up in her own code, not a
 * general-purpose grep service.
 */
function searchSource(root, query, options = {}) {
  const needle = String(query || "").trim();
  if (needle.length < 2)
    return { ok: false, error: "Give me at least two characters to search for." };
  if (!root || !fs.existsSync(root))
    return { ok: false, error: "No FRIDAY project root is selected." };

  const limit = Math.min(Number(options.limit) || 60, MAX_MATCHES);
  const under = options.under ? norm(options.under).replace(/^\/+|\/+$/g, "") : "";
  const lower = needle.toLowerCase();
  const matches = [];
  let scanned = 0;

  const files = walk(root)
    .filter((f) => isText(f.path) && f.size <= MAX_READ_BYTES)
    .filter((f) => !SKIP_SEARCH_PREFIXES.some((prefix) => f.path.startsWith(prefix)))
    .filter((f) => (under ? f.path === under || f.path.startsWith(`${under}/`) : true))
    .slice(0, MAX_SEARCH_FILES);

  for (const file of files) {
    if (matches.length >= limit) break;
    let text;
    try {
      text = fs.readFileSync(file.full, "utf8");
    } catch {
      continue;
    }
    scanned += 1;
    if (!text.toLowerCase().includes(lower)) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && matches.length < limit; i += 1) {
      const line = lines[i];
      if (!line.toLowerCase().includes(lower)) continue;
      matches.push({ path: file.path, line: i + 1, text: line.trim().slice(0, 300) });
    }
  }

  return { ok: true, query: needle, scanned, truncated: matches.length >= limit, matches };
}

module.exports = { readSource, listSources, searchSource, safeResolve, MAX_READ_BYTES };
