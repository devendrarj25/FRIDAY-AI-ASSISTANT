// FRIDAY · tools/developer/env-versions
//
// Delegates to electron/toolchain.cjs which() + run().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const toolchain = require(path.join(ELECTRON, "toolchain.cjs"));
  const checks = [
    { id: "Node.js LTS", cmd: "node", args: ["-v"] },
    { id: "npm", cmd: process.platform === "win32" ? "npm.cmd" : "npm", args: ["-v"] },
    { id: "Git", cmd: "git", args: ["--version"] },
    { id: "Python", cmd: process.platform === "win32" ? "python" : "python3", args: ["--version"] },
  ];
  const tools = [];
  for (const check of checks) {
    const spec = toolchain.toolById(check.id);
    const bin = await toolchain.which(check.cmd);
    const version = bin ? await toolchain.run(bin, check.args, 4000) : null;
    tools.push({
      id: check.id,
      cmd: spec?.cmd || check.cmd,
      path: bin,
      version: version ? String(version).split(/\n/)[0] : null,
      present: Boolean(bin),
    });
  }
  return { ok: true, tools };
}

module.exports = { run };
