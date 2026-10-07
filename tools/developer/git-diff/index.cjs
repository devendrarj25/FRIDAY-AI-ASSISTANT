// FRIDAY · tools/developer/git-diff
//
// Spawn git diff via sandbox.runCommand. Read-only.
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

async function run({ root, statOnly = false } = {}) {
  const dir = repo({ root });
  const args = statOnly ? ["diff", "--stat"] : ["diff"];
  const result = await git(dir, args);
  const output = String(result.output || "").slice(0, 20000);
  return {
    ok: Boolean(result.ok) || result.code === 0,
    cwd: dir,
    output,
    ...(result.ok ? {} : { error: output }),
  };
}

module.exports = { run };
