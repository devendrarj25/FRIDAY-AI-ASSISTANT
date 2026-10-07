// FRIDAY · skill: mkt-dividend-yield
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
  const price = num(input, "price");
  const annualDividend = num(input, "annualDividend");
  const eps = num(input, "eps", NaN);
  if (price <= 0) return { ok: false, error: "Need a price greater than zero." };
  const yieldPct = (annualDividend / price) * 100;
  const payoutPct = Number.isFinite(eps) && eps !== 0 ? (annualDividend / eps) * 100 : null;
  return { ok: true, scope: SCOPE, price, annualDividend, yieldPct, payoutPct };
}

export default run;
