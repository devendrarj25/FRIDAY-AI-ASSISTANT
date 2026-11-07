// FRIDAY · skill: dat-table-convert
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Converts a table between CSV (or TSV), a Markdown table and JSON (a list of objects).

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const csvCell = (v, d) => {
  const s =
    v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.includes('"') || s.includes("\n") || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s;
};

function fromMarkdown(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  const cells = (l) =>
    l
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"));
  const rows = lines.map(cells).filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
  return rows;
}

function detect(text) {
  const t = text.trim();
  if (/^[[{]/.test(t)) return "json";
  if (t.split(/\r?\n/).filter((l) => l.trim().startsWith("|")).length >= 2) return "markdown";
  return t.includes("\t") ? "tsv" : "csv";
}

export async function run(input = {}) {
  const text = String(input?.table ?? input?.text ?? input?.prompt ?? "");
  const from = String(input?.from ?? "").toLowerCase() || detect(text);
  const to =
    String(input?.to ?? "").toLowerCase() ||
    ((text.toLowerCase().match(/\bto\s+(csv|tsv|json|markdown|md)\b/) ?? [])[1] ?? "");
  const target = to === "md" ? "markdown" : to;
  if (!text.trim())
    return {
      ok: false,
      error: "Paste the table (CSV, Markdown or JSON) and say what to convert it to.",
    };
  if (!["csv", "tsv", "json", "markdown"].includes(target))
    return { ok: false, error: "Say the target format: csv, tsv, markdown or json." };
  let header;
  let body;
  try {
    if (from === "json") {
      const value = JSON.parse(text.replace(/^[^[{]*(?=[[{])/, ""));
      const list = Array.isArray(value) ? value : [value];
      if (!list.every((x) => x && typeof x === "object" && !Array.isArray(x)))
        return {
          ok: false,
          error: 'JSON must be a list of objects, for example [{"a":1},{"a":2}].',
        };
      header = [...new Set(list.flatMap((o) => Object.keys(o)))];
      body = list.map((o) => header.map((h) => o[h] ?? ""));
    } else {
      const rows =
        from === "markdown"
          ? fromMarkdown(text)
          : parseCsv(
              text
                .replace(/^\ufeff/, "")
                .replace(/^[^\n]*\bto\s+(?:csv|tsv|json|markdown|md)\b[^\n]*\n/i, ""),
              from === "tsv"
                ? "\t"
                : text.split(/\r?\n/)[0].split(";").length >
                    text.split(/\r?\n/)[0].split(",").length
                  ? ";"
                  : ",",
            );
      if (rows.length < 1) return { ok: false, error: "No table found in the text." };
      header = rows[0];
      body = rows.slice(1);
    }
  } catch (error) {
    return { ok: false, error: `Could not read the ${from} table: ${error.message}` };
  }
  const numeric = (v) =>
    typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim()) && !/^0\d/.test(v.trim())
      ? Number(v)
      : v;
  let result;
  if (target === "json")
    result = JSON.stringify(
      body.map((r) => Object.fromEntries(header.map((h, i) => [h, numeric(r[i] ?? "")]))),
      null,
      2,
    );
  else if (target === "markdown") {
    const esc = (v) =>
      String(v ?? "")
        .replace(/\|/g, "\\|")
        .replace(/\r?\n/g, " ");
    const widths = header.map((h, i) =>
      Math.max(3, esc(h).length, ...body.map((r) => esc(r[i]).length)),
    );
    const line = (r) => `| ${widths.map((w, i) => esc(r[i]).padEnd(w)).join(" | ")} |`;
    result = [
      line(header),
      `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
      ...body.map(line),
    ].join("\n");
  } else {
    const d = target === "tsv" ? "\t" : ",";
    result = [header, ...body].map((r) => r.map((c) => csvCell(c, d)).join(d)).join("\n");
  }
  return {
    ok: true,
    from,
    to: target,
    rows: body.length,
    columns: header.length,
    result,
    answer: `Converted ${body.length} row(s) x ${header.length} column(s) from ${from} to ${target}.`,
  };
}

export default run;
