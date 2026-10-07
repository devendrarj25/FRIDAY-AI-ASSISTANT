// FRIDAY · tools/developer/git-show
//
// Spawn git show via sandbox.runCommand. Read-only.
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

async function run({ root, rev = "HEAD" } = {}) {
  const dir = repo({ root });
  const result = await git(dir, ["show", "--stat", "--format=fuller", String(rev)]);
  return {
    ok: Boolean(result.ok),
    cwd: dir,
    rev: String(rev),
    output: String(result.output || "").slice(0, 20000),
    ...(result.ok ? {} : { error: result.output }),
  };
}

module.exports = { run };
