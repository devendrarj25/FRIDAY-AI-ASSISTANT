// FRIDAY · skill: con-roofing-squares
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
  const area = num(input, "area");
  const pitchFactor = num(input, "pitchFactor", 1);
  const wastePct = num(input, "wastePct", 10);
  if (area <= 0) return { ok: false, error: "Need a plan area greater than zero." };
  const expanded = area * pitchFactor * (1 + wastePct / 100);
  return {
    ok: true,
    disclaimer: DISCLAIMER,
    area,
    pitchFactor,
    wastePct,
    expandedArea: expanded,
    squaresIfSquareFeet: expanded / 100,
  };
}

export default run;
