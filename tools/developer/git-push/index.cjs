// FRIDAY · tools/developer/git-push
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
const sandbox = require(path.join(ELECTRON, "sandbox.cjs"));

function repo(input = {}) {
  return input.root || contract.rootFromEnv() || contract.CHECKOUT_ROOT;
}

async function run(input = {}) {
  const dir = repo(input);
  if (input.probe) return { ok: true, probe: true, cwd: dir, would: "push" };
  const remote = String(input.remote || "origin").trim();
  const branch = String(input.branch || "").trim();
  const args = branch ? ["push", remote, branch] : ["push", remote];
  const result = await sandbox.runCommand("git", args, dir, 60000);
  const output = String(result.output || "").slice(0, 8000);
  const ok = Boolean(result.ok) || result.code === 0;
  return {
    ok,
    cwd: dir,
    remote,
    branch: branch || null,
    output,
    ...(ok ? {} : { error: output || "git push failed" }),
  };
}

module.exports = { run };
