async function run({ text, days = 1 } = {}) {
  const base = text ? Date.parse(String(text)) : Date.now();
  if (!Number.isFinite(base)) return { ok: false, error: "Need a start date." };
  const shift = Number(days);
  if (!Number.isFinite(shift)) return { ok: false, error: "Need a day count." };
  const ms = base + shift * 86400000;
  return { ok: true, ms, iso: new Date(ms).toISOString(), days: shift };
}
module.exports = { run };
