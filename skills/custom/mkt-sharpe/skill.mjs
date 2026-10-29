// FRIDAY · skill: mkt-sharpe
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
  const rf = num(input, "rf", 0);
  const returns = numbers(input, "returns");
  if (returns.length < 2) return { ok: false, error: "Paste at least two returns." };
  const excess = returns.map((r) => r - rf);
  const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const variance = excess.reduce((a, b) => a + (b - mean) ** 2, 0) / (excess.length - 1);
  const stdev = Math.sqrt(variance);
  return {
    ok: true,
    scope: SCOPE,
    rf,
    n: returns.length,
    meanExcess: mean,
    stdev,
    sharpe: stdev === 0 ? null : mean / stdev,
  };
}

export default run;
