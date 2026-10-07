// FRIDAY · skill: con-brick-count
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
  const wallArea = num(input, "wallArea");
  const unitLength = num(input, "unitLength", 0.19);
  const unitHeight = num(input, "unitHeight", 0.09);
  const mortarGap = num(input, "mortarGap", 0.01);
  const wastePct = num(input, "wastePct", 5);
  const face = (unitLength + mortarGap) * (unitHeight + mortarGap);
  if (wallArea <= 0 || face <= 0)
    return { ok: false, error: "Need a positive wall area and unit size." };
  const count = Math.ceil((wallArea / face) * (1 + wastePct / 100));
  return { ok: true, disclaimer: DISCLAIMER, wallArea, face, wastePct, count };
}

export default run;
