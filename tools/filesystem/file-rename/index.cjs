// FRIDAY · tools/filesystem/file-rename
//
// fs.renameSync to a sibling name inside friday-contract.resolveInside.
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

async function run({ path: rel, name, root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  if (!rel || !name) return { ok: false, error: "A path and a new name are required." };
  if (/[\\/]/.test(String(name)))
    return { ok: false, error: "The new name cannot contain a path separator." };
  const src = inside(dir, rel);
  if (!src.ok) return src;
  if (!fs.existsSync(src.path)) return { ok: false, error: "Path not found." };
  const destPath = path.join(path.dirname(src.path), String(name));
  const dest = inside(dir, destPath);
  if (!dest.ok) return dest;
  fs.renameSync(src.path, dest.path);
  return { ok: true, from: src.relative, to: dest.relative };
}

module.exports = { run };
