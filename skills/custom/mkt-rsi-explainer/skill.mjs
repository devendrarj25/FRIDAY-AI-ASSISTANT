// FRIDAY · skill: mkt-rsi-explainer
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
  const period = Math.max(2, Math.round(num(input, "period", 14)));
  const closes = numbers(input, "closes");
  const explain = {
    formula: "RSI = 100 - 100 / (1 + avgGain/avgLoss) over N closes (Wilder).",
    overboughtHint: "Textbook 70/30 bands are conventions, not signals FRIDAY will trade.",
    period,
    scope: SCOPE,
  };
  if (closes.length < period + 1)
    return {
      ok: true,
      ...explain,
      rsi: null,
      note: "Paste at least period+1 closes to compute a value.",
    };
  const changes = [];
  for (let i = 1; i < closes.length; i += 1) changes.push(closes[i] - closes[i - 1]);
  const window = changes.slice(-period);
  const avgGain = window.filter((c) => c > 0).reduce((a, c) => a + c, 0) / period;
  const avgLoss = Math.abs(window.filter((c) => c < 0).reduce((a, c) => a + c, 0)) / period;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  return { ok: true, ...explain, sampleCloses: closes.slice(-period - 1), rsi };
}

export default run;
