async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const lines = String(text).split(/\r?\n/);
  return { ok: true, lines, count: lines.length };
}
module.exports = { run };
