// FRIDAY · tools/automation/json-pretty
//
// JSON.parse / JSON.stringify. No second parser.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run({ text } = {}) {
  if (text == null || text === "") return { ok: false, error: "JSON text is required." };
  try {
    const value = JSON.parse(String(text));
    return { ok: true, text: JSON.stringify(value, null, 2) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

module.exports = { run };
