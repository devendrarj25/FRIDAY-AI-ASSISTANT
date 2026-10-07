// FRIDAY · tools/system/clipboard-history
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
const history = require(path.join(ELECTRON, "clipboard-history.cjs"));
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));

async function run(input = {}) {
  const root = input.root || contract.rootFromEnv();
  return history.run({ ...input, root });
}

module.exports = { run };
