// FRIDAY · tools/filesystem/file-mkdir
//
// fs.mkdirSync({ recursive: true }) inside friday-contract.resolveInside.
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
  if (!rel) return { ok: false, error: "A folder path is required." };
  const resolved = inside(dir, rel);
  if (!resolved.ok) return resolved;
  fs.mkdirSync(resolved.path, { recursive: true });
  return { ok: true, path: resolved.relative };
}

module.exports = { run };
