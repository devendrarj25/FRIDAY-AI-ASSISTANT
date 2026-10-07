// FRIDAY · skill: con-excavation-volume
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
  const length = num(input, "length");
  const width = num(input, "width");
  const depth = num(input, "depth");
  const bulkingPct = num(input, "bulkingPct", 20);
  if ([length, width, depth].some((v) => v <= 0))
    return { ok: false, error: "Need length, width and depth greater than zero." };
  const bank = length * width * depth;
  return {
    ok: true,
    disclaimer: DISCLAIMER,
    bank,
    bulkingPct,
    hauled: bank * (1 + bulkingPct / 100),
  };
}

export default run;
