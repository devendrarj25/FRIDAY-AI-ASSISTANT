async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const found = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const unique = [...new Set(found.map((item) => item.toLowerCase()))];
  return { ok: true, count: unique.length, emails: unique.slice(0, 200) };
}
module.exports = { run };
