const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const hardware = require(path.join(ELECTRON, "hardware.cjs"));
  const value = await hardware.detectSecurity();
  return { ok: true, security: value };
}
module.exports = { run };
