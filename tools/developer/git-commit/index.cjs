// FRIDAY · tools/developer/git-commit
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
const sandbox = require(path.join(ELECTRON, "sandbox.cjs"));

function repo(input = {}) {
  return input.root || contract.rootFromEnv() || contract.CHECKOUT_ROOT;
}

async function git(root, args, timeoutMs = 45000) {
  return sandbox.runCommand("git", args, root, timeoutMs);
}

async function run(input = {}) {
  const dir = repo(input);
  if (input.probe) return { ok: true, probe: true, cwd: dir, would: "commit" };
  const message = String(input.message || "").trim();
  if (!message) return { ok: false, error: "A commit message is required." };
  const paths = Array.isArray(input.paths) ? input.paths.map(String) : [];
  if (paths.length) {
    const add = await git(dir, ["add", "--", ...paths]);
    if (!(add.ok || add.code === 0)) {
      return { ok: false, error: add.output || "git add failed", cwd: dir };
    }
  }
  const result = await git(dir, ["commit", "-m", message]);
  const output = String(result.output || "").slice(0, 8000);
  const ok = Boolean(result.ok) || result.code === 0;
  return { ok, cwd: dir, output, ...(ok ? {} : { error: output || "git commit failed" }) };
}

module.exports = { run };
