// FRIDAY · skill: con-unit-convert
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
const TO_M = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048, yd: 0.9144 };
const TO_M2 = { m2: 1, "m²": 1, ft2: 0.092903, "ft²": 0.092903 };
const TO_M3 = { m3: 1, "m³": 1, ft3: 0.0283168, yd3: 0.764555, "yd³": 0.764555 };
export async function run(input = {}) {
  const value = num(input, "value");
  const from = String(input.from || "m").toLowerCase();
  const to = String(input.to || "ft").toLowerCase();
  const table =
    from in TO_M && to in TO_M
      ? TO_M
      : from in TO_M2 && to in TO_M2
        ? TO_M2
        : from in TO_M3 && to in TO_M3
          ? TO_M3
          : null;
  if (!table)
    return {
      ok: false,
      error: `Cannot convert ${from} → ${to}. Use mm/cm/m/in/ft/yd or m2/ft2 or m3/ft3/yd3.`,
    };
  const result = (value * table[from]) / table[to];
  return { ok: true, disclaimer: DISCLAIMER, value, from, to, result };
}

export default run;
