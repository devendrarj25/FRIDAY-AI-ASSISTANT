// FRIDAY · skill: con-span-aid
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
  const span = num(input, "span");
  const depth = num(input, "depth");
  const material = String(input.material || "timber").toLowerCase();
  if (span <= 0 || depth <= 0)
    return { ok: false, error: "Need span and depth greater than zero, same units." };
  const ratio = span / depth;
  const thumb = material.includes("steel")
    ? { min: 15, max: 24, note: "Very rough steel beam span/depth chatter, not a code check." }
    : { min: 12, max: 20, note: "Very rough timber joist span/depth chatter, not a code check." };
  const inside = ratio >= thumb.min && ratio <= thumb.max;
  return {
    ok: true,
    disclaimer: DISCLAIMER,
    span,
    depth,
    material,
    ratio,
    ruleOfThumb: thumb,
    insideRuleOfThumb: inside,
  };
}

export default run;
