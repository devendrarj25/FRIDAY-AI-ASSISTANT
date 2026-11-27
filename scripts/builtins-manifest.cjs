#!/usr/bin/env node
/**
 * FRIDAY · built-in capability manifest (resources/builtins.json).
 *
 * The installer ships every agent, skill, tool, module, plugin and workflow
 * template inside the program folder. This file is the build-time record of
 * exactly what shipped, so the app can tell a built-in from a copy the owner
 * made and report what an update changed without touching the owner's trees.
 *
 *   { schema: 1, release: "<four-part>",
 *     trees: { <tree>: [{ id, segment, path, version, sha256 }] } }
 *
 * Deterministic on purpose: no timestamp, ids sorted, text hashed with LF line
 * ends. A local CMD build and every workflow run this one generator, so they
 * write the same bytes for the same tree.
 *
 * sha256 is the SHA-256 of the sorted "relpath\0filehash\n" lines of the item
 * folder (a flat manifest is its one file).
 *
 *   node scripts/builtins-manifest.cjs --app-root <resources> --out <file> [--release 1.2.3.4]
 *   node scripts/builtins-manifest.cjs --app-root <resources> --verify <file>
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const capabilities = require("../electron/capabilities.cjs");
const engine = require("./release-engine.cjs");

const SCHEMA = 1;
const ROOT = path.resolve(__dirname, "..");

/** Trees that are not capability content of the program folder. */
const SKIPPED_TREES = new Set(["models"]);
/** Folders that hold the owner's runs and state, never shipped content. */
const USER_STATE_SEGMENTS = { workflows: new Set(["active", "schedules", "history"]) };

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const posix = (value) => value.split(path.sep).join("/");

/** Text hashes the same with CRLF or LF (a Windows checkout may rewrite it). */
function fileHash(file) {
  const data = fs.readFileSync(file);
  if (data.subarray(0, 8000).includes(0)) return sha256(data);
  return sha256(Buffer.from(data.toString("latin1").replace(/\r\n/g, "\n"), "latin1"));
}

function collect(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collect(full, name, out);
    else if (entry.isFile()) out.push([name, fileHash(full)]);
  }
}

function itemHash(target) {
  const files = [];
  if (fs.statSync(target).isDirectory()) collect(target, "", files);
  else files.push([path.basename(target), fileHash(target)]);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(files.map(([rel, hash]) => `${rel}\0${hash}\n`).join(""));
}

function defaultRelease() {
  return engine.readCanonicalIdentity({ root: ROOT })?.releaseVersion || "";
}

/** The manifest object for one program folder (resources root or checkout). */
function generate(appRoot, { release = defaultRelease() } = {}) {
  const root = path.resolve(appRoot);
  const trees = {};
  for (const tree of Object.keys(capabilities.TREES))
    if (!SKIPPED_TREES.has(tree)) trees[tree] = [];
  const seen = new Map();
  for (const item of capabilities.scanRoot(root, "app", [root])) {
    if (SKIPPED_TREES.has(item.tree)) continue;
    if (USER_STATE_SEGMENTS[item.tree]?.has(item.segment)) continue;
    if (item.id !== item.id.toLowerCase())
      throw new Error(`built-in id must be lowercase: ${item.id}`);
    const key = item.id.toLowerCase();
    if (seen.has(key))
      throw new Error(
        `duplicate built-in id (compared without case): ${item.id} and ${seen.get(key)}`,
      );
    seen.set(key, item.id);
    trees[item.tree].push({
      id: item.id,
      segment: item.segment,
      path: posix(path.relative(root, item.path)),
      version: item.version,
      sha256: itemHash(item.path),
    });
  }
  for (const list of Object.values(trees))
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schema: SCHEMA, release: String(release), trees };
}

/** Generate and write atomically; returns what was written. */
function write(appRoot, outFile, options) {
  const manifest = generate(appRoot, options);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const temp = `${outFile}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(temp, outFile);
  return manifest;
}

/** Compare a written builtins.json with the tree it should describe. */
function verify(appRoot, file) {
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, problems: [`cannot read ${file}: ${error.message}`] };
  }
  if (!recorded || recorded.schema !== SCHEMA || typeof recorded.trees !== "object")
    return { ok: false, problems: [`${file} is not a schema ${SCHEMA} built-ins manifest`] };
  let actual;
  try {
    actual = generate(appRoot, { release: recorded.release });
  } catch (error) {
    return { ok: false, problems: [error.message] };
  }
  const index = (manifest) => {
    const map = new Map();
    for (const list of Object.values(manifest.trees || {}))
      for (const entry of list) map.set(entry.id, entry);
    return map;
  };
  const want = index(recorded);
  const have = index(actual);
  const problems = [];
  for (const [id, entry] of want) {
    const found = have.get(id);
    if (!found) problems.push(`missing from the tree: ${id}`);
    else if (found.sha256 !== entry.sha256) problems.push(`content differs: ${id}`);
    else if (found.version !== entry.version || found.path !== entry.path)
      problems.push(`record differs: ${id}`);
  }
  for (const id of have.keys()) if (!want.has(id)) problems.push(`not in builtins.json: ${id}`);
  return { ok: problems.length === 0, problems };
}

module.exports = { SCHEMA, USER_STATE_SEGMENTS, generate, write, verify };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const appRoot = flag("app-root") || ROOT;
  try {
    const check = flag("verify");
    if (check) {
      const result = verify(appRoot, check);
      for (const problem of result.problems) console.error(`[friday] ${problem}`);
      if (!result.ok) process.exit(1);
      console.log(`[friday] ok       builtins.json matches ${appRoot}`);
    } else {
      const out = flag("out") || path.join(appRoot, "builtins.json");
      const release = flag("release");
      const manifest = write(appRoot, out, release ? { release } : undefined);
      const total = Object.values(manifest.trees).reduce((sum, list) => sum + list.length, 0);
      console.log(`[friday] ok       builtins.json: ${total} built-ins for v${manifest.release}`);
    }
  } catch (error) {
    console.error(`[friday] builtins manifest failed: ${error.message}`);
    process.exit(1);
  }
}
