// FRIDAY · skill: mkt-bollinger-explainer
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
  const period = Math.max(2, Math.round(num(input, "period", 20)));
  const k = num(input, "k", 2);
  const series = numbers(input, "closes");
  const explain = {
    formula: "Middle = SMA(N); upper/lower = SMA ± k * sample stdev.",
    scope: SCOPE,
    period,
    k,
  };
  if (series.length < period) return { ok: true, ...explain, note: "Paste at least N closes." };
  const window = series.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / (window.length - 1);
  const stdev = Math.sqrt(variance);
  return {
    ok: true,
    ...explain,
    middle: mean,
    stdev,
    upper: mean + k * stdev,
    lower: mean - k * stdev,
  };
}

export default run;
