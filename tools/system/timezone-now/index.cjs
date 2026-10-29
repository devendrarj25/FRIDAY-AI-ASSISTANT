// FRIDAY · tools/system/timezone-now
//
// Intl.DateTimeFormat resolved options + ISO timestamp.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const now = new Date();
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    ok: true,
    iso: now.toISOString(),
    local: now.toString(),
    timeZone: resolved.timeZone,
    locale: resolved.locale,
    epochMs: now.getTime(),
  };
}

module.exports = { run };
