// FRIDAY · skill: con-paint-coverage
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
  const coats = num(input, "coats", 2);
  const coveragePerLitre = num(input, "coveragePerLitre", 10);
  const wastePct = num(input, "wastePct", 10);
  if (area <= 0 || coveragePerLitre <= 0)
    return { ok: false, error: "Need area and coveragePerLitre greater than zero." };
  const litres = ((area * coats) / coveragePerLitre) * (1 + wastePct / 100);
  return { ok: true, disclaimer: DISCLAIMER, area, coats, coveragePerLitre, wastePct, litres };
}

export default run;
