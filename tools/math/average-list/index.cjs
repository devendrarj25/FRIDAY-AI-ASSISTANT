function nums(text) {
  if (Array.isArray(text)) return text.map(Number);
  const src = String(text || "").trim();
  if (src.startsWith("[")) {
    try {
      return JSON.parse(src).map(Number);
    } catch {
      /* fall through */
    }
  }
  return (src.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}
async function run({ text } = {}) {
  if (text == null || text === "") return { ok: false, error: "Numbers are required." };
  const values = nums(text).filter((n) => Number.isFinite(n));
  if (!values.length) return { ok: false, error: "No numbers found." };
  const sum = values.reduce((a, b) => a + b, 0);
  return { ok: true, count: values.length, average: sum / values.length };
}
module.exports = { run };
