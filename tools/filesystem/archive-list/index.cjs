// FRIDAY · tools/filesystem/archive-list
//
// Delegates to electron/document-extract.cjs unzip().
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

async function run({ archive, root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  if (!archive) return { ok: false, error: "An archive path is required." };
  const src = inside(dir, archive);
  if (!src.ok) return src;
  if (!fs.existsSync(src.path)) return { ok: false, error: "Archive not found." };
  const documents = require(path.join(ELECTRON, "document-extract.cjs"));
  try {
    const files = documents.unzip(fs.readFileSync(src.path));
    const entries = [...files.keys()].map((name) => ({ name, bytes: files.get(name).length }));
    return { ok: true, archive: src.relative, count: entries.length, entries };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

module.exports = { run };
