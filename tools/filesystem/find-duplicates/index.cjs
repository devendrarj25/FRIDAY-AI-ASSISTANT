// FRIDAY · tools/filesystem/find-duplicates
//
// SHA-1 groups under friday-contract.resolveInside. Read-only.
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

const crypto = require("node:crypto");

function walkFiles(dir, cap, out = []) {
  if (out.length >= cap) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= cap) break;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, cap, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function run({ folder = ".", root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  const resolved = inside(dir, folder);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.path)) return { ok: false, error: "Folder not found." };
  const files = walkFiles(resolved.path, 2000);
  const byHash = new Map();
  for (const file of files) {
    let hash = null;
    try {
      hash = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
    } catch {
      continue;
    }
    const rel = path.relative(dir, file).replace(/\\/g, "/");
    const list = byHash.get(hash) || [];
    list.push(rel);
    byHash.set(hash, list);
  }
  const duplicates = [...byHash.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([sha1, names]) => ({ sha1, count: names.length, files: names }));
  return { ok: true, scanned: files.length, duplicateGroups: duplicates.length, duplicates };
}

module.exports = { run };
