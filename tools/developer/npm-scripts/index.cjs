// FRIDAY · tools/developer/npm-scripts
//
// Read package.json scripts. Does not execute them.
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
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return { ok: true, cwd: dir, name: pkg.name || null, scripts: pkg.scripts || {} };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

module.exports = { run };
