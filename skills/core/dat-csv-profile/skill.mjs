// FRIDAY · skill: dat-csv-profile
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Profiles pasted CSV or TSV: delimiter, columns, types, blanks, unique values, number ranges and damaged rows.

export function parseCsv(text, delimiter) {
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
  return { rows: rows.filter((r) => !(r.length === 1 && r[0] === "")), unclosedQuote: quoted };
}

function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 20).filter(Boolean);
  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = sample.map((l) => l.split(d).length - 1);
    const first = counts[0] ?? 0;
    const consistent = counts.filter((c) => c === first).length;
    const score = first > 0 ? consistent * 10 + first : 0;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
const DMY = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/;
function kindOf(value) {
  const v = value.trim();
  if (/^[+-]?\d+$/.test(v)) return "integer";
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/.test(v)) return "decimal";
  if (/^(?:true|false|yes|no|y|n)$/i.test(v)) return "boolean";
  if (ISO.test(v) || DMY.test(v)) return "date";
  return "text";
}

export async function run(input = {}) {
  const text = String(input?.csv ?? input?.text ?? input?.prompt ?? "").replace(/^\ufeff/, "");
  if (!text.trim())
    return { ok: false, error: "Paste the CSV or TSV text, with the header line first." };
  const delimiter = input?.delimiter
    ? String(input.delimiter).replace("\\t", "\t")
    : detectDelimiter(text);
  const { rows, unclosedQuote } = parseCsv(text, delimiter);
  if (rows.length < 2) return { ok: false, error: "Need a header line and at least one data row." };
  const header = rows[0].map((h, i) => (h.trim() === "" ? `column ${i + 1}` : h.trim()));
  const data = rows.slice(1);
  const width = header.length;
  const bad = [];
  data.forEach((r, i) => {
    if (r.length !== width) bad.push({ row: i + 2, fields: r.length });
  });
  const seen = new Map();
  let duplicates = 0;
  for (const r of data) {
    const key = JSON.stringify(r);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const n of seen.values()) if (n > 1) duplicates += n - 1;
  const columns = header.map((name, c) => {
    const values = data.map((r) => r[c] ?? "");
    const filled = values.filter((v) => v.trim() !== "");
    const kinds = new Map();
    for (const v of filled) kinds.set(kindOf(v), (kinds.get(kindOf(v)) ?? 0) + 1);
    const ranked = [...kinds.entries()].sort((a, b) => b[1] - a[1]);
    let type = ranked[0]?.[0] ?? "empty";
    if (kinds.size > 1)
      type = kinds.has("text")
        ? "text"
        : kinds.has("decimal") || (kinds.has("integer") && kinds.size === 2 && kinds.has("decimal"))
          ? "decimal"
          : "mixed";
    const counts = new Map();
    for (const v of filled) counts.set(v, (counts.get(v) ?? 0) + 1);
    const col = {
      name,
      type,
      filled: filled.length,
      blank: values.length - filled.length,
      unique: counts.size,
      topValues: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([value, count]) => ({ value: value.slice(0, 40), count })),
    };
    if (type === "integer" || type === "decimal") {
      const nums = filled.map((v) => Number(v.replace(/,/g, ""))).filter(Number.isFinite);
      if (nums.length) {
        const sum = nums.reduce((s, n) => s + n, 0);
        col.min = Math.min(...nums);
        col.max = Math.max(...nums);
        col.mean = Math.round((sum / nums.length) * 1000) / 1000;
      }
    }
    const padded = filled.filter((v) => v !== v.trim()).length;
    if (padded) col.paddedWithSpaces = padded;
    if (kinds.size > 1) col.mixedKinds = ranked.map(([k, n]) => `${k}: ${n}`);
    return col;
  });
  const issues = [];
  if (bad.length)
    issues.push(
      `${bad.length} row(s) have a different number of fields than the header (${width}).`,
    );
  if (unclosedQuote) issues.push("A quoted field is never closed.");
  if (duplicates) issues.push(`${duplicates} duplicate row(s).`);
  const empties = columns.filter((c) => c.type === "empty").map((c) => c.name);
  if (empties.length) issues.push(`Empty column(s): ${empties.join(", ")}.`);
  const mixed = columns.filter((c) => c.mixedKinds).map((c) => c.name);
  if (mixed.length) issues.push(`Mixed value kinds in: ${mixed.join(", ")}.`);
  const dupHeader = header.filter((h, i) => header.indexOf(h) !== i);
  if (dupHeader.length)
    issues.push(`Repeated header name(s): ${[...new Set(dupHeader)].join(", ")}.`);
  return {
    ok: true,
    delimiter: delimiter === "\t" ? "tab" : delimiter,
    rows: data.length,
    columnCount: width,
    columns,
    damagedRows: bad.slice(0, 10),
    duplicateRows: duplicates,
    issues,
    answer: `${data.length} row(s) x ${width} column(s), delimiter ${delimiter === "\t" ? "tab" : `"${delimiter}"`}. ${issues.length ? issues.join(" ") : "No problems found."}`,
  };
}

export default run;
