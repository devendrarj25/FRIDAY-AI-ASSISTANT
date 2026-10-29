// FRIDAY · skill: con-waste-factor
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
const DISCLAIMER =
  "This is a planning aid, not a substitute for a licensed engineer's calculations or sign-off, and it is not professional certification.";
export async function run(input = {}) {
  const netQty = num(input, "netQty");
  const wastePct = num(input, "wastePct", 10);
  if (netQty < 0) return { ok: false, error: "netQty cannot be negative." };
  const gross = netQty * (1 + wastePct / 100);
  return { ok: true, disclaimer: DISCLAIMER, label: input.label || null, netQty, wastePct, gross };
}

export default run;
