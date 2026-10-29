// FRIDAY · tools/automation/text-hash
//
// node:crypto SHA-256 of a string.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const crypto = require("node:crypto");

async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const sha256 = crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
  return { ok: true, sha256, bytes: Buffer.byteLength(String(text)) };
}

module.exports = { run };
