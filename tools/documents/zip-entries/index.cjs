const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
const fs = require("node:fs");
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
function workspaceRoot(input = {}) {
  return input.root || contract.rootFromEnv();
}
async function run({ path: rel, root } = {}) {
  const dir = workspaceRoot({ root });
  if (!dir)
    return { ok: false, error: "No FRIDAY folder is selected — choose the FRIDAY folder first." };
  if (!rel) return { ok: false, error: "A file path is required." };
  const resolved = contract.resolveInside(dir, rel);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.path) || !fs.statSync(resolved.path).isFile()) {
    return { ok: false, error: "File not found." };
  }
  try {
    const documents = require(path.join(ELECTRON, "document-extract.cjs"));
    const files = documents.unzip(fs.readFileSync(resolved.path));
    const entries = [...files.keys()];
    return { ok: true, count: entries.length, entries: entries.slice(0, 200) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
