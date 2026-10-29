// FRIDAY · tools/automation/clipboard-read
//
// require('electron').clipboard.readText() — honest fail without Electron.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  try {
    const { clipboard } = require("electron");
    const text = String(clipboard.readText() || "");
    return { ok: true, text: text.slice(0, 20000), chars: text.length };
  } catch (error) {
    return {
      ok: false,
      error: "Clipboard is only available in the FRIDAY desktop app.",
      detail: String(error.message || error),
    };
  }
}

module.exports = { run };
