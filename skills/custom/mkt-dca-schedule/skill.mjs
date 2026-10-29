// FRIDAY · skill: mkt-dca-schedule
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
  const total = num(input, "total");
  const periods = Math.max(1, Math.round(num(input, "periods", 12)));
  const price = num(input, "price", 1);
  if (total <= 0 || price <= 0)
    return { ok: false, error: "Need total and price greater than zero." };
  const slice = total / periods;
  const shares = slice / price;
  return {
    ok: true,
    scope: SCOPE,
    total,
    periods,
    price,
    slice,
    sharesPerSlice: shares,
    totalShares: shares * periods,
  };
}

export default run;
