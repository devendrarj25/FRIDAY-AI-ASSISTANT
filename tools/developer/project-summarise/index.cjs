// FRIDAY · tools/developer/project-summarise
//
// Delegates to electron/skills.cjs invoke(project.summarise).
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ root } = {}) {
  const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
  const dir = root || contract.rootFromEnv();
  if (!dir) return { ok: false, error: "No FRIDAY folder is selected." };
  const skills = require(path.join(ELECTRON, "skills.cjs"));
  return skills.invoke(dir, "project.summarise", {});
}

module.exports = { run };
