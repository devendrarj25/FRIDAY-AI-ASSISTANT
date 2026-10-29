async function run({ text, limit = 40 } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const cap = Math.min(200, Math.max(1, Number(limit) || 40));
  const counts = new Map();
  for (const word of String(text)
    .toLowerCase()
    .match(/[a-z0-9']{2,}/g) || []) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([word, count]) => ({ word, count }));
  return { ok: true, unique: counts.size, ranked };
}
module.exports = { run };
