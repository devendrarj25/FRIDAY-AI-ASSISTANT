// FRIDAY · skill: docs.extract
// Sandbox path: pasted text/CSV. File bytes/URLs use the built-in
// electron/skills.cjs → electron/document-extract.cjs (one parser).

function parseCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const delimiter = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ""));
    const row = {};
    header.forEach((key, i) => {
      row[key || `col${i}`] = cells[i] || "";
    });
    return row;
  });
}

export async function run(input = {}) {
  const text = String(input.text || input.prompt || input.csv || "");
  const filename = String(input.filename || input.path || "document.txt");
  if (!text) {
    return {
      ok: false,
      error:
        "Need document text here, or invoke the built-in docs.extract skill with a path/URL so electron/document-extract.cjs can read the file bytes.",
      filename,
    };
  }
  const looksCsv =
    /\.(csv|tsv)$/i.test(filename) ||
    (/,/.test(text) && /\n/.test(text) && text.split(/\n/).length > 1);
  const rows = looksCsv ? parseCsv(text) : [];
  return { ok: true, kind: rows.length ? "csv" : "text", text, rows, filename };
}

export default run;
