// FRIDAY · tools/filesystem/file-list
//
// Node fs.readdir under friday-contract.resolveInside — same root contract as skills.cjs.
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

async function run({ path: rel = ".", root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  const resolved = inside(dir, rel);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.path)) return { ok: false, error: "Path not found." };
  const stat = fs.statSync(resolved.path);
  if (!stat.isDirectory()) {
    return { ok: true, path: resolved.relative, kind: "file", size: stat.size };
  }
  const entries = fs.readdirSync(resolved.path, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? "dir" : "file",
  }));
  return { ok: true, path: resolved.relative, kind: "dir", count: entries.length, entries };
}

module.exports = { run };
