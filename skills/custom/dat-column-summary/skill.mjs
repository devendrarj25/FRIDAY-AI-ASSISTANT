// FRIDAY · skill: dat-column-summary
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
  if (!vals.length) return { ok: false, error: "Paste numbers separated by commas or spaces." };
  const sorted = [...vals].sort((a, b) => a - b);
  const sum = vals.reduce((n, v) => n + v, 0);
  const mean = sum / vals.length;
  const mid = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    ok: true,
    count: vals.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    sum,
    mean,
    median,
  };
}

export default run;
