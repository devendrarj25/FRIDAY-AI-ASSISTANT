async function run({ value, places = 0 } = {}) {
  const n = Number(value);
  const p = Math.min(12, Math.max(0, Number(places) || 0));
  if (!Number.isFinite(n)) return { ok: false, error: "A number is required." };
  const factor = 10 ** p;
  const rounded = Math.round(n * factor) / factor;
  return { ok: true, value: rounded, text: n.toFixed(p) };
}
module.exports = { run };
