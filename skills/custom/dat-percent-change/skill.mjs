// FRIDAY · skill: dat-percent-change
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
  const vals = numbers(input);
  if (vals.length < 2) return { ok: false, error: "Need at least two numbers." };
  const changes = vals.slice(1).map((v, i) => ({
    from: vals[i],
    to: v,
    pct: vals[i] === 0 ? null : ((v - vals[i]) / Math.abs(vals[i])) * 100,
  }));
  return { ok: true, count: changes.length, changes };
}

export default run;
