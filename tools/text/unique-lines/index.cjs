async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const lines = [...new Set(String(text).split(/\r?\n/))];
  return { ok: true, text: lines.join("\n"), count: lines.length };
}
module.exports = { run };
