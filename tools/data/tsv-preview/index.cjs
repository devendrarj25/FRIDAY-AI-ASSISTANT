const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const documents = require(path.join(ELECTRON, "document-extract.cjs"));
async function run({ text, limit = 20 } = {}) {
  if (text == null || text === "") return { ok: false, error: "TSV text is required." };
  const rows = documents.parseCsv(String(text));
  return { ok: true, count: rows.length, rows: rows.slice(0, Number(limit) || 20) };
}
module.exports = { run };
