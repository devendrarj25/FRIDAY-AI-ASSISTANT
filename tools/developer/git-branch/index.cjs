// FRIDAY · tools/developer/git-branch
//
// Spawn git branch via sandbox.runCommand. Read-only.
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

async function run({ root } = {}) {
  const dir = repo({ root });
  const result = await git(dir, ["branch", "--list", "--format=%(refname:short)%09%(HEAD)"]);
  const branches = String(result.output || "")
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, head] = line.split("\t");
      return { name, current: head === "*" };
    });
  const current = branches.find((b) => b.current)?.name || null;
  return { ok: Boolean(result.ok) || branches.length > 0, cwd: dir, current, branches };
}

module.exports = { run };
