// FRIDAY · skill: mkt-max-drawdown
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
  const series = numbers(input, "equity");
  if (series.length < 2) return { ok: false, error: "Paste at least two equity points." };
  let peak = series[0];
  let maxDd = 0;
  let trough = series[0];
  for (const value of series) {
    if (value > peak) peak = value;
    const dd = peak === 0 ? 0 : (value - peak) / peak;
    if (dd < maxDd) {
      maxDd = dd;
      trough = value;
    }
  }
  return {
    ok: true,
    scope: SCOPE,
    points: series.length,
    peak,
    trough,
    maxDrawdownPct: maxDd * 100,
  };
}

export default run;
