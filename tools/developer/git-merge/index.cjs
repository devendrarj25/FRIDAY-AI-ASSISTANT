// FRIDAY · tools/developer/git-merge
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
const sandbox = require(path.join(ELECTRON, "sandbox.cjs"));

function repo(input = {}) {
  return input.root || contract.rootFromEnv() || contract.CHECKOUT_ROOT;
}

async function run(input = {}) {
  const dir = repo(input);
  if (input.probe) return { ok: true, probe: true, cwd: dir, would: "merge" };
  const branch = String(input.branch || input.prompt || "").trim();
  if (!branch) return { ok: false, error: "A branch name is required." };
  const result = await sandbox.runCommand("git", ["merge", "--no-edit", branch], dir, 60000);
  const output = String(result.output || "").slice(0, 8000);
  const ok = Boolean(result.ok) || result.code === 0;
  return { ok, cwd: dir, branch, output, ...(ok ? {} : { error: output || "git merge failed" }) };
}

module.exports = { run };
