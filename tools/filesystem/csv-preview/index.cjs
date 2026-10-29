// FRIDAY · tools/filesystem/csv-preview
//
// Delegates to electron/document-extract.cjs parseCsv / extract.
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

async function run({ path: rel, text, root } = {}) {
  const documents = require(path.join(ELECTRON, "document-extract.cjs"));
  if (text != null && String(text).length) {
    return { ok: true, ...documents.extract({ filename: "preview.csv", text: String(text) }) };
  }
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  if (!rel) return { ok: false, error: "A CSV path or text is required." };
  const resolved = inside(dir, rel);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.path)) return { ok: false, error: "File not found." };
  const extracted = documents.extract({
    filename: path.basename(resolved.path),
    bytes: fs.readFileSync(resolved.path),
  });
  return extracted.error
    ? { ok: false, ...extracted }
    : { ok: true, path: resolved.relative, ...extracted };
}

module.exports = { run };
