// FRIDAY · tools/system/security-posture
//
// Delegates to electron/hardware.cjs detectSecurity().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const hardware = require(path.join(ELECTRON, "hardware.cjs"));
  const snapshot = await hardware.detectSecurity();
  return { ok: true, ...snapshot };
}

module.exports = { run };
