// FRIDAY · tools/filesystem/file-delete
//
// fs.unlinkSync of a file inside friday-contract.resolveInside. Directories refused.
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

async function run({ path: rel, root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  if (!rel) return { ok: false, error: "A file path is required." };
  const resolved = inside(dir, rel);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.path)) return { ok: false, error: "File not found." };
  if (!fs.statSync(resolved.path).isFile()) {
    return { ok: false, error: "That path is not a file. This tool does not delete folders." };
  }
  fs.unlinkSync(resolved.path);
  return { ok: true, path: resolved.relative, deleted: true };
}

module.exports = { run };
