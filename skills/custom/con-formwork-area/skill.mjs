// FRIDAY · skill: con-formwork-area
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
  const height = num(input, "height");
  const openSides = Math.min(4, Math.max(0, Math.round(num(input, "openSides", 4))));
  if ([length, width, height].some((v) => v <= 0))
    return { ok: false, error: "Need length, width and height greater than zero." };
  const long = 2 * length * height;
  const short = 2 * width * height;
  const sideArea =
    openSides >= 4
      ? long + short
      : openSides === 3
        ? long + width * height
        : openSides === 2
          ? long
          : openSides === 1
            ? length * height
            : 0;
  const soffit = length * width;
  return {
    ok: true,
    disclaimer: DISCLAIMER,
    sideArea,
    soffit,
    totalContact: sideArea + soffit,
    openSides,
  };
}

export default run;
