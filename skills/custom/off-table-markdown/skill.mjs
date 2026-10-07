// FRIDAY · skill: off-table-markdown
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? input?.notes ?? "");
}
function rows(input) {
  return text(input)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function numbers(input, key) {
  const raw = input?.[key] ?? input?.text ?? "";
  return String(raw)
    .split(/[,\s]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v));
}
export async function run(input = {}) {
  const lines = rows(input);
  if (!lines.length) return { ok: false, error: "Paste CSV or TSV rows." };
  const split = (line) => line.split(line.includes("\t") ? "\t" : ",");
  const cells = lines.map(split);
  const width = Math.max(...cells.map((c) => c.length));
  const norm = cells.map((c) => Array.from({ length: width }, (_, i) => (c[i] || "").trim()));
  const header = norm[0];
  const md = [
    "| " + header.join(" | ") + " |",
    "| " + header.map(() => "---").join(" | ") + " |",
    ...norm.slice(1).map((r) => "| " + r.join(" | ") + " |"),
  ].join("\n");
  return { ok: true, rows: norm.length, columns: width, markdown: md };
}

export default run;
