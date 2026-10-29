const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const hardware = require(path.join(ELECTRON, "hardware.cjs"));
  const value = await hardware.detectHardware();
  return { ok: true, hardware: value };
}
module.exports = { run };
