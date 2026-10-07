// FRIDAY · tools/applications/which-app
//
// Delegates to electron/toolchain.cjs which(). Does not spawn the app.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ app } = {}) {
  if (!app) return { ok: false, error: "An application name is required." };
  const toolchain = require(path.join(ELECTRON, "toolchain.cjs"));
  const resolved = await toolchain.which(String(app));
  return { ok: Boolean(resolved), app: String(app), path: resolved };
}

module.exports = { run };
