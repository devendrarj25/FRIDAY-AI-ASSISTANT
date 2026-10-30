#!/usr/bin/env node
/**
 * Fail a pack in seconds when an electron module requires a file that
 * app.asar does not contain.
 *
 *   node scripts/packaged-requires.cjs
 *   node scripts/packaged-requires.cjs --asar release/win-unpacked/resources/app.asar
 *
 * CMD, Test Build, and Release run this from scripts/build-pipeline.cjs
 * after package and before readiness. No workflow file lists the phase.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

/**
 * Relative requires that are allowed to miss app.asar.
 * Each entry must be lazy (inside a function) and guarded (try/catch).
 * scripts/release-engine.cjs is inside the asar, so it is not listed here.
 */
const LAZY_GUARDED = [];

const PACKED_PREFIXES = ["electron/", "dist-desktop/"];
const PACKED_FILES = new Set(["package.json", "scripts/release-engine.cjs"]);

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".cjs")) out.push(full);
  }
  return out;
}

function normaliseList(files) {
  return (files || []).map((file) =>
    String(file || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, ""),
  );
}

function insideTemplate(source, index) {
  let open = false;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "`") open = !open;
  }
  return open;
}

function relativeRequires(source) {
  const found = [];
  const literal = /require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;
  let match = literal.exec(source);
  while (match) {
    // A require written into a generated script is not loaded with this file.
    if (!insideTemplate(source, match.index)) found.push({ spec: match[2], index: match.index });
    match = literal.exec(source);
  }
  const engine =
    /require\(\s*path\.(?:resolve|join)\(\s*__dirname\s*,\s*(['"])\.\.\1\s*,\s*(['"])scripts\2\s*,\s*(['"])([^'"]+)\3/g;
  match = engine.exec(source);
  while (match) {
    found.push({ spec: `../scripts/${match[4]}`, index: match.index });
    match = engine.exec(source);
  }
  return found;
}

function candidatePaths(fromFile, spec, root) {
  const raw = path.normalize(path.join(path.dirname(fromFile), spec));
  const rel = path.relative(root, raw).split(path.sep).join("/");
  const candidates = [rel];
  if (!path.extname(rel)) {
    candidates.push(
      `${rel}.cjs`,
      `${rel}.js`,
      `${rel}.json`,
      `${rel}/index.cjs`,
      `${rel}/index.js`,
    );
  }
  return candidates;
}

function isGuarded(file, spec) {
  return LAZY_GUARDED.some((row) => row.file === file && row.spec === spec);
}

function checkRequires({ root = ROOT, asarFiles }) {
  const listed = new Set(normaliseList(asarFiles).filter(Boolean));
  const failures = [];
  const electronDir = path.join(root, "electron");
  for (const file of walk(electronDir)) {
    const relFile = path.relative(root, file).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8");
    for (const hit of relativeRequires(source)) {
      const tried = candidatePaths(file, hit.spec, root);
      const inside = tried.some((candidate) => listed.has(candidate));
      if (inside || isGuarded(relFile, hit.spec)) continue;
      failures.push({ file: relFile, spec: hit.spec, tried });
    }
  }
  return failures;
}

// minimatch is electron-builder's own dependency, hoisted by npm. Version 3
// exports the matcher itself; version 10 exports it as `minimatch`.
function matcherFrom(loaded) {
  return typeof loaded === "function" ? loaded : loaded.minimatch;
}

function filesFromPatterns(root, patterns) {
  const positive = patterns.filter((pattern) => pattern && !String(pattern).startsWith("!"));
  const negative = patterns
    .filter((pattern) => String(pattern).startsWith("!"))
    .map((pattern) => String(pattern).slice(1));
  const minimatch = matcherFrom(require("minimatch"));
  const matched = [];
  const skip = new Set(["node_modules", ".git", "release", ".cache", "runtime"]);
  function visit(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name) && dir === root) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      const yes = positive.some((pattern) => minimatch(rel, pattern, { dot: true }));
      const no = negative.some((pattern) => minimatch(rel, pattern, { dot: true }));
      if (yes && !no) matched.push(rel);
    }
  }
  visit(root);
  return matched;
}

function findAsar(root) {
  const release = path.join(root, "release");
  const direct = [
    path.join(release, "win-unpacked", "resources", "app.asar"),
    path.join(release, "linux-unpacked", "resources", "app.asar"),
    path.join(release, "mac", "FRIDAY.app", "Contents", "Resources", "app.asar"),
  ];
  for (const file of direct) {
    if (fs.existsSync(file)) return file;
  }
  if (!fs.existsSync(release)) return null;
  const stack = [release];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        stack.push(full);
      } else if (entry.name === "app.asar") return full;
    }
  }
  return null;
}

function listAsar(file) {
  const asar = require("@electron/asar");
  return normaliseList(asar.listPackage(file));
}

function formatFailure(row) {
  return `${row.file} requires ${row.spec} — not in app.asar (tried ${row.tried.join(", ")})`;
}

function allowedOutsideAsar(rel) {
  if (PACKED_FILES.has(rel)) return true;
  return PACKED_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function main(argv) {
  const args = argv.slice(2);
  let asarPath = "";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--asar") asarPath = path.resolve(args[++i] || "");
  }
  const file = asarPath || findAsar(ROOT);
  if (!file || !fs.existsSync(file)) {
    console.error("[friday] packaged requires: app.asar was not found under release/");
    process.exit(1);
  }
  let listed = [];
  try {
    listed = listAsar(file);
  } catch (error) {
    console.error(
      `[friday] packaged requires: could not list ${file} (${error && error.message ? error.message : error})`,
    );
    process.exit(1);
  }
  const failures = checkRequires({ root: ROOT, asarFiles: listed });
  if (failures.length) {
    console.error(
      `[friday] packaged requires: ${failures.length} relative require(s) missing from ${file}`,
    );
    for (const row of failures) console.error(`[friday] ${formatFailure(row)}`);
    process.exit(1);
  }
  console.log(
    `[friday] packaged requires: ${listed.length} asar entries, electron requires resolve`,
  );
}

if (require.main === module) main(process.argv);

module.exports = {
  LAZY_GUARDED,
  PACKED_FILES,
  checkRequires,
  filesFromPatterns,
  matcherFrom,
  findAsar,
  listAsar,
  formatFailure,
  allowedOutsideAsar,
  relativeRequires,
  normaliseList,
};
