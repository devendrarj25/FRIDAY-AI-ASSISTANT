// FRIDAY · skill: mkt-pe-ratio
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
  const eps = num(input, "eps");
  const growthPct = num(input, "growthPct", NaN);
  if (eps === 0) return { ok: false, error: "EPS cannot be zero." };
  const pe = price / eps;
  const peg = Number.isFinite(growthPct) && growthPct !== 0 ? pe / growthPct : null;
  return {
    ok: true,
    scope: SCOPE,
    price,
    eps,
    growthPct: Number.isFinite(growthPct) ? growthPct : null,
    pe,
    peg,
  };
}

export default run;
