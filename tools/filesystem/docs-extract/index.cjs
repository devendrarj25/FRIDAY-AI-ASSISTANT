// FRIDAY · tools/filesystem/docs-extract
//
// Delegates to electron/skills.cjs invoke(docs.extract).
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
  if (!rel) return { ok: false, error: "A document path is required." };
  const resolved = inside(dir, rel);
  if (!resolved.ok) return resolved;
  const skills = require(path.join(ELECTRON, "skills.cjs"));
  return skills.invoke(dir, "docs.extract", {
    path: resolved.path,
    filename: path.basename(resolved.path),
  });
}

module.exports = { run };
