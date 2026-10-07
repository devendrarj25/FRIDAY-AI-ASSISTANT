// FRIDAY · skill: con-rebar-takeoff
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
  const bars = num(input, "bars");
  const lengthEach = num(input, "lengthEach");
  const lapPct = num(input, "lapPct", 0);
  if (bars <= 0 || lengthEach <= 0)
    return { ok: false, error: "Need bars and lengthEach greater than zero." };
  const total = bars * lengthEach * (1 + lapPct / 100);
  return { ok: true, disclaimer: DISCLAIMER, bars, lengthEach, lapPct, totalLength: total };
}

export default run;
