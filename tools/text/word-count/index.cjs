async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const src = String(text);
  const lines = src.split(/\r?\n/);
  const words = src.trim() ? src.trim().split(/\s+/) : [];
  return { ok: true, chars: src.length, words: words.length, lines: lines.length };
}
module.exports = { run };
