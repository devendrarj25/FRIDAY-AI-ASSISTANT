async function run({ value, min = 0, max = 1 } = {}) {
  const n = Number(value);
  const lo = Number(min);
  const hi = Number(max);
  if (![n, lo, hi].every(Number.isFinite))
    return { ok: false, error: "Need numeric value, min, and max." };
  if (hi < lo) return { ok: false, error: "max must be >= min." };
  return { ok: true, value: Math.min(hi, Math.max(lo, n)) };
}
module.exports = { run };
