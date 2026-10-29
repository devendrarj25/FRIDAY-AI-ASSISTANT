// FRIDAY · tools/automation/clipboard-write
//
// require('electron').clipboard.writeText() — honest fail without Electron.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  try {
    const { clipboard } = require("electron");
    clipboard.writeText(String(text));
    return { ok: true, chars: String(text).length };
  } catch (error) {
    return {
      ok: false,
      error: "Clipboard is only available in the FRIDAY desktop app.",
      detail: String(error.message || error),
    };
  }
}

module.exports = { run };
