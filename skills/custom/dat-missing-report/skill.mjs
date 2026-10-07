// FRIDAY · skill: dat-missing-report
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
  if (lines.length < 2) return { ok: false, error: "Paste a header row plus data rows." };
  const split = (line) => line.split(line.includes("\t") ? "\t" : ",");
  const header = split(lines[0]).map((h) => h.trim() || "col");
  const missing = header.map((h) => ({ column: h, empty: 0 }));
  for (const line of lines.slice(1)) {
    const cells = split(line);
    header.forEach((_, i) => {
      if (!String(cells[i] || "").trim()) missing[i].empty += 1;
    });
  }
  return { ok: true, rows: lines.length - 1, missing };
}

export default run;
