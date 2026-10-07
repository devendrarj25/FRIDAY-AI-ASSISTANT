const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
async function run({ root } = {}) {
  try {
    const dir = root || contract.rootFromEnv();
    if (!dir) return { ok: false, error: "No FRIDAY folder is selected." };
    const github = require(path.join(ELECTRON, "github-sync.cjs"));
    const cfg = github.publicConfig(github.readConfig(dir));
    return { ok: true, config: cfg };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
