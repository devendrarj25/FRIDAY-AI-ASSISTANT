// FRIDAY · tools/automation/replace-in-file
//
// fs read/write inside friday-contract.resolveInside. dryRun defaults true.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const fs = require("node:fs");
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));

async function run({ path: rel, find, replace = "", dryRun = true, root } = {}) {
  const dir = root || contract.rootFromEnv();
  if (!dir) return { ok: false, error: "No FRIDAY folder is selected." };
  if (!rel || find == null || find === "")
    return { ok: false, error: "A path and a find string are required." };
  const resolved = contract.resolveInside(dir, rel);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.path) || !fs.statSync(resolved.path).isFile()) {
    return { ok: false, error: "File not found." };
  }
  const original = fs.readFileSync(resolved.path, "utf8");
  const next = original.split(String(find)).join(String(replace));
  const count = original === next ? 0 : original.split(String(find)).length - 1;
  if (!dryRun && count) fs.writeFileSync(resolved.path, next, "utf8");
  return { ok: true, path: resolved.relative, dryRun: Boolean(dryRun), replacements: count };
}

module.exports = { run };
