// FRIDAY · skill: hom-water-use
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
  const showers = num(input, "showers");
  const laundry = num(input, "laundry");
  const dishes = num(input, "dishes");
  const litres = showers * 60 + laundry * 70 + dishes * 20;
  return {
    ok: true,
    litres,
    breakdown: { showers: showers * 60, laundry: laundry * 70, dishes: dishes * 20 },
    note: "Round educational figures, not a meter reading.",
  };
}

export default run;
