// FRIDAY · skill: dat-outlier-z
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
  const threshold = Math.max(1, num(input, "threshold", 2));
  if (vals.length < 3) return { ok: false, error: "Need at least three numbers." };
  const mean = vals.reduce((n, v) => n + v, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((n, v) => n + (v - mean) ** 2, 0) / vals.length) || 1;
  const flags = vals
    .map((v, i) => ({ i, v, z: (v - mean) / sd }))
    .filter((r) => Math.abs(r.z) >= threshold);
  return { ok: true, mean, sd, threshold, flags };
}

export default run;
