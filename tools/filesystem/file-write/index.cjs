// FRIDAY · tools/filesystem/file-write
//
// fs.writeFileSync inside friday-contract.resolveInside.
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

async function run({ path: rel, content = "", root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  if (!rel) return { ok: false, error: "A file path is required." };
  const resolved = inside(dir, rel);
  if (!resolved.ok) return resolved;
  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  const body = String(content);
  fs.writeFileSync(resolved.path, body, "utf8");
  return { ok: true, path: resolved.relative, bytes: Buffer.byteLength(body) };
}

module.exports = { run };
