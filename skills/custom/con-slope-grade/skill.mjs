// FRIDAY · skill: con-slope-grade
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
  const rise = num(input, "rise");
  const run = num(input, "run");
  if (run === 0) return { ok: false, error: "Run cannot be zero." };
  const gradePct = (rise / run) * 100;
  const angleDeg = (Math.atan(rise / run) * 180) / Math.PI;
  return {
    ok: true,
    disclaimer: DISCLAIMER,
    rise,
    run,
    gradePct,
    ratio: `1:${(run / rise).toFixed(2)}`,
    angleDeg,
  };
}

export default run;
