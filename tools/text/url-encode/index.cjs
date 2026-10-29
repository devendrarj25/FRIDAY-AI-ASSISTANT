async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  return { ok: true, text: encodeURIComponent(String(text)) };
}
module.exports = { run };
