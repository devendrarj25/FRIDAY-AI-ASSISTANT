// FRIDAY · skill: con-stair-rise-run
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
  const totalRise = num(input, "totalRise");
  const riserTarget = num(input, "riserTarget", 175);
  const going = num(input, "going", 250);
  if (totalRise <= 0 || riserTarget <= 0)
    return { ok: false, error: "Need totalRise and riserTarget greater than zero." };
  const count = Math.max(1, Math.round(totalRise / riserTarget));
  const riser = totalRise / count;
  const twoRG = 2 * riser + going;
  return {
    ok: true,
    disclaimer: DISCLAIMER,
    totalRise,
    count,
    riser,
    going,
    twoRplusG: twoRG,
    textbookBand: twoRG >= 550 && twoRG <= 700,
  };
}

export default run;
