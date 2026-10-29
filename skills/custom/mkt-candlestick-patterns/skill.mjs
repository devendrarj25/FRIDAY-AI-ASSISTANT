// FRIDAY · skill: mkt-candlestick-patterns
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
  const o = num(input, "open");
  const h = num(input, "high");
  const l = num(input, "low");
  const c = num(input, "close");
  const range = h - l;
  if (range <= 0) return { ok: false, error: "High must exceed low." };
  const body = Math.abs(c - o);
  const upper = h - Math.max(o, c);
  const lower = Math.min(o, c) - l;
  let pattern = "ordinary bar";
  if (body / range < 0.1) pattern = "doji";
  else if (body / range > 0.9) pattern = "marubozu";
  else if (lower > 2 * body && upper < body)
    pattern = c >= o ? "hammer (bullish textbook shape)" : "hanging man shape";
  else if (upper > 2 * body && lower < body) pattern = "shooting star / inverted hammer shape";
  return {
    ok: true,
    scope: SCOPE,
    open: o,
    high: h,
    low: l,
    close: c,
    body,
    range,
    upper,
    lower,
    pattern,
  };
}

export default run;
