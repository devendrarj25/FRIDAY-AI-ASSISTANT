// FRIDAY · skill: mkt-macd-explainer
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
function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i += 1) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
export async function run(input = {}) {
  const closes = numbers(input, "closes");
  const explain = {
    formula: "MACD = EMA12(close) - EMA26(close); signal = EMA9(MACD); histogram = MACD - signal.",
    scope: SCOPE,
  };
  if (closes.length < 26)
    return { ok: true, ...explain, macd: null, note: "Paste 26+ closes to compute a value." };
  const macdLine = ema(closes, 12).map((v, i) => v - ema(closes, 26)[i]);
  const signal = ema(macdLine, 9);
  const last = macdLine.length - 1;
  return {
    ok: true,
    ...explain,
    macd: macdLine[last],
    signal: signal[last],
    histogram: macdLine[last] - signal[last],
  };
}

export default run;
