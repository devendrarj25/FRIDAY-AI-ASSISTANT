// FRIDAY · skill: code-sql-review
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? "");
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
  const sql = String(input.sql || input.text || "");
  if (!sql.trim()) return { ok: false, error: "Paste SQL." };
  const findings = [];
  if (/select\s+\*/i.test(sql))
    findings.push({ id: "select-star", message: "SELECT * — name the columns." });
  if (/\b(update|delete)\b/i.test(sql) && !/\bwhere\b/i.test(sql))
    findings.push({ id: "unbounded-write", message: "UPDATE/DELETE without WHERE." });
  if (/['"].*\+|\|\|/.test(sql))
    findings.push({
      id: "concat-filter",
      message: "String-concatenated filter — use bound parameters.",
    });
  if (/drop\s+table/i.test(sql))
    findings.push({ id: "drop-table", message: "DROP TABLE in this paste — confirm intent." });
  return { ok: true, findings, okToProceed: findings.every((f) => f.id !== "unbounded-write") };
}

export default run;
