#!/usr/bin/env node
/**
 * FRIDAY · project arranger.
 *
 * One canonical layout lives in `config/project-structure.json`. This script is
 * the only thing that enforces it, so the checkout stays organised no matter how
 * many upgrades land later:
 *
 *   node scripts/arrange-project.cjs            report only
 *   node scripts/arrange-project.cjs --fix      create missing folders (+ .gitkeep)
 *   node scripts/arrange-project.cjs --clean    also empty transient/log folders
 *
 * It never deletes source files and never touches user data trees
 * (memory, conversations, database, brain-data, backup, releases, config).
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "config", "project-structure.json");
// ONE architecture contract: the layout lives in electron/friday-contract.cjs.
// config/project-structure.json is a generated, read-only mirror of it kept on
// disk for tooling and review — never a second source of truth.
const contract = require(path.join(root, "electron", "friday-contract.cjs"));

/** The canonical layout manifest, straight from the contract. */
function loadManifest() {
  return contract.SOURCE_LAYOUT;
}

/** Rewrite the generated JSON mirror when it drifts from the contract. */
function writeManifestMirror() {
  const generated = {
    $generated:
      "GENERATED FILE — do not edit. Source of truth: electron/friday-contract.cjs (SOURCE_LAYOUT). Regenerate with `node scripts/arrange-project.cjs --fix`.",
    ...loadManifest(),
  };
  const text = `${JSON.stringify(generated, null, 2)}\n`;
  let current = null;
  try {
    current = fs.readFileSync(manifestPath, "utf8");
  } catch {
    current = null;
  }
  // Line endings are not content: a Windows checkout may hold CRLF while the
  // generated text is LF. Compare the JSON itself, never the newline style.
  if (current !== null && current.replace(/\r\n/g, "\n") === text) return false;

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, text);
  return true;
}

/** Every folder the manifest declares, in tree order. */
function declaredFolders(manifest) {
  return Object.values(manifest.trees).flatMap((tree) => tree.folders);
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-desktop",
  "release",
  ".output",
  ".wrangler",
  ".cache",
  ".friday-dev",
  ".workspace",
  ".tanstack",
  // Provisioned runtimes: owned by the Python setup step, never checkout junk.
  ".venv",
  "venv",
  "python-runtime",
  // Gitignored bytecode. Python tests write it; same class as .venv, not checkout junk.
  "__pycache__",
]);

/** Walk the checkout, skipping build output and vendored trees. */
function walk(dir, onFile, onDir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      onDir?.(full);
      walk(full, onFile, onDir);
    } else if (entry.isFile()) {
      onFile?.(full);
    }
  }
}

const rel = (p) => path.relative(root, p).split(path.sep).join("/");

/** Folders declared by the manifest that do not exist yet. */
function missingFolders(manifest) {
  return declaredFolders(manifest).filter((folder) => !fs.existsSync(path.join(root, folder)));
}

/** Forbidden duplicates that came back into the checkout. */
function duplicates(manifest) {
  return (manifest.forbidden?.paths || [])
    .filter((p) => fs.existsSync(path.join(root, p)))
    .map((p) => ({ path: p, canonical: manifest.forbidden.canonical?.[p] || "—" }));
}

/** Transient junk (compiled caches, scratch folders) still on disk. */
function junk(manifest) {
  const globs = manifest.transient?.removeGlobs || [];
  const names = new Set(globs.filter((g) => g.startsWith("**/")).map((g) => g.slice(3)));
  const literals = globs.filter((g) => !g.startsWith("**/"));
  const found = [];
  for (const literal of literals) {
    if (fs.existsSync(path.join(root, literal))) found.push(literal);
  }
  walk(
    root,
    (file) => {
      if (names.has("*.pyc") && file.endsWith(".pyc")) found.push(rel(file));
    },
    (dir) => {
      if (names.has(path.basename(dir))) found.push(rel(dir));
    },
  );
  return [...new Set(found)];
}

/** Create a folder and keep it in version control while it is still empty. */
function ensureFolder(folder) {
  const abs = path.join(root, folder);
  fs.mkdirSync(abs, { recursive: true });
  const keep = path.join(abs, ".gitkeep");
  if (fs.readdirSync(abs).length === 0 && !fs.existsSync(keep)) fs.writeFileSync(keep, "");
}

/** Remove everything inside a transient folder, keeping the folder itself. */
function emptyFolder(folder) {
  const abs = path.join(root, folder);
  if (!fs.existsSync(abs)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(abs)) {
    if (entry === ".gitkeep") continue;
    fs.rmSync(path.join(abs, entry), { recursive: true, force: true });
    removed += 1;
  }
  ensureFolder(folder);
  return removed;
}

/** Full report used by the CLI and by the structure test. */
function inspect() {
  const manifest = loadManifest();
  return {
    manifest,
    missing: missingFolders(manifest),
    duplicates: duplicates(manifest),
    junk: junk(manifest),
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const fix = args.has("--fix") || args.has("--clean");
  const clean = args.has("--clean");
  const report = inspect();

  if (fix) {
    if (writeManifestMirror())
      console.log("regenerated config/project-structure.json from the contract");
    for (const folder of report.missing) ensureFolder(folder);
    for (const item of report.junk)
      fs.rmSync(path.join(root, item), { recursive: true, force: true });
  }
  if (clean) {
    let removed = 0;
    for (const folder of report.manifest.transient?.emptyDirs || []) removed += emptyFolder(folder);
    console.log(`cleaned ${removed} stale item(s) from transient folders`);
  }

  const after = inspect();
  console.log(`folders declared : ${declaredFolders(after.manifest).length}`);
  console.log(`missing          : ${after.missing.length}`);
  console.log(`duplicates       : ${after.duplicates.length}`);
  console.log(`junk             : ${after.junk.length}`);
  for (const folder of after.missing) console.log(`  missing folder  ${folder}`);
  for (const dup of after.duplicates)
    console.log(`  duplicate       ${dup.path} → use ${dup.canonical}`);
  for (const item of after.junk) console.log(`  junk            ${item}`);

  const ok = after.missing.length === 0 && after.duplicates.length === 0 && after.junk.length === 0;
  console.log(ok ? "project layout: arranged" : "project layout: needs `npm run arrange`");
  if (!ok && !fix) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  root,
  loadManifest,
  writeManifestMirror,
  declaredFolders,
  inspect,
  ensureFolder,
  emptyFolder,
};
