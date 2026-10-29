// FRIDAY · skill: hom-unit-kitchen
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? input?.notes ?? "");
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
export async function run(input = {}) {
  const value = num(input, "value");
  const from = String(input.from || "cup").toLowerCase();
  const to = String(input.to || "ml").toLowerCase();
  const ml = {
    ml: 1,
    millilitre: 1,
    milliliter: 1,
    tsp: 5,
    tbsp: 15,
    cup: 240,
    l: 1000,
    litre: 1000,
    oz: 29.57,
    pint: 473,
  };
  if (!(value >= 0) || ml[from] == null || ml[to] == null)
    return { ok: false, error: "Use value plus from/to among tsp, tbsp, cup, ml, l, oz, pint." };
  const result = (value * ml[from]) / ml[to];
  return { ok: true, value, from, to, result, gramsWater: value * ml[from] };
}

export default run;
