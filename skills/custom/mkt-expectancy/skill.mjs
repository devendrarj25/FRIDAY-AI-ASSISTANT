// FRIDAY · skill: mkt-expectancy
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
  const winRate = num(input, "winRate");
  const avgWin = num(input, "avgWin");
  const avgLoss = Math.abs(num(input, "avgLoss"));
  const p = winRate > 1 ? winRate / 100 : winRate;
  if (p < 0 || p > 1) return { ok: false, error: "winRate should be 0–1 or 0–100." };
  const expectancy = p * avgWin - (1 - p) * avgLoss;
  return { ok: true, scope: SCOPE, winRate: p, avgWin, avgLoss, expectancy };
}

export default run;
