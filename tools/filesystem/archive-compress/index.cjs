// FRIDAY · tools/filesystem/archive-compress
//
// Delegates to electron/importer.cjs createArchive().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const fs = require("node:fs");
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));

function workspaceRoot(input = {}) {
  const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
  return input.root || contract.rootFromEnv();
}

function needRoot(root) {
  if (root) return null;
  return {
    ok: false,
    error: "No FRIDAY folder is selected — choose the FRIDAY folder first.",
  };
}

function inside(root, inputPath) {
  return contract.resolveInside(root, inputPath);
}

async function run({ source, dest, root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  if (!source || !dest)
    return { ok: false, error: "A source path and an archive destination are required." };
  const src = inside(dir, source);
  const target = inside(dir, dest);
  if (!src.ok) return src;
  if (!target.ok) return target;
  const importer = require(path.join(ELECTRON, "importer.cjs"));
  const result = await importer.createArchive(src.path, target.path);
  return { ...result, source: src.relative, dest: target.relative };
}

module.exports = { run };
