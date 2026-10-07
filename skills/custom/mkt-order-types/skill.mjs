// FRIDAY · skill: mkt-order-types
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
const TERMS = {
  market: "Fill at the next available price; no price cap.",
  limit: "Fill only at the limit or better; may not fill.",
  stop: "Becomes a market order after a stop price trades.",
  "stop-limit": "Becomes a limit order after the stop trades.",
  gtc: "Good-til-cancelled time-in-force.",
  day: "Expires at the session close.",
  ioc: "Immediate-or-cancel remainder.",
};
export async function run(input = {}) {
  const q = text(input).toLowerCase();
  const hits = Object.entries(TERMS)
    .filter(([key]) => !q || q.includes(key) || q.includes(key.replace("-", " ")))
    .map(([term, meaning]) => ({ term, meaning }));
  return {
    ok: true,
    scope: SCOPE,
    cannotPlaceOrders: true,
    matches: hits.length
      ? hits
      : Object.entries(TERMS).map(([term, meaning]) => ({ term, meaning })),
  };
}

export default run;
