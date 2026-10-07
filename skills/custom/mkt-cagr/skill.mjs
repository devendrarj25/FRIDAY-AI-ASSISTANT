// FRIDAY · skill: mkt-cagr
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
  const startValue = num(input, "startValue");
  const endValue = num(input, "endValue");
  const years = num(input, "years");
  if (startValue <= 0 || years <= 0)
    return { ok: false, error: "Need startValue and years greater than zero." };
  const cagr = Math.pow(endValue / startValue, 1 / years) - 1;
  return { ok: true, scope: SCOPE, startValue, endValue, years, cagr, cagrPct: cagr * 100 };
}

export default run;
