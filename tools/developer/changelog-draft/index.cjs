// FRIDAY · tools/developer/changelog-draft
//
// git log formatted as markdown bullets. Does not write changelog files.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const fs = require("node:fs");
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
const sandbox = require(path.join(ELECTRON, "sandbox.cjs"));

function repo(input = {}) {
  return input.root || contract.rootFromEnv() || contract.CHECKOUT_ROOT;
}

async function git(root, args, timeoutMs = 45000) {
  return sandbox.runCommand("git", args, root, timeoutMs);
}

async function run({ root, limit = 20 } = {}) {
  const dir = repo({ root });
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  const result = await git(dir, ["log", "-n", String(n), "--pretty=format:%s"]);
  const lines = String(result.output || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const draft = lines.map((line) => "- " + line).join("\n");
  return {
    ok: Boolean(lines.length),
    cwd: dir,
    draft,
    note: "Draft only. FRIDAY will not write CHANGELOG.md or releases/notes from this tool.",
  };
}

module.exports = { run };
