// FRIDAY · tools/filesystem/text-stats
//
// Counts from a UTF-8 file inside the FRIDAY root.
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
  if (!fs.existsSync(resolved.path) || !fs.statSync(resolved.path).isFile()) {
    return { ok: false, error: "File not found." };
  }
  const buf = fs.readFileSync(resolved.path);
  if (buf.includes(0)) return { ok: false, error: "That file looks binary." };
  const text = buf.toString("utf8");
  const lines = text.length ? text.split(/\r?\n/).length : 0;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { ok: true, path: resolved.relative, bytes: buf.length, chars: text.length, lines, words };
}

module.exports = { run };
