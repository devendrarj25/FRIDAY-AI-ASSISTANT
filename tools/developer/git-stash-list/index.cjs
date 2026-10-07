// FRIDAY · tools/developer/git-stash-list
//
// Spawn git stash list via sandbox.runCommand. Read-only.
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
  const result = await git(dir, ["stash", "list"]);
  const stashes = String(result.output || "")
    .split(/\n/)
    .filter(Boolean);
  return { ok: true, cwd: dir, count: stashes.length, stashes };
}

module.exports = { run };
