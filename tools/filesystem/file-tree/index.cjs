// FRIDAY · tools/filesystem/file-tree
//
// Bounded readdir walk under friday-contract.resolveInside.
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

function tree(dir, rel, cap, out) {
  if (out.length >= cap) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= cap) return;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const next = rel ? rel + "/" + entry.name : entry.name;
    out.push({ path: next, kind: entry.isDirectory() ? "dir" : "file" });
    if (entry.isDirectory()) tree(path.join(dir, entry.name), next, cap, out);
  }
}

async function run({ folder = ".", maxEntries = 400, root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  const resolved = inside(dir, folder);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.path) || !fs.statSync(resolved.path).isDirectory()) {
    return { ok: false, error: "Folder not found." };
  }
  const entries = [];
  tree(
    resolved.path,
    resolved.relative === "." ? "" : resolved.relative,
    Number(maxEntries) || 400,
    entries,
  );
  return { ok: true, folder: resolved.relative, count: entries.length, entries };
}

module.exports = { run };
