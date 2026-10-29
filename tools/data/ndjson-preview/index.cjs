async function run({ text, limit = 20 } = {}) {
  if (text == null || text === "") return { ok: false, error: "NDJSON text is required." };
  const cap = Math.min(100, Math.max(1, Number(limit) || 20));
  const rows = [];
  const errors = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      errors.push(String(error.message || error));
    }
    if (rows.length >= cap) break;
  }
  return { ok: true, count: rows.length, rows, errors: errors.slice(0, 5) };
}
module.exports = { run };
