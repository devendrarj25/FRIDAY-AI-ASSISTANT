const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
async function run() {
  try {
    const netStatus = require(path.join(ELECTRON, "net-status.cjs"));
    return { ok: true, ...netStatus.snapshot() };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
