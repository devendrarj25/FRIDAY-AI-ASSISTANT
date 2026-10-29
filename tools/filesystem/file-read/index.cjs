// FRIDAY · tools/filesystem/file-read
//
// fs.readFileSync inside friday-contract.resolveInside.
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

async function run({ path: rel, maxChars = 200000, root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  if (!rel) return { ok: false, error: "A file path is required." };
  const resolved = inside(dir, rel);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.path) || !fs.statSync(resolved.path).isFile()) {
    return { ok: false, error: "File not found." };
  }
  const buf = fs.readFileSync(resolved.path);
  if (buf.includes(0))
    return { ok: false, error: "That file looks binary — I will not decode it as text." };
  const text = buf.toString("utf8").slice(0, Number(maxChars) || 200000);
  return { ok: true, path: resolved.relative, bytes: buf.length, text };
}

module.exports = { run };
