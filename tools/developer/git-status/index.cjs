// FRIDAY · tools/developer/git-status
//
// Spawn git status via electron/sandbox.cjs runCommand. Read-only.
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
  const result = await git(dir, ["status", "--porcelain=v1", "-b"]);
  return {
    ok: Boolean(result.ok) || result.code === 0,
    cwd: dir,
    branchLine:
      String(result.output || "")
        .split(/\n/)
        .find((line) => line.startsWith("##")) || null,
    dirty: String(result.output || "")
      .split(/\n/)
      .filter((line) => line && !line.startsWith("##")),
    ...(result.ok ? {} : { error: result.output || "git status failed" }),
  };
}

module.exports = { run };
