// FRIDAY · skill: mkt-break-even
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
  const entry = num(input, "entry");
  const fees = num(input, "fees");
  const shares = num(input, "shares", 1);
  const side = String(input.side || "long").toLowerCase();
  if (shares <= 0) return { ok: false, error: "Need shares greater than zero." };
  const perShare = fees / shares;
  const breakEven = side.startsWith("short") ? entry - perShare : entry + perShare;
  return { ok: true, scope: SCOPE, entry, fees, shares, side, perShare, breakEven };
}

export default run;
