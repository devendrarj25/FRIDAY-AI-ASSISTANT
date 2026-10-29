// FRIDAY · tools/developer/dep-audit
//
// npm audit --json via sandbox.runCommand. Never runs audit fix.
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
  if (probe) {
    const hasLock =
      fs.existsSync(path.join(dir, "package-lock.json")) ||
      fs.existsSync(path.join(dir, "package.json"));
    return { ok: true, probe: true, cwd: dir, hasLock };
  }
  const result = await sandbox.runCommand("npm", ["audit", "--json"], dir, 120000);
  let report = null;
  try {
    report = JSON.parse(String(result.output || "").replace(/^[^{]+/, "") || "{}");
  } catch {
    report = null;
  }
  return {
    ok: true,
    cwd: dir,
    audited: Boolean(report),
    vulnerabilities: report?.metadata?.vulnerabilities || report?.error || null,
    output: report ? null : String(result.output || "").slice(-4000),
  };
}

module.exports = { run };
