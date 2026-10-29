// FRIDAY · skill: rsn-tradeoff-table
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
  const options = rows(input);
  const criteria = String(input.criteria || "cost,time,risk,quality")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!options.length) return { ok: false, error: "Paste one option per line." };
  const table = options.map((option) => ({
    option,
    scores: Object.fromEntries(
      criteria.map((c) => [c, option.toLowerCase().includes(c.toLowerCase()) ? "mentioned" : null]),
    ),
  }));
  return { ok: true, criteria, table };
}

export default run;
