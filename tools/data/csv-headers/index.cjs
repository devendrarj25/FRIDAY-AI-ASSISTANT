const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");
const documents = require(path.join(ELECTRON, "document-extract.cjs"));
async function run({ text } = {}) {
  if (text == null || text === "") return { ok: false, error: "CSV text is required." };
  const first = String(text)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .find((line) => line.trim());
  if (!first) return { ok: false, error: "No header row." };
  const delimiter = first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
  const headers = first.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = documents.parseCsv(String(text));
  return { ok: true, headers, columns: headers.length, rows: rows.length };
}
module.exports = { run };
