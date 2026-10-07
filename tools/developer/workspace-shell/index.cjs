const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ command, shell, cwd, root } = {}) {
  const terminal = require(path.join(ELECTRON, "terminal.cjs"));
  const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
  const workspace = root || contract.rootFromEnv() || contract.CHECKOUT_ROOT;
  if (!command) return { ok: false, error: "command is required" };
  return terminal.runCommand(workspace, {
    command: String(command),
    ...(shell ? { shell: String(shell) } : {}),
    ...(cwd ? { cwd: String(cwd) } : {}),
  });
}

module.exports = { run };
