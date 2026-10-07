const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const documents = require(path.join(ELECTRON, "document-extract.cjs"));
async function run({ text } = {}) {
  if (text == null || text === "") return { ok: false, error: "CSV text is required." };
  const rows = documents.parseCsv(String(text));
  return { ok: true, json: JSON.stringify(rows), count: rows.length };
}
module.exports = { run };
