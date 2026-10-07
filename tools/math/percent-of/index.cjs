async function run({ part, whole } = {}) {
  const a = Number(part);
  const b = Number(whole);
  if (!Number.isFinite(a) || !Number.isFinite(b))
    return { ok: false, error: "Need part and whole." };
  if (b === 0) return { ok: false, error: "Whole cannot be zero." };
  return { ok: true, percent: (a / b) * 100 };
}
module.exports = { run };
