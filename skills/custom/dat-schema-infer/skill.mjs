// FRIDAY · skill: dat-schema-infer
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
  if (lines.length < 2) return { ok: false, error: "Paste a header plus sample rows." };
  const split = (line) => line.split(line.includes("\t") ? "\t" : ",");
  const header = split(lines[0]).map((h) => h.trim() || "col");
  const sample = lines.slice(1, 30).map(split);
  const guess = (values) => {
    const filled = values.map((v) => String(v || "").trim()).filter(Boolean);
    if (!filled.length) return "empty";
    if (filled.every((v) => Number.isFinite(Number(v)))) return "number";
    if (filled.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}[\/.-]\d{1,2}/.test(v)))
      return "date-like";
    return "text";
  };
  const columns = header.map((name, i) => ({ name, type: guess(sample.map((r) => r[i])) }));
  return { ok: true, columns, sampled: sample.length };
}

export default run;
