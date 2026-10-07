const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
async function run() {
  try {
    const contract = require(path.join(ELECTRON, "friday-contract.cjs"));
    return { ok: true, names: contract.NAMES };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
