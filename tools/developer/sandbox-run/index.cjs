// FRIDAY · tools/developer/sandbox-run
//
// Delegates to electron/skills.cjs invoke(sandbox.run).
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ code, language = "node", allowNetwork = false, root } = {}) {
  const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
  const dir = root || contract.rootFromEnv() || contract.CHECKOUT_ROOT;
  if (!code) return { ok: false, error: "Code is required." };
  const skills = require(path.join(ELECTRON, "skills.cjs"));
  return skills.invoke(dir, "sandbox.run", { code, language, allowNetwork });
}

module.exports = { run };
