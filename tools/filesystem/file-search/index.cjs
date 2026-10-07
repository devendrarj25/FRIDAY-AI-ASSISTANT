// FRIDAY · tools/filesystem/file-search
//
// Bounded walk + string match under friday-contract.resolveInside.
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

async function run({ folder = ".", query, maxHits = 40, root } = {}) {
  const dir = workspaceRoot({ root });
  const missing = needRoot(dir);
  if (missing) return missing;
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return { ok: false, error: "A search query is required." };
  const resolved = inside(dir, folder);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.path)) return { ok: false, error: "Folder not found." };
  const files = walkFiles(resolved.path, 800);
  const hits = [];
  for (const file of files) {
    if (hits.length >= (Number(maxHits) || 40)) break;
    let text = "";
    try {
      const buf = fs.readFileSync(file);
      if (buf.includes(0) || buf.length > 1_000_000) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (hits.length >= (Number(maxHits) || 40)) return;
      if (line.toLowerCase().includes(q)) {
        hits.push({
          path: path.relative(dir, file).replace(/\\/g, "/"),
          line: i + 1,
          text: line.slice(0, 240),
        });
      }
    });
  }
  return { ok: true, query: q, scanned: files.length, hits };
}

module.exports = { run };
