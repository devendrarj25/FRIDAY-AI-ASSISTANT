// FRIDAY · tools/system/lan-addresses
//
// Delegates to electron/system-monitor.cjs lanAddresses().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const monitor = require(path.join(ELECTRON, "system-monitor.cjs"));
  const addresses = monitor.lanAddresses();
  return { ok: true, addresses };
}

module.exports = { run };
