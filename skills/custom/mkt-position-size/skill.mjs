// FRIDAY · skill: mkt-position-size
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
  const capital = num(input, "capital");
  const riskPct = num(input, "riskPct");
  const entry = num(input, "entry");
  const stop = num(input, "stop");
  if (capital <= 0 || riskPct <= 0)
    return { ok: false, error: "Need capital and riskPct greater than zero." };
  const riskAmount = capital * (riskPct / 100);
  const perUnit = Math.abs(entry - stop);
  if (perUnit === 0) return { ok: false, error: "Entry and stop cannot be the same price." };
  const size = Math.floor(riskAmount / perUnit);
  return { ok: true, scope: SCOPE, capital, riskPct, entry, stop, riskAmount, perUnit, size };
}

export default run;
