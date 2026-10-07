// FRIDAY · skill: mkt-support-resistance
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
  const prices = [...new Set(numbers(input, "prices"))].sort((a, b) => a - b);
  if (prices.length < 2) return { ok: false, error: "Paste at least two prices." };
  const bands = [];
  let cluster = [prices[0]];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = cluster[cluster.length - 1];
    if (Math.abs(prices[i] - prev) / prev <= 0.005) cluster.push(prices[i]);
    else {
      bands.push({ min: cluster[0], max: cluster[cluster.length - 1], count: cluster.length });
      cluster = [prices[i]];
    }
  }
  bands.push({ min: cluster[0], max: cluster[cluster.length - 1], count: cluster.length });
  return { ok: true, scope: SCOPE, prices, bands };
}

export default run;
