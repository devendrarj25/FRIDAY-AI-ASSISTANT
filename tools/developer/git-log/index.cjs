// FRIDAY · tools/developer/git-log
//
// Spawn git log via sandbox.runCommand. Read-only.
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

async function run({ root, limit = 15 } = {}) {
  const dir = repo({ root });
  const n = Math.max(1, Math.min(50, Number(limit) || 15));
  const result = await git(dir, [
    "log",
    "-n",
    String(n),
    "--pretty=format:%h%x09%ad%x09%s",
    "--date=short",
  ]);
  const commits = String(result.output || "")
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...rest] = line.split("\t");
      return { hash, date, subject: rest.join("\t") };
    });
  return {
    ok: Boolean(result.ok) || commits.length > 0,
    cwd: dir,
    commits,
    ...(result.ok ? {} : { error: result.output }),
  };
}

module.exports = { run };
