// FRIDAY · tools/filesystem/file-copy
//
// fs.copyFileSync inside friday-contract.resolveInside.
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

async function run({ from, to, root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  const src = inside(dir, from);
  const dest = inside(dir, to);
  if (!src.ok) return src;
  if (!dest.ok) return dest;
  if (!fs.existsSync(src.path) || !fs.statSync(src.path).isFile()) {
    return { ok: false, error: "Source file not found." };
  }
  fs.mkdirSync(path.dirname(dest.path), { recursive: true });
  fs.copyFileSync(src.path, dest.path);
  return { ok: true, from: src.relative, to: dest.relative, bytes: fs.statSync(dest.path).size };
}

module.exports = { run };
