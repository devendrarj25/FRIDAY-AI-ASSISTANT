async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const raw = String(text).match(/-?\d+(?:\.\d+)?/g) || [];
  const values = raw.map(Number).filter((n) => Number.isFinite(n));
  return { ok: true, count: values.length, values: values.slice(0, 400) };
}
module.exports = { run };
