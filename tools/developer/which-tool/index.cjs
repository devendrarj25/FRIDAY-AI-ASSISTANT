// FRIDAY · tools/developer/which-tool
//
// Delegates to electron/toolchain.cjs which().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ cmd } = {}) {
  if (!cmd) return { ok: false, error: "A command name is required." };
  const toolchain = require(path.join(ELECTRON, "toolchain.cjs"));
  const resolved = await toolchain.which(String(cmd));
  return { ok: Boolean(resolved), cmd: String(cmd), path: resolved };
}

module.exports = { run };
