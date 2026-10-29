// FRIDAY · tools/system/monitor-snapshot
//
// Delegates to electron/system-monitor.cjs snapshot().
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const monitor = require(path.join(ELECTRON, "system-monitor.cjs"));
  const sample = await monitor.snapshot();
  return { ok: true, sample };
}

module.exports = { run };
