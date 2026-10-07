const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const hardware = require(path.join(ELECTRON, "hardware.cjs"));
  const value = await hardware.detectSensors();
  return { ok: true, sensors: value };
}
module.exports = { run };
