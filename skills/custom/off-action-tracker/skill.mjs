// FRIDAY · skill: off-action-tracker
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
  if (!lines.length) return { ok: false, error: "Paste tasks, one per line." };
  const OWNER = /\b(?:owner|@)?([A-Z][a-z]{1,20})\b/;
  const DUE = /\b(\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?|eod|eow|today|tomorrow)\b/i;
  const rowsOut = lines.map((line) => ({
    task: line.replace(/^[-*\d.\s]+/, ""),
    owner: (line.match(OWNER) || [])[1] || "",
    due: (line.match(DUE) || [])[1] || "",
    status: /done|complete/i.test(line) ? "done" : "open",
  }));
  const md = [
    "| Task | Owner | Due | Status |",
    "| --- | --- | --- | --- |",
    ...rowsOut.map(
      (r) => "| " + r.task + " | " + r.owner + " | " + r.due + " | " + r.status + " |",
    ),
  ].join("\n");
  return { ok: true, count: rowsOut.length, rows: rowsOut, markdown: md };
}

export default run;
