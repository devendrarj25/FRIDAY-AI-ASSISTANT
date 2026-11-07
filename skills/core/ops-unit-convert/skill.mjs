// FRIDAY · skill: ops-unit-convert
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Convert length, weight, volume, area, speed and temperature, e.g. "5 km to miles" or "100 f in c".

// key: [dimension, factor to the base unit, aliases without spaces]
const UNITS = {
  mm: ["length", 0.001, ["mm", "millimeter", "millimetre"]],
  cm: ["length", 0.01, ["cm", "centimeter", "centimetre"]],
  m: ["length", 1, ["m", "meter", "metre"]],
  km: ["length", 1000, ["km", "kilometer", "kilometre"]],
  in: ["length", 0.0254, ["in", "inch", "inche", "inches"]],
  ft: ["length", 0.3048, ["ft", "foot", "feet"]],
  yd: ["length", 0.9144, ["yd", "yard"]],
  mi: ["length", 1609.344, ["mi", "mile"]],
  mg: ["mass", 0.000001, ["mg", "milligram"]],
  g: ["mass", 0.001, ["g", "gram", "gm"]],
  kg: ["mass", 1, ["kg", "kilogram", "kilo"]],
  quintal: ["mass", 100, ["quintal"]],
  tonne: ["mass", 1000, ["tonne", "ton", "metricton"]],
  lb: ["mass", 0.45359237, ["lb", "lbs", "pound"]],
  oz: ["mass", 0.028349523125, ["oz", "ounce"]],
  ml: ["volume", 0.001, ["ml", "milliliter", "millilitre"]],
  l: ["volume", 1, ["l", "liter", "litre", "ltr"]],
  gal: ["volume", 3.785411784, ["gal", "gallon"]],
  qt: ["volume", 0.946352946, ["qt", "quart"]],
  cup: ["volume", 0.2365882365, ["cup"]],
  floz: ["volume", 0.0295735295625, ["floz", "fluidounce"]],
  tbsp: ["volume", 0.01478676478125, ["tbsp", "tablespoon"]],
  tsp: ["volume", 0.00492892159375, ["tsp", "teaspoon"]],
  sqm: ["area", 1, ["sqm", "squaremeter", "squaremetre", "m2", "m²"]],
  sqft: ["area", 0.09290304, ["sqft", "squarefeet", "squarefoot", "ft2", "ft²"]],
  sqyd: ["area", 0.83612736, ["sqyd", "squareyard"]],
  sqkm: ["area", 1000000, ["sqkm", "squarekilometer", "squarekilometre", "km2", "km²"]],
  acre: ["area", 4046.8564224, ["acre"]],
  hectare: ["area", 10000, ["hectare", "ha"]],
  ms: ["speed", 1, ["m/s", "mps", "meterpersecond"]],
  kmh: ["speed", 1 / 3.6, ["km/h", "kmh", "kmph", "kph", "kilometerperhour"]],
  mph: ["speed", 0.44704, ["mph", "mileperhour"]],
  knot: ["speed", 1852 / 3600, ["knot", "kt"]],
  c: ["temp", 0, ["c", "°c", "celsius", "centigrade"]],
  f: ["temp", 0, ["f", "°f", "fahrenheit"]],
  k: ["temp", 0, ["k", "kelvin"]],
};
const ALIAS = {};
for (const [key, [, , names]] of Object.entries(UNITS)) for (const n of names) ALIAS[n] = key;

function resolve(words) {
  const parts = words.trim().toLowerCase().replace(/\./g, "").split(/\s+/);
  for (let n = Math.min(3, parts.length); n >= 1; n--) {
    const k = parts.slice(0, n).join("");
    if (ALIAS[k]) return ALIAS[k];
    if (ALIAS[k.replace(/s$/, "")]) return ALIAS[k.replace(/s$/, "")];
  }
  return null;
}

const toCelsius = (v, u) => (u === "c" ? v : u === "f" ? ((v - 32) * 5) / 9 : v - 273.15);
const fromCelsius = (v, u) => (u === "c" ? v : u === "f" ? (v * 9) / 5 + 32 : v + 273.15);
const fmt = (n) => Number(n.toPrecision(8));

export async function run(input = {}) {
  const text = String(input?.prompt ?? input?.text ?? "").toLowerCase();
  const m =
    /(-?\d+(?:\.\d+)?)\s*([a-z°²/]+(?:\s[a-z°²/]+){0,2}?)\s+(?:to|in|into|se|mein)\s+([a-z°²/]+(?:\s[a-z°²/]+){0,2})/.exec(
      text,
    );
  const value = input.value != null ? Number(input.value) : m ? Number(m[1]) : NaN;
  const from = input.from ? resolve(String(input.from)) : m ? resolve(m[2]) : null;
  const to = input.to ? resolve(String(input.to)) : m ? resolve(m[3]) : null;
  if (!Number.isFinite(value) || !from || !to) {
    return { ok: false, error: "Say it like 5 km to miles, 70 kg to lb or 100 f to c." };
  }
  const [dimA, fa] = UNITS[from];
  const [dimB, fb] = UNITS[to];
  if (dimA !== dimB) return { ok: false, error: `Cannot convert ${dimA} to ${dimB}.` };
  const result = dimA === "temp" ? fromCelsius(toCelsius(value, from), to) : (value * fa) / fb;
  const out = fmt(result);
  return {
    ok: true,
    dimension: dimA,
    from,
    to,
    value,
    result: out,
    answer: `${value} ${from} = ${out} ${to}.`,
  };
}

export default run;
