// FRIDAY · skill: mkt-compound-growth
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
  const principal = num(input, "principal");
  const ratePct = num(input, "ratePct");
  const years = Math.min(40, Math.max(1, Math.round(num(input, "years", 1))));
  const nPer = Math.max(1, Math.round(num(input, "compoundsPerYear", 1)));
  if (principal <= 0) return { ok: false, error: "Need a principal greater than zero." };
  const r = ratePct / 100;
  const table = [];
  for (let t = 1; t <= years; t += 1) {
    table.push({ year: t, amount: principal * Math.pow(1 + r / nPer, nPer * t) });
  }
  return {
    ok: true,
    scope: SCOPE,
    principal,
    ratePct,
    years,
    compoundsPerYear: nPer,
    table,
    final: table.at(-1)?.amount,
  };
}

export default run;
