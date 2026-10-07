// FRIDAY · skill: con-drywall-sheets
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
  const sheetArea = num(input, "sheetArea", 2.88);
  const wastePct = num(input, "wastePct", 15);
  if (area <= 0 || sheetArea <= 0) return { ok: false, error: "Need area greater than zero." };
  const sheets = Math.ceil((area / sheetArea) * (1 + wastePct / 100));
  return { ok: true, disclaimer: DISCLAIMER, area, sheetArea, wastePct, sheets };
}

export default run;
