// FRIDAY · skill: mkt-beta-terms
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
  const returns = numbers(input, "returns");
  const glossary = {
    beta: "Sensitivity of an asset's returns to a benchmark's returns.",
    systematic: "Market-wide risk that diversification inside one market does not remove.",
    idiosyncratic: "Name-specific residual after the market factor.",
    scope: SCOPE,
  };
  if (returns.length < 2) return { ok: true, ...glossary, variance: null };
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return { ok: true, ...glossary, mean, variance, stdev: Math.sqrt(variance) };
}

export default run;
