// FRIDAY · skill: mkt-sma-from-series
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
const SCOPE =
  "Informational analysis, education, or calculation only. FRIDAY has no brokerage or exchange connection and cannot place, execute, or automate a real trade.";
export async function run(input = {}) {
  const period = Math.max(1, Math.round(num(input, "period", 20)));
  const series = numbers(input, "closes");
  if (!series.length) return { ok: false, error: "Paste a list of numbers." };
  const window = series.slice(-period);
  const sma = window.reduce((a, b) => a + b, 0) / window.length;
  return { ok: true, scope: SCOPE, period, window, sma };
}

export default run;
