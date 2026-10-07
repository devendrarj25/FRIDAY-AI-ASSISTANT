// FRIDAY · tools/developer/run-lint
//
// npm run lint via electron/sandbox.cjs runCommand.
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

async function run({ root, probe = false } = {}) {
  const dir = repo({ root });
  let scripts = {};
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts || {};
  } catch {
    return { ok: false, error: "No package.json in this folder." };
  }
  if (probe) return { ok: true, probe: true, cwd: dir, script: scripts.lint || null };
  if (!scripts.lint) return { ok: false, error: "No npm lint script in this folder." };
  const result = await sandbox.runCommand("npm", ["run", "lint"], dir, 6 * 60 * 1000);
  return {
    ok: Boolean(result.ok),
    cwd: dir,
    code: result.code,
    output: String(result.output || "").slice(-8000),
  };
}

module.exports = { run };
