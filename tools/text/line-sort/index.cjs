async function run({ text, unique = false } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  let lines = String(text).split(/\r?\n/);
  lines.sort((a, b) => a.localeCompare(b));
  if (unique) lines = [...new Set(lines)];
  return { ok: true, text: lines.join("\n"), count: lines.length };
}
module.exports = { run };
